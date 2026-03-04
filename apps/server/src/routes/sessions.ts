import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type {
  ApiError,
  ApiSuccess,
  PaginationParams,
  Session,
  SessionListResponse,
  SessionMessage,
  ToolCall,
  SessionDetailResponse,
  Todo,
  McpTool,
} from '@conduit/shared';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { promptBus } from './prompts.js';
import { normalizeTs } from '../lib/db-helpers.js';
import { sendMessage, sendCommand } from '../services/opencode.js';
import { validateUrlNotPrivate } from '../services/url-validation.js';
import { apiReadRateLimit, apiWriteRateLimit } from '../middleware/rateLimit.js';
import { pricingService } from '../services/pricing.js';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  archived: z.coerce.boolean().optional(),
});

const sessionDetailSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

// ── Helper: parse payload JSON safely ──────────────────────────────────────
function tryParse(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Helper: derive session status from the most recent status-changing event ──
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

function deriveSessionStatus(
  lastStatusEvent: string | null,
  lastSeen: string,
  lastStatusAt: string | null,
): Session['status'] {
  // Check the most recent status-changing event
  if (lastStatusEvent === 'session.error') return 'error';
  if (lastStatusEvent === 'Stop') return 'completed';
  if (lastStatusEvent === 'session.compacting') return 'compacting';

  // Compaction just finished — treat as idle (agent is waiting for user input)
  if (lastStatusEvent === 'session.compacted') return 'idle';

  // For idle: only trust it if no newer activity has occurred since
  if (lastStatusEvent === 'session.idle' && lastStatusAt) {
    const statusTime = new Date(normalizeTs(lastStatusAt)).getTime();
    const activityTime = new Date(normalizeTs(lastSeen)).getTime();
    // If there's been activity after the idle event, fall through to recency check
    if (activityTime <= statusTime) return 'idle';
  }

  // Fall back to recency-based heuristic
  const elapsed = Date.now() - new Date(normalizeTs(lastSeen)).getTime();
  if (elapsed <= ACTIVE_THRESHOLD_MS) return 'active';
  return 'idle';
}

/**
 * Derive sessions from hook_events.
 * - Filters out subagent sessions (those with parentID in session.created/updated payload.info).
 * - Extracts title from the most recent session event's payload.info.title.
 * - Counts unique message IDs from message.updated events.
 * - Aggregates token/cost data from message.updated events.
 */
function getSessionsFromEvents(
  fastify: FastifyInstance,
  page: number,
  limit: number,
  userId?: string,
  archived?: boolean,
): SessionListResponse {
  const offset = (page - 1) * limit;

  // ── Phase 1: Get paginated session IDs at SQL level ─────────────────────
  // Uses json_extract to filter subagent sessions in SQL instead of fetching
  // all sessions and filtering in JS. This makes pagination O(page_size)
  // instead of O(total_sessions).

  // User instance scoping — only show sessions from instances owned by this user
  const userInstFilter = userId
    ? `AND h.instance_id IN (SELECT id FROM instances WHERE user_id = ?)`
    : '';
  const userInstParams = userId ? [userId] : [];

  // instance_id subselect — only injected when userId is present (same guard as userInstFilter)
  const instanceIdSubselect = userId
    ? `(SELECT h2.instance_id FROM hook_events h2
        WHERE h2.session_id = h.session_id
          AND h2.instance_id IN (SELECT id FROM instances WHERE user_id = ?)
        LIMIT 1) as instance_id`
    : `NULL as instance_id`;
  const instanceIdParams = userId ? [userId] : [];

  // When archived=true, only return sessions that ARE in the archived list.
  // When archived=false/undefined, exclude archived sessions.
  let archiveFilter: string;
  const archiveParams: string[] = [];
  if (archived) {
    if (!userId) {
      return { sessions: [], total: 0 };
    }
    archiveFilter = `AND h.session_id IN (SELECT session_id FROM archived_sessions WHERE user_id = ?)`;
    archiveParams.push(userId);
  } else if (userId) {
    archiveFilter = `AND h.session_id NOT IN (SELECT session_id FROM archived_sessions WHERE user_id = ?)`;
    archiveParams.push(userId);
  } else {
    archiveFilter = '';
  }

  // Subagent exclusion: OpenCode sessions with parentID, or Claude Code SessionStart with parent_session_id
  const subagentExclusion = `AND h.session_id NOT IN (
    SELECT se.session_id FROM hook_events se
    WHERE se.event_type IN ('session.created', 'session.updated')
      AND se.session_id IS NOT NULL
      AND (json_extract(se.payload, '$.info.parentID') IS NOT NULL
        OR json_extract(se.payload, '$.parentID') IS NOT NULL)
    UNION
    SELECT se.session_id FROM hook_events se
    WHERE se.event_type = 'SessionStart'
      AND se.session_id IS NOT NULL
      AND json_extract(se.payload, '$.parent_session_id') IS NOT NULL
  )`;

  // Count total top-level sessions (for pagination metadata)
  const countRow = fastify.db
    .query(
      `SELECT COUNT(DISTINCT h.session_id) as total
       FROM hook_events h
       WHERE h.session_id IS NOT NULL
         AND h.session_id NOT IN ('conduit-config', 'conduit-models', 'unknown')
         ${userInstFilter}
         ${subagentExclusion}
         ${archiveFilter}`,
    )
    .get(...userInstParams, ...archiveParams) as { total: number };

  const total = countRow.total;

  // Get paginated session IDs with basic metadata
  type SessionSummaryRow = {
    session_id: string;
    first_seen: string;
    last_seen: string;
    last_status_event: string | null;
    last_status_at: string | null;
    instance_type: string | null;
    instance_id: string | null;
  };

  const summaryRows = fastify.db
    .query(
      `SELECT
         h.session_id,
         MIN(h.received_at) as first_seen,
         MAX(h.received_at) as last_seen,
         (SELECT s.event_type FROM hook_events s
          WHERE s.session_id = h.session_id
                AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacting', 'session.compacted')
              ORDER BY s.received_at DESC LIMIT 1) as last_status_event,
         (SELECT s.received_at FROM hook_events s
          WHERE s.session_id = h.session_id
                AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacting', 'session.compacted')
              ORDER BY s.received_at DESC LIMIT 1) as last_status_at,
         (SELECT i.type FROM instances i WHERE i.id = h.instance_id LIMIT 1) as instance_type,
         ${instanceIdSubselect}
       FROM hook_events h
       WHERE h.session_id IS NOT NULL
         AND h.session_id NOT IN ('conduit-config', 'conduit-models', 'unknown')
         ${userInstFilter}
         ${subagentExclusion}
         ${archiveFilter}
       GROUP BY h.session_id
       ORDER BY last_seen DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...userInstParams, ...archiveParams, ...instanceIdParams, limit, offset) as SessionSummaryRow[];

  if (summaryRows.length === 0) {
    return { sessions: [], total };
  }

  // ── Phase 2: Fetch details only for this page's sessions ────────────────
  const sessionIds = summaryRows.map(r => r.session_id);
  const placeholders = sessionIds.map(() => '?').join(',');

  // Fetch titles from session.created/session.updated payloads
  type TitleRow = { session_id: string; payload: string };
  const titleRows = fastify.db
    .query(
      `SELECT session_id, payload
       FROM hook_events
       WHERE session_id IN (${placeholders})
         AND event_type IN ('session.created', 'session.updated')
       ORDER BY received_at DESC`,
    )
    .all(...sessionIds) as TitleRow[];

  const sessionTitles = new Map<string, string>();
  for (const row of titleRows) {
    if (sessionTitles.has(row.session_id)) continue; // first (most recent) wins
    const p = tryParse(row.payload);
    if (!p) continue;
    const info = p.info as Record<string, unknown> | undefined;
    const title = (info?.title ?? p.title) as string | undefined;
    if (typeof title === 'string' && title) {
      sessionTitles.set(row.session_id, title);
    }
  }

  // Fallback titles for Claude Code sessions — use first UserPromptSubmit prompt
  const noTitleIds = sessionIds.filter(sid => !sessionTitles.has(sid));
  if (noTitleIds.length > 0) {
    const ph2 = noTitleIds.map(() => '?').join(',');
    const promptRows = fastify.db
      .query(
        `SELECT session_id, payload FROM hook_events
         WHERE session_id IN (${ph2}) AND event_type = 'UserPromptSubmit'
         ORDER BY received_at ASC`,
      )
      .all(...noTitleIds) as TitleRow[];
    for (const row of promptRows) {
      if (sessionTitles.has(row.session_id)) continue; // first prompt wins
      const p = tryParse(row.payload);
      const prompt = typeof p?.prompt === 'string' ? p.prompt.trim() : '';
      if (prompt) {
        sessionTitles.set(row.session_id, prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt);
      }
    }
  }

  // Fetch message.updated payloads for cost/token aggregation
  type MsgRow = { session_id: string; payload: string };
  const msgRows = fastify.db
    .query(
      `SELECT session_id, payload
       FROM hook_events
       WHERE session_id IN (${placeholders})
         AND event_type = 'message.updated'
       ORDER BY received_at ASC`,
    )
    .all(...sessionIds) as MsgRow[];

  // Group message data per session
  interface PerMsgCost {
    cost: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  }
  interface SessionMsgData {
    uniqueMsgIds: Set<string>;
    unknownMsgCount: number;
    perMsgCost: Map<string, PerMsgCost>;
    lastModelID?: string;
    lastProviderID?: string;
  }
  const sessionMsgData = new Map<string, SessionMsgData>();

  for (const row of msgRows) {
    let data = sessionMsgData.get(row.session_id);
    if (!data) {
      data = { uniqueMsgIds: new Set(), unknownMsgCount: 0, perMsgCost: new Map() };
      sessionMsgData.set(row.session_id, data);
    }

    const p = tryParse(row.payload);
    if (!p) continue;
    const info = p.info as Record<string, unknown> | undefined;
    const msgId = (info?.id ?? p.id) as string | undefined;
    if (typeof msgId === 'string') {
      data.uniqueMsgIds.add(msgId);
    } else {
      data.unknownMsgCount++;
    }

    // Cost/token aggregation — last event per message wins
    if (info && info.role === 'assistant' && typeof msgId === 'string') {
      const tokens = info.tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
      const modelID = typeof info.modelID === 'string' ? info.modelID : '';
      const providerID = typeof info.providerID === 'string' ? info.providerID : '';
      const cost = pricingService.computeCostSync(modelID, providerID, {
        input: typeof tokens?.input === 'number' ? tokens.input : 0,
        output: typeof tokens?.output === 'number' ? tokens.output : 0,
        reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
        cache: { read: tokens?.cache?.read, write: tokens?.cache?.write },
      });
      data.perMsgCost.set(msgId, {
        cost,
        input: typeof tokens?.input === 'number' ? tokens.input : 0,
        output: typeof tokens?.output === 'number' ? tokens.output : 0,
        reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
        cacheRead: typeof tokens?.cache?.read === 'number' ? tokens.cache.read : 0,
        cacheWrite: typeof tokens?.cache?.write === 'number' ? tokens.cache.write : 0,
      });
      if (modelID) data.lastModelID = modelID;
      if (providerID) data.lastProviderID = providerID;
    }
  }

  // ── Fallback: extract model from Claude Code hook events for sessions missing a model ─
  // Check Stop.usage.model first (most accurate), then SessionStart.model.
  const noModelIds = sessionIds.filter(sid => !sessionMsgData.get(sid)?.lastModelID);
  if (noModelIds.length > 0) {
    const ph = noModelIds.map(() => '?').join(',');

    // 1. Try Stop events (usage.model)
    const stopRows = fastify.db
      .query(
        `SELECT session_id, payload FROM hook_events
         WHERE session_id IN (${ph}) AND event_type = 'Stop'
         ORDER BY received_at DESC`,
      )
      .all(...noModelIds) as Array<{ session_id: string; payload: string }>;

    const seenStop = new Set<string>();
    for (const r of stopRows) {
      if (seenStop.has(r.session_id)) continue;
      seenStop.add(r.session_id);
      const p = tryParse(r.payload);
      const usage = p?.usage as Record<string, unknown> | undefined;
      const m = typeof usage?.model === 'string' ? usage.model
        : typeof p?.model === 'string' ? p.model : null;
      if (m) {
        let data = sessionMsgData.get(r.session_id);
        if (!data) {
          data = { uniqueMsgIds: new Set(), unknownMsgCount: 0, perMsgCost: new Map() };
          sessionMsgData.set(r.session_id, data);
        }
        data.lastModelID = m;
      }
    }

    // 2. Fall back to SessionStart.model for sessions still missing model
    const stillNoModel = noModelIds.filter(sid => !sessionMsgData.get(sid)?.lastModelID);
    if (stillNoModel.length > 0) {
      const ph2 = stillNoModel.map(() => '?').join(',');
      const ssRows = fastify.db
        .query(
          `SELECT session_id, payload FROM hook_events
           WHERE session_id IN (${ph2}) AND event_type = 'SessionStart'
           ORDER BY received_at DESC`,
        )
        .all(...stillNoModel) as Array<{ session_id: string; payload: string }>;

      const seenSS = new Set<string>();
      for (const r of ssRows) {
        if (seenSS.has(r.session_id)) continue;
        seenSS.add(r.session_id);
        const p = tryParse(r.payload);
        const m = typeof p?.model === 'string' ? p.model : null;
        if (m) {
          let data = sessionMsgData.get(r.session_id);
          if (!data) {
            data = { uniqueMsgIds: new Set(), unknownMsgCount: 0, perMsgCost: new Map() };
            sessionMsgData.set(r.session_id, data);
          }
          data.lastModelID = m;
        }
      }
    }
  }

  // ── Fallback: count UserPromptSubmit events for Claude Code sessions with no message.updated ──
  const noMsgSessions = sessionIds.filter(sid => {
    const data = sessionMsgData.get(sid);
    return !data || (data.uniqueMsgIds.size === 0 && data.unknownMsgCount === 0);
  });
  if (noMsgSessions.length > 0) {
    const ph = noMsgSessions.map(() => '?').join(',');
    const promptCounts = fastify.db
      .query(
        `SELECT session_id, COUNT(*) as count
         FROM hook_events
         WHERE session_id IN (${ph}) AND event_type = 'UserPromptSubmit'
         GROUP BY session_id`,
      )
      .all(...noMsgSessions) as Array<{ session_id: string; count: number }>;
    for (const r of promptCounts) {
      let data = sessionMsgData.get(r.session_id);
      if (!data) {
        data = { uniqueMsgIds: new Set(), unknownMsgCount: 0, perMsgCost: new Map() };
        sessionMsgData.set(r.session_id, data);
      }
      data.unknownMsgCount = r.count;
    }
  }

  // ── Build session objects ───────────────────────────────────────────────
  const sessions: Session[] = summaryRows.map(row => {
    const md = sessionMsgData.get(row.session_id);
    const msgCount = md ? md.uniqueMsgIds.size + md.unknownMsgCount : 0;

    const tokenAgg = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let totalCost = 0;
    if (md) {
      for (const mc of md.perMsgCost.values()) {
        totalCost += mc.cost;
        tokenAgg.input += mc.input;
        tokenAgg.output += mc.output;
        tokenAgg.reasoning += mc.reasoning;
        tokenAgg.cacheRead += mc.cacheRead;
        tokenAgg.cacheWrite += mc.cacheWrite;
      }
    }

    const hasTokenData = tokenAgg.input > 0 || tokenAgg.output > 0;

    return {
      id: row.session_id,
      title: sessionTitles.get(row.session_id) ?? null,
      status: deriveSessionStatus(row.last_status_event, row.last_seen, row.last_status_at),
      createdAt: normalizeTs(row.first_seen),
      updatedAt: normalizeTs(row.last_seen),
      messageCount: msgCount,
      tokens: hasTokenData ? {
        ...tokenAgg,
        total: tokenAgg.input + tokenAgg.output + tokenAgg.reasoning,
      } : undefined,
      cost: (totalCost > 0 || md?.lastModelID) ? {
        totalCost,
        modelID: md?.lastModelID,
        providerID: md?.lastProviderID,
      } : undefined,
      instanceType: (row.instance_type === 'opencode' || row.instance_type === 'claude-code')
        ? row.instance_type
        : undefined,
      instanceId: row.instance_id ?? undefined,
    };
  });

  return { sessions, total };
}

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', requireAuth);

  // GET /sessions
  fastify.get<{ Querystring: PaginationParams }>(
    '/',
    { config: { rateLimit: apiReadRateLimit } },
    async (request, reply) => {
      const parsed = paginationSchema.safeParse(request.query);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'Invalid pagination parameters',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const userId = request.user!.id;
      const result = getSessionsFromEvents(fastify, parsed.data.page, parsed.data.limit, userId, parsed.data.archived);
      const response: ApiSuccess<SessionListResponse> = {
        data: result,
        meta: {
          page: parsed.data.page,
          limit: parsed.data.limit,
          total: result.total,
        },
      };
      return reply.code(200).send(response);
    },
  );

  // GET /sessions/:id
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/:id',
    { config: { rateLimit: apiReadRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      // Parse pagination params
      const detailParsed = sessionDetailSchema.safeParse(request.query);
      if (!detailParsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'Invalid pagination parameters',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }
      const { limit: msgLimit, before: beforeCursor } = detailParsed.data;

      // ── Session metadata ─────────────────────────────────────────────────
      const row = fastify.db
        .query(
          `SELECT
             h.session_id,
             MIN(h.received_at) as first_seen,
             MAX(h.received_at) as last_seen,
             (SELECT s.event_type FROM hook_events s
              WHERE s.session_id = h.session_id
                AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacting', 'session.compacted')
              ORDER BY s.received_at DESC LIMIT 1) as last_status_event,
             (SELECT s.received_at FROM hook_events s
              WHERE s.session_id = h.session_id
                AND s.event_type IN ('Stop', 'session.idle', 'session.error', 'session.compacting', 'session.compacted')
              ORDER BY s.received_at DESC LIMIT 1) as last_status_at,
             GROUP_CONCAT(CASE WHEN h.event_type IN ('session.created','session.updated') THEN h.payload ELSE NULL END, '|||') as session_payloads,
             i.type as instance_type,
             (SELECT h2.instance_id FROM hook_events h2
              WHERE h2.session_id = h.session_id
                AND h2.instance_id IN (SELECT id FROM instances WHERE user_id = ?)
              LIMIT 1) as instance_id
           FROM hook_events h
           LEFT JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id = ?
             AND h.instance_id IN (SELECT id FROM instances WHERE user_id = ?)
           GROUP BY h.session_id`,
        )
        .get(userId, id, userId) as {
        session_id: string;
        first_seen: string;
        last_seen: string;
        last_status_event: string | null;
        last_status_at: string | null;
        session_payloads: string | null;
        instance_type: string | null;
        instance_id: string | null;
      } | undefined;

      if (!row) {
        const error: ApiError = { error: 'Not Found', message: 'Session not found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      // Extract title — OpenCode uses session.created/session.updated
      let title: string | null = null;
      if (row.session_payloads) {
        const payloads = row.session_payloads.split('|||');
        for (let i = payloads.length - 1; i >= 0; i--) {
          const p = tryParse(payloads[i]);
          if (!p) continue;
          const info = p.info as Record<string, unknown> | undefined;
          if (info && typeof info.title === 'string' && info.title) { title = info.title; break; }
          if (typeof p.title === 'string' && p.title) { title = p.title; break; }
        }
      }
      // Fallback — Claude Code: use the first UserPromptSubmit prompt
      if (!title) {
        const promptRow = fastify.db
          .query(
            `SELECT payload FROM hook_events
             WHERE session_id = ? AND event_type = 'UserPromptSubmit'
             ORDER BY received_at ASC LIMIT 1`,
          )
          .get(id) as { payload: string } | undefined;
        if (promptRow) {
          const p = tryParse(promptRow.payload);
          const prompt = typeof p?.prompt === 'string' ? p.prompt.trim() : '';
          if (prompt) title = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
        }
      }

      // ── Scan message.updated events (single query for cost + ordering) ──
      // We scan all message.updated events to:
      // 1) Aggregate cost/tokens across the full session (last event per msg wins)
      // 2) Build ordered unique message ID list for pagination
      // 3) Collect role/timestamp metadata for message assembly
      interface MsgCost {
        cost: number;
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
      }
      const perMsgCost = new Map<string, MsgCost>();
      let lastModelID: string | undefined;
      let lastProviderID: string | undefined;
      const msgMeta = new Map<string, { role: 'user' | 'assistant'; receivedAt: string; modelID?: string }>();
      const msgOrder: string[] = [];

      const msgEvents = fastify.db
        .query(
          `SELECT payload, received_at
           FROM hook_events
           WHERE session_id = ? AND event_type = 'message.updated'
           ORDER BY received_at ASC`,
        )
        .all(id) as Array<{ payload: string; received_at: string }>;

      for (const ev of msgEvents) {
        const p = tryParse(ev.payload);
        if (!p) continue;
        const info = (p.info ?? p) as Record<string, unknown>;
        const msgId = typeof info.id === 'string' ? info.id : typeof info.messageID === 'string' ? info.messageID : null;
        if (!msgId) continue;
        const role = info.role === 'user' ? 'user' as const : 'assistant' as const;

        // Track ordered unique message IDs and metadata
        if (!msgMeta.has(msgId)) {
          msgOrder.push(msgId);
        }
        msgMeta.set(msgId, { role, receivedAt: ev.received_at, modelID: typeof info.modelID === 'string' ? info.modelID : undefined });

        // Extract cost/tokens from assistant messages — last event per message wins
        if (role === 'assistant') {
          const tokens = info.tokens as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined;
          const modelID = typeof info.modelID === 'string' ? info.modelID : '';
          const providerID = typeof info.providerID === 'string' ? info.providerID : '';
          const cost = pricingService.computeCostSync(modelID, providerID, {
            input: typeof tokens?.input === 'number' ? tokens.input : 0,
            output: typeof tokens?.output === 'number' ? tokens.output : 0,
            reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
            cache: { read: tokens?.cache?.read, write: tokens?.cache?.write },
          });
          perMsgCost.set(msgId, {
            cost,
            input: typeof tokens?.input === 'number' ? tokens.input : 0,
            output: typeof tokens?.output === 'number' ? tokens.output : 0,
            reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
            cacheRead: typeof tokens?.cache?.read === 'number' ? tokens.cache.read : 0,
            cacheWrite: typeof tokens?.cache?.write === 'number' ? tokens.cache.write : 0,
          });
          if (modelID) lastModelID = modelID;
          if (providerID) lastProviderID = providerID;
        }
      }

      // ── Pre-filter msgOrder: keep only messages with displayable content ──
      // The message builder deduplicates part events by partId, keeping only the
      // LATEST event (highest rowid) per part.  A message is displayable only if
      // its latest-event-per-part set contains at least one tool-type part OR one
      // text-type part with non-empty trimmed text.  We replicate this dedup in
      // the SQL via MAX(rowid) per (messageId, partId) so the filter matches the
      // builder's behavior exactly.
      if (msgOrder.length > 0) {
        const phAll = msgOrder.map(() => '?').join(',');
        const idsWithContent = new Set(
          (fastify.db
            .query(
              `SELECT DISTINCT mid FROM (
                 SELECT
                   COALESCE(json_extract(payload, '$.part.messageID'), json_extract(payload, '$.messageID')) AS mid,
                   COALESCE(json_extract(payload, '$.part.id'), rowid) AS pid,
                   COALESCE(json_extract(payload, '$.part.type'), json_extract(payload, '$.type')) AS ptype,
                   TRIM(COALESCE(json_extract(payload, '$.part.text'), json_extract(payload, '$.text'), '')) AS ptext,
                   ROW_NUMBER() OVER (
                     PARTITION BY
                       COALESCE(json_extract(payload, '$.part.messageID'), json_extract(payload, '$.messageID')),
                       COALESCE(json_extract(payload, '$.part.id'), rowid)
                     ORDER BY rowid DESC
                   ) AS rn
                 FROM hook_events
                 WHERE session_id = ? AND event_type = 'message.part.updated'
                   AND COALESCE(json_extract(payload, '$.part.messageID'), json_extract(payload, '$.messageID')) IN (${phAll})
               ) AS latest
               WHERE rn = 1 AND (ptype = 'tool' OR ptext <> '')`,
            )
            .all(id, ...msgOrder) as Array<{ mid: string }>)
            .map(r => r.mid),
        );
        // Remove messages with no displayable content (in-place filter)
        let writeIdx = 0;
        for (let readIdx = 0; readIdx < msgOrder.length; readIdx++) {
          if (idsWithContent.has(msgOrder[readIdx]!)) {
            msgOrder[writeIdx++] = msgOrder[readIdx]!;
          }
        }
        msgOrder.length = writeIdx;
      }

      // Aggregate final cost/tokens across unique messages
      const tokenAgg = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      let totalCost = 0;
      for (const mc of perMsgCost.values()) {
        totalCost += mc.cost;
        tokenAgg.input += mc.input;
        tokenAgg.output += mc.output;
        tokenAgg.reasoning += mc.reasoning;
        tokenAgg.cacheRead += mc.cacheRead;
        tokenAgg.cacheWrite += mc.cacheWrite;
      }

      // ── Check for legacy Claude Code events ────────────────────────────
      // If no OpenCode-style messages exist, fall back to legacy events.
      let isLegacy = false;
      let legacyMessages: SessionMessage[] = [];
      if (msgOrder.length === 0) {
        isLegacy = true;
        const legacyEvents = fastify.db
          .query(
            `SELECT id, event_type, payload, received_at
             FROM hook_events
             WHERE session_id = ?
               AND event_type NOT IN ('session.created','session.updated','session.idle','session.error','message.updated','message.part.updated','config.sync','models.sync','todo.updated','mcp.tools.changed')
             ORDER BY received_at ASC`,
          )
          .all(id) as Array<{ id: number; event_type: string; payload: string; received_at: string }>;

        // Collect tool calls per-turn so we can group PreToolUse+PostToolUse
        // into a single assistant message with toolCalls, matching the OpenCode path.
        // A "turn" ends on each UserPromptSubmit or Stop event.
        // We buffer PostToolUse events and flush them when a new user prompt or Stop arrives.
        interface PendingToolCall {
          id: string;
          name: string;
          input: Record<string, unknown>;
          output: string | undefined;
          status: ToolCall['status'];
          receivedAt: string;
        }
        const pendingToolCalls: PendingToolCall[] = [];

        /** Extract human-readable text from a Claude Code tool_response value.
         *  tool_response may be a plain string, a content-block array
         *  ([{type:"text",text:"..."}]), or an object. */
        function extractToolResponseText(resp: unknown): string {
          if (typeof resp === 'string') return resp;
          if (Array.isArray(resp)) {
            return resp
              .map((b: unknown) => {
                if (b && typeof b === 'object' && 'text' in b && typeof (b as Record<string, unknown>).text === 'string') {
                  return (b as Record<string, unknown>).text as string;
                }
                return '';
              })
              .filter(Boolean)
              .join('\n');
          }
          if (resp !== null && resp !== undefined) return JSON.stringify(resp, null, 2);
          return '';
        }

        /** Flush buffered tool calls as a single assistant message. */
        function flushToolCalls(receivedAt: string): void {
          if (pendingToolCalls.length === 0) return;
          const toolCalls: ToolCall[] = pendingToolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
            output: tc.output,
            status: tc.status,
          }));
          // Use the ID of the first tool call event so it's stable
          legacyMessages.push({
            id: `tools-${pendingToolCalls[0]!.id}`,
            sessionId: id,
            role: 'assistant',
            author: 'Claude Code',
            content: '',
            toolCalls,
            createdAt: normalizeTs(receivedAt),
          });
          pendingToolCalls.length = 0;
        }

        for (const ev of legacyEvents) {
          const p = tryParse(ev.payload);

          if (ev.event_type === 'UserPromptSubmit') {
            // Flush any buffered tool calls before the next user turn
            flushToolCalls(ev.received_at);
            const content = typeof p?.prompt === 'string' ? p.prompt : '';
            if (!content) continue;
            legacyMessages.push({
              id: String(ev.id),
              sessionId: id,
              role: 'user',
              author: 'User',
              content,
              createdAt: normalizeTs(ev.received_at),
            });
          } else if (ev.event_type === 'PreToolUse') {
            // Buffer tool call start — will be merged with PostToolUse
            const toolName = typeof p?.tool_name === 'string' ? p.tool_name : 'tool';
            const inp = p?.tool_input;
            const input: Record<string, unknown> = (inp && typeof inp === 'object' && !Array.isArray(inp))
              ? (inp as Record<string, unknown>)
              : {};
            pendingToolCalls.push({
              id: String(ev.id),
              name: toolName,
              input,
              output: undefined,
              status: 'running',
              receivedAt: ev.received_at,
            });
          } else if (ev.event_type === 'PostToolUse') {
            // Find matching PreToolUse by tool name and update with output
            const toolName = typeof p?.tool_name === 'string' ? p.tool_name : 'tool';
            const output = extractToolResponseText(p?.tool_response);
            // Match last pending call with the same tool name
            const matchIdx = pendingToolCalls.findLastIndex((tc: PendingToolCall) => tc.name === toolName && tc.status === 'running');
            if (matchIdx !== -1) {
              pendingToolCalls[matchIdx]!.output = output || undefined;
              pendingToolCalls[matchIdx]!.status = 'completed';
            } else {
              // No matching PreToolUse — create a standalone completed tool call
              const inp = p?.tool_input;
              const input: Record<string, unknown> = (inp && typeof inp === 'object' && !Array.isArray(inp))
                ? (inp as Record<string, unknown>)
                : {};
              pendingToolCalls.push({
                id: String(ev.id),
                name: toolName,
                input,
                output: output || undefined,
                status: 'completed',
                receivedAt: ev.received_at,
              });
            }
          } else if (ev.event_type === 'Stop' || ev.event_type === 'SessionEnd') {
            // Flush any buffered tool calls before the stop message
            flushToolCalls(ev.received_at);
            // Claude Code Stop payload: stop_reason, usage, result (the assistant text).
            // Try several known field names for the final text.
            const msg = (
              typeof p?.result === 'string' ? p.result :
              typeof p?.message === 'string' ? p.message :
              typeof p?.text === 'string' ? p.text :
              ''
            ).trim();
            if (msg) {
              legacyMessages.push({
                id: String(ev.id),
                sessionId: id,
                role: 'assistant',
                author: 'Claude Code',
                content: msg,
                createdAt: normalizeTs(ev.received_at),
              });
            } else {
              // No text — emit a system divider so the turn boundary is visible
              const reason = typeof p?.stop_reason === 'string' ? p.stop_reason : 'end_turn';
              legacyMessages.push({
                id: String(ev.id),
                sessionId: id,
                role: 'system',
                author: 'System',
                content: `Session ended: ${reason}`,
                createdAt: normalizeTs(ev.received_at),
              });
            }
          } else {
            // Other events (SubagentStart, SubagentStop, TaskCompleted, etc.)
            const content = typeof p?.message === 'string' ? p.message
              : typeof p?.text === 'string' ? p.text : '';
            if (!content) continue;
            legacyMessages.push({
              id: String(ev.id),
              sessionId: id,
              role: 'assistant',
              author: 'Claude Code',
              content,
              createdAt: normalizeTs(ev.received_at),
            });
          }
        }
        // Flush any trailing tool calls at end of event stream
        if (pendingToolCalls.length > 0) {
          flushToolCalls(legacyEvents[legacyEvents.length - 1]?.received_at ?? new Date().toISOString());
        }
      }

      // ── Paginate message IDs at the array level ────────────────────────
      // For OpenCode sessions: paginate from the ordered msgOrder list
      // For legacy sessions: paginate from legacyMessages
      const totalMessages = isLegacy ? legacyMessages.length : msgOrder.length;
      let hasMore = false;
      let oldestMessageId: string | null = null;
      let paginatedMsgIds: string[];

      if (isLegacy) {
        // Legacy path — paginate the legacyMessages array directly
        if (totalMessages > 0) {
          if (beforeCursor) {
            const cursorIdx = legacyMessages.findIndex(m => m.id === beforeCursor);
            if (cursorIdx > 0) {
              const startIdx = Math.max(0, cursorIdx - msgLimit);
              legacyMessages = legacyMessages.slice(startIdx, cursorIdx);
              hasMore = startIdx > 0;
            } else {
              legacyMessages = [];
              hasMore = false;
            }
          } else {
            if (totalMessages > msgLimit) {
              legacyMessages = legacyMessages.slice(totalMessages - msgLimit);
              hasMore = true;
            }
          }
          oldestMessageId = legacyMessages.length > 0 ? legacyMessages[0]!.id : null;
        }
        paginatedMsgIds = [];
      } else {
        // OpenCode path — paginate from the msgOrder ID list
        if (totalMessages > 0) {
          if (beforeCursor) {
            const cursorIdx = msgOrder.indexOf(beforeCursor);
            if (cursorIdx > 0) {
              const startIdx = Math.max(0, cursorIdx - msgLimit);
              paginatedMsgIds = msgOrder.slice(startIdx, cursorIdx);
              hasMore = startIdx > 0;
            } else {
              paginatedMsgIds = [];
              hasMore = false;
            }
          } else {
            if (totalMessages > msgLimit) {
              paginatedMsgIds = msgOrder.slice(totalMessages - msgLimit);
              hasMore = true;
            } else {
              paginatedMsgIds = [...msgOrder];
            }
          }
          oldestMessageId = paginatedMsgIds.length > 0 ? paginatedMsgIds[0]! : null;
        } else {
          paginatedMsgIds = [];
        }
      }

      // ── Fetch TODOs (todo.updated events — last one wins) ──────────────
      const todoEvents = fastify.db
        .query(
          `SELECT payload
           FROM hook_events
           WHERE session_id = ? AND event_type = 'todo.updated'
           ORDER BY received_at DESC
           LIMIT 1`,
        )
        .all(id) as Array<{ payload: string }>;

      let todos: Todo[] | undefined;
      if (todoEvents.length > 0) {
        const p = tryParse(todoEvents[0]!.payload);
        if (p) {
          const rawTodos = (p.todos ?? p.items) as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(rawTodos)) {
            todos = rawTodos
              .filter(t => typeof t.content === 'string')
              .map(t => ({
                content: t.content as string,
                status: (['pending', 'in_progress', 'completed', 'cancelled'].includes(t.status as string) ? t.status : 'pending') as Todo['status'],
                priority: (['high', 'medium', 'low'].includes(t.priority as string) ? t.priority : 'medium') as Todo['priority'],
              }));
          }
        }
      }

      // ── Fetch MCP tools (mcp.tools.changed events) ────────────────────
      const mcpEvents = fastify.db
        .query(
          `SELECT payload
           FROM hook_events
           WHERE session_id = ? AND event_type = 'mcp.tools.changed'
           ORDER BY received_at DESC
           LIMIT 1`,
        )
        .all(id) as Array<{ payload: string }>;

      let mcpTools: McpTool[] | undefined;
      if (mcpEvents.length > 0) {
        const p = tryParse(mcpEvents[0]!.payload);
        if (p) {
          const server = typeof p.server === 'string' ? p.server : 'unknown';
          const rawTools = p.tools as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(rawTools)) {
            mcpTools = rawTools
              .filter(t => typeof t.name === 'string')
              .map(t => ({
                server,
                name: t.name as string,
              }));
          } else {
            // Single server notification without tool list
            mcpTools = [{ server, name: '(server connected)' }];
          }
        }
      }

      // ── Fetch message parts ONLY for paginated message IDs ─────────────
      // This is the key optimization: instead of fetching all parts for the
      // entire session, we only fetch parts for the messages we need to display.
      // We use json_extract to filter at the SQL level, avoiding loading
      // potentially thousands of part event payloads into memory.
      const partsByMsg = new Map<string, Array<{ type: string; data: Record<string, unknown>; receivedAt: string }>>();

      if (paginatedMsgIds.length > 0) {
        // Use SQL-level filtering with json_extract for messageID
        const placeholders = paginatedMsgIds.map(() => '?').join(',');
        const partEvents = fastify.db
          .query(
            `SELECT payload, received_at
             FROM hook_events
             WHERE session_id = ? AND event_type = 'message.part.updated'
               AND COALESCE(
                 json_extract(payload, '$.part.messageID'),
                 json_extract(payload, '$.messageID')
               ) IN (${placeholders})
             ORDER BY received_at ASC`,
          )
          .all(id, ...paginatedMsgIds) as Array<{ payload: string; received_at: string }>;

        const partMap = new Map<string, { messageId: string; type: string; data: Record<string, unknown>; receivedAt: string }>();

        for (const ev of partEvents) {
          const p = tryParse(ev.payload);
          if (!p) continue;
          const part = (p.part ?? p) as Record<string, unknown>;
          const partId = typeof part.id === 'string' ? part.id : null;
          const messageId = typeof part.messageID === 'string' ? part.messageID : null;
          const partType = typeof part.type === 'string' ? part.type : null;
          if (!partId || !messageId || !partType) continue;
          partMap.set(partId, { messageId, type: partType, data: part, receivedAt: ev.received_at });
        }

        for (const part of partMap.values()) {
          if (!partsByMsg.has(part.messageId)) {
            partsByMsg.set(part.messageId, []);
          }
          partsByMsg.get(part.messageId)!.push({ type: part.type, data: part.data, receivedAt: part.receivedAt });
        }
      }

      // ── Derive session status early so we can use it for tool-call inference ──
      const sessionStatus = deriveSessionStatus(row.last_status_event, row.last_seen, row.last_status_at);
      const sessionIsIdle = sessionStatus === 'idle' || sessionStatus === 'completed';

      // ── Build messages for the paginated page ──────────────────────────
      let messages: SessionMessage[] = [];

      if (isLegacy) {
        messages = legacyMessages;
      } else {
        for (const msgId of paginatedMsgIds) {
          const meta = msgMeta.get(msgId)!;
          const parts = partsByMsg.get(msgId) ?? [];

          const textParts: string[] = [];
          const toolCalls: ToolCall[] = [];

          for (const part of parts) {
            if (part.type === 'text') {
              const text = part.data.text;
              if (typeof text === 'string' && text.trim()) {
                textParts.push(text);
              }
            } else if (part.type === 'tool') {
              const state = part.data.state as Record<string, unknown> | undefined;
              const callId = typeof part.data.callID === 'string' ? part.data.callID : String(toolCalls.length);
              const toolName = typeof part.data.tool === 'string' ? part.data.tool : 'tool';

              let status: ToolCall['status'] = 'pending';
              let input: Record<string, unknown> = {};
              let output: string | undefined;

              if (state) {
                if (typeof state.status === 'string') {
                  status = state.status as ToolCall['status'];
                }
                if (state.input && typeof state.input === 'object') {
                  input = state.input as Record<string, unknown>;
                }
                if (typeof state.output === 'string') {
                  output = state.output;
                } else if (typeof state.raw === 'string') {
                  output = state.raw;
                }
              }

              // Infer completed status: OpenCode streams tool parts progressively
              // and the final event may keep status as 'running' even after output
              // is populated.  Two heuristics:
              //  1. Tool has output → it finished (unless explicitly errored)
              //  2. Session is idle/completed → all tools must be done
              if (status !== 'error' && status !== 'completed') {
                if (output || sessionIsIdle) {
                  status = 'completed';
                }
              }

              toolCalls.push({ id: callId, name: toolName, input, output, status });
            }
          }

          const content = textParts.join('\n');

          if (!content && toolCalls.length === 0) continue;

          const agentLabel = row.instance_type === 'claude-code' ? 'Claude Code' : 'OpenCode';
          messages.push({
            id: msgId,
            sessionId: id,
            role: meta.role,
            author: meta.role === 'user' ? 'User' : agentLabel,
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            createdAt: normalizeTs(meta.receivedAt),
            modelID: meta.modelID,
          });
        }
      }


      // ── Fallback: extract model from Claude Code hook events ──────────────
      // Claude Code puts model in SessionStart.model and Stop.usage.model.
      // We prefer Stop (most recent, may include version suffix) then SessionStart.
      if (!lastModelID && row.instance_type === 'claude-code') {
        const stopRow = fastify.db
          .query(
            `SELECT payload FROM hook_events
             WHERE session_id = ? AND event_type = 'Stop'
             ORDER BY received_at DESC LIMIT 1`,
          )
          .get(id) as { payload: string } | undefined;
        if (stopRow) {
          const p = tryParse(stopRow.payload);
          // Stop payload: usage.model or model at top level
          const usage = p?.usage as Record<string, unknown> | undefined;
          const m = typeof usage?.model === 'string' ? usage.model
            : typeof p?.model === 'string' ? p.model : null;
          if (m) lastModelID = m;
        }
      }
      if (!lastModelID) {
        const ssRow = fastify.db
          .query(
            `SELECT payload FROM hook_events
             WHERE session_id = ? AND event_type = 'SessionStart'
             ORDER BY received_at DESC LIMIT 1`,
          )
          .get(id) as { payload: string } | undefined;
        if (ssRow) {
          const p = tryParse(ssRow.payload);
          const m = typeof p?.model === 'string' ? p.model : null;
          if (m) lastModelID = m;
        }
      }

      const hasTokenData = tokenAgg.input > 0 || tokenAgg.output > 0;

      const session: Session = {
        id: row.session_id,
        title,
        status: sessionStatus,
        createdAt: normalizeTs(row.first_seen),
        updatedAt: normalizeTs(row.last_seen),
        messageCount: totalMessages,
        tokens: hasTokenData ? {
          ...tokenAgg,
          total: tokenAgg.input + tokenAgg.output + tokenAgg.reasoning,
        } : undefined,
        cost: (totalCost > 0 || lastModelID) ? {
          totalCost,
          modelID: lastModelID,
          providerID: lastProviderID,
        } : undefined,
        instanceType: (row.instance_type === 'opencode' || row.instance_type === 'claude-code')
          ? row.instance_type
          : undefined,
        instanceId: row.instance_id ?? undefined,
      };

      // Fetch prompts sent from the Conduit dashboard for this session so the
      // UI can show them as user message bubbles immediately (before the agent
      // processes them and emits a webhook event).
      const pendingPromptRows = fastify.db
        .query(
          `SELECT id, content, status, is_command, created_at
           FROM pending_prompts
           WHERE session_id = ?
           ORDER BY created_at DESC
           LIMIT 20`,
        )
        .all(id) as Array<{ id: string; content: string; status: string; is_command: number; created_at: string }>;

      const pendingPrompts = pendingPromptRows.map(p => ({
        id: p.id,
        content: p.content,
        status: p.status as 'pending' | 'delivered' | 'failed',
        isCommand: p.is_command === 1,
        createdAt: p.created_at,
      }));

      const response: ApiSuccess<SessionDetailResponse> = {
        data: { session, messages, todos, mcpTools, hasMore, oldestMessageId, totalMessages, pendingPrompts },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /sessions/:id/prompt — queue a prompt for the plugin to relay to OpenCode
  fastify.post<{ Params: { id: string }; Body: { content: string; isCommand?: boolean } }>(
    '/:id/prompt',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as { content?: string; isCommand?: boolean } | null;
      const content = body?.content;
      const isCommand = body?.isCommand === true;

      if (!content || typeof content !== 'string' || !content.trim()) {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'Prompt content is required',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      // Cap prompt length to prevent DoS / SSE amplification via oversized payloads
      if (content.length > 100_000) {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'Prompt content exceeds the maximum allowed length of 100,000 characters.',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      // Look up the instance that owns this specific session via hook_events.
      // Only consider instances directly linked to this session — never fall back to
      // a different instance (which wouldn't own the session ID and would silently drop
      // the prompt or inject it into the wrong session).
      const userId = request.user!.id;
      const instanceRow = fastify.db
        .query(
          `SELECT i.id, i.type, i.url, i.status, i.last_seen
           FROM hook_events h
           JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id = ?
             AND i.user_id = ?
             AND i.type IN ('opencode', 'claude-code')
           ORDER BY
             CASE WHEN i.type = 'opencode' AND i.url IS NOT NULL AND i.url != '' THEN 0 ELSE 1 END,
             h.received_at DESC
           LIMIT 1`,
        )
        .get(id, userId) as { id: string; type: string; url: string | null; status: string; last_seen: string } | undefined;

      if (!instanceRow) {
        const error: ApiError = {
          error: 'Not Available',
          message: 'No agent instance found for this session. Make sure OpenCode or Claude Code is running with the Conduit hook installed.',
          statusCode: 503,
        };
        return reply.code(503).send(error);
      }

      const promptId = randomUUID();
      const trimmedContent = content.trim();

      // Parse command name and arguments from slash commands (e.g., "/compact" → command="compact", args="")
      let commandName: string | undefined;
      let commandArgs = '';
      if (isCommand && trimmedContent.startsWith('/')) {
        const parts = trimmedContent.slice(1).split(/\s+/);
        commandName = parts[0];
        commandArgs = parts.slice(1).join(' ');
      }

      // ── Direct injection path: OpenCode instance with a known URL ────────
      // Call prompt_async (or command endpoint) directly — fire and forget.
      // Only attempted when the instance is session-linked (verified above).
      if (instanceRow.type === 'opencode' && instanceRow.url) {
        // SECURITY (G-05): Re-validate the instance URL at call time to prevent SSRF.
        // Even though the URL was validated when stored, it may have been tampered
        // with in the DB, or the validation rules may have changed.
        // OpenCode instances are co-located on the user's machine, so loopback is safe.
        try {
          validateUrlNotPrivate(instanceRow.url, { allowLoopback: instanceRow.type === 'opencode' });
        } catch (urlErr) {
          fastify.log.warn({ err: urlErr, instanceId: instanceRow.id, url: instanceRow.url }, 'Instance URL failed SSRF validation at send time');
          const error: ApiError = {
            error: 'Bad Request',
            message: 'Instance URL is not a valid external address',
            statusCode: 400,
          };
          return reply.code(400).send(error);
        }

        try {
          if (isCommand && commandName) {
            await sendCommand(id, commandName, commandArgs, instanceRow.url);
          } else {
            await sendMessage(id, trimmedContent, instanceRow.url);
          }

          // Mark as delivered immediately since OpenCode accepted the message
          fastify.db.query(
            `INSERT INTO pending_prompts (id, session_id, user_id, content, status, is_command, command_name, created_at) VALUES (?, ?, ?, ?, 'delivered', ?, ?, datetime('now'))`,
          ).run(promptId, id, userId, trimmedContent, isCommand ? 1 : 0, commandName ?? null);

          const response: ApiSuccess<{ promptId: string; status: string }> = {
            data: { promptId, status: 'delivered' },
          };
          return reply.code(202).send(response);
        } catch (err) {
          // IMPORTANT: Do NOT fall through to queue-based path (Path B).
          // The HTTP request to OpenCode may have succeeded even if response
          // parsing failed. Falling through would create a pending prompt that
          // the plugin picks up via SSE → duplicate injection.
          fastify.log.warn({ err, sessionId: id }, 'Direct OpenCode injection failed');

          fastify.db.query(
            `INSERT INTO pending_prompts (id, session_id, user_id, content, status, is_command, command_name, created_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, datetime('now'))`,
          ).run(promptId, id, userId, trimmedContent, isCommand ? 1 : 0, commandName ?? null);

          const error: ApiError = {
            error: 'Injection Failed',
            message: `Failed to inject prompt into OpenCode session: ${err instanceof Error ? err.message : String(err)}`,
            statusCode: 502,
          };
          return reply.code(502).send(error);
        }
      }

      // ── Queue-based path: Claude Code or OpenCode without a registered URL ──
      fastify.db.query(
        `INSERT INTO pending_prompts (id, session_id, user_id, content, status, is_command, command_name, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      ).run(promptId, id, userId, trimmedContent, isCommand ? 1 : 0, commandName ?? null);

      // Broadcast to any connected MCP servers listening on /prompts/stream
      promptBus.emit('prompt.queued', {
        id: promptId,
        sessionId: id,
        userId,
        content: trimmedContent,
        isCommand,
        commandName,
        createdAt: new Date().toISOString(),
      });

      const response: ApiSuccess<{ promptId: string; status: string }> = {
        data: { promptId, status: 'queued' },
      };
      return reply.code(202).send(response);
    },
  );

  // GET /sessions/:id/prompt-status — check status of pending prompts for a session (scoped to user)
  fastify.get<{ Params: { id: string } }>(
    '/:id/prompt-status',
    { config: { rateLimit: apiReadRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      // Verify the session belongs to this user's instances before returning prompt data
      const sessionExists = fastify.db
        .query(
          `SELECT 1 FROM hook_events h
           INNER JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id = ? AND i.user_id = ?
           LIMIT 1`,
        )
        .get(id, userId);

      if (!sessionExists) {
        const response: ApiSuccess<{ prompts: Array<{ id: string; status: string; created_at: string }> }> = {
          data: { prompts: [] },
        };
        return reply.code(200).send(response);
      }

      const rows = fastify.db
        .query(
          `SELECT id, status, created_at FROM pending_prompts WHERE session_id = ? ORDER BY created_at DESC LIMIT 10`,
        )
        .all(id) as Array<{ id: string; status: string; created_at: string }>;

      const response: ApiSuccess<{ prompts: typeof rows }> = {
        data: { prompts: rows },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /sessions — not supported (sessions are created by the agent)
  fastify.post(
    '/',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (_request, reply) => {
      const error: ApiError = {
        error: 'Not Supported',
        message: 'Sessions are created automatically by the agent. Use your Claude Code or OpenCode CLI to start a session.',
        statusCode: 501,
      };
      return reply.code(501).send(error);
    },
  );

  // DELETE /sessions/:id — remove all events for that session_id (scoped to user)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      // Verify the session belongs to this user's instances
      const existing = fastify.db
        .query(
          `SELECT h.session_id FROM hook_events h
           INNER JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id = ? AND i.user_id = ?
           LIMIT 1`,
        )
        .get(id, userId);

      if (!existing) {
        const error: ApiError = { error: 'Not Found', message: 'Session not found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      // SECURITY: Scope DELETE to instances owned by this user, preventing cross-user
      // deletion even if the ownership check above were somehow bypassed.
      fastify.db.query(
        `DELETE FROM hook_events WHERE session_id = ?
           AND instance_id IN (SELECT id FROM instances WHERE user_id = ?)`,
      ).run(id, userId);
      fastify.db.query(`DELETE FROM archived_sessions WHERE session_id = ? AND user_id = ?`).run(id, userId);

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Session deleted' },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /sessions/:id/archive — archive a session for the current user
  fastify.post<{ Params: { id: string } }>(
    '/:id/archive',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      const existing = fastify.db
        .query(
          `SELECT h.session_id FROM hook_events h
           INNER JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id = ? AND i.user_id = ?
           LIMIT 1`,
        )
        .get(id, userId);

      if (!existing) {
        const error: ApiError = { error: 'Not Found', message: 'Session not found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      fastify.db.query(
        `INSERT OR IGNORE INTO archived_sessions (session_id, user_id) VALUES (?, ?)`,
      ).run(id, userId);

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Session archived' },
      };
      return reply.code(200).send(response);
    },
  );

  // DELETE /sessions/:id/archive — unarchive a session for the current user
  fastify.delete<{ Params: { id: string } }>(
    '/:id/archive',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;

      fastify.db.query(
        `DELETE FROM archived_sessions WHERE session_id = ? AND user_id = ?`,
      ).run(id, userId);

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Session unarchived' },
      };
      return reply.code(200).send(response);
    },
  );

  // ── Batch operations ───────────────────────────────────────────────────

  const batchIdsSchema = z.object({
    ids: z.array(z.string()).min(1).max(100),
  });

  // POST /sessions/batch/delete — delete multiple sessions
  fastify.post<{ Body: z.infer<typeof batchIdsSchema> }>(
    '/batch/delete',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const parsed = batchIdsSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = { error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid request', statusCode: 400 };
        return reply.code(400).send(error);
      }
      const { ids } = parsed.data;
      const userId = request.user!.id;

      // Verify all sessions belong to this user's instances
      const placeholders = ids.map(() => '?').join(',');
      const owned = fastify.db
        .query(
          `SELECT DISTINCT h.session_id FROM hook_events h
           INNER JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id IN (${placeholders}) AND i.user_id = ?`,
        )
        .all(...ids, userId) as { session_id: string }[];

      const ownedIds = owned.map(r => r.session_id);
      if (ownedIds.length === 0) {
        const error: ApiError = { error: 'Not Found', message: 'No matching sessions found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      const ownedPlaceholders = ownedIds.map(() => '?').join(',');
      fastify.db.query(`DELETE FROM hook_events WHERE session_id IN (${ownedPlaceholders})`).run(...ownedIds);
      fastify.db.query(`DELETE FROM archived_sessions WHERE session_id IN (${ownedPlaceholders}) AND user_id = ?`).run(...ownedIds, userId);

      const response: ApiSuccess<{ deleted: number }> = {
        data: { deleted: ownedIds.length },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /sessions/batch/archive — archive multiple sessions
  fastify.post<{ Body: z.infer<typeof batchIdsSchema> }>(
    '/batch/archive',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const parsed = batchIdsSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = { error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid request', statusCode: 400 };
        return reply.code(400).send(error);
      }
      const { ids } = parsed.data;
      const userId = request.user!.id;

      const placeholders = ids.map(() => '?').join(',');
      const owned = fastify.db
        .query(
          `SELECT DISTINCT h.session_id FROM hook_events h
           INNER JOIN instances i ON i.id = h.instance_id
           WHERE h.session_id IN (${placeholders}) AND i.user_id = ?`,
        )
        .all(...ids, userId) as { session_id: string }[];

      const ownedIds = owned.map(r => r.session_id);
      if (ownedIds.length === 0) {
        const error: ApiError = { error: 'Not Found', message: 'No matching sessions found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      const insert = fastify.db.query(`INSERT OR IGNORE INTO archived_sessions (session_id, user_id) VALUES (?, ?)`);
      for (const sid of ownedIds) {
        insert.run(sid, userId);
      }

      const response: ApiSuccess<{ archived: number }> = {
        data: { archived: ownedIds.length },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /sessions/batch/unarchive — unarchive multiple sessions
  fastify.post<{ Body: z.infer<typeof batchIdsSchema> }>(
    '/batch/unarchive',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const parsed = batchIdsSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = { error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid request', statusCode: 400 };
        return reply.code(400).send(error);
      }
      const { ids } = parsed.data;
      const userId = request.user!.id;

      const placeholders = ids.map(() => '?').join(',');
      fastify.db.query(`DELETE FROM archived_sessions WHERE session_id IN (${placeholders}) AND user_id = ?`).run(...ids, userId);

      const response: ApiSuccess<{ unarchived: number }> = {
        data: { unarchived: ids.length },
      };
      return reply.code(200).send(response);
    },
  );
}
