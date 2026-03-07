import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ApiError, ApiSuccess, HookPayload, HookResponse } from '@conduit/shared';
import { verifyHmacSignature } from '../services/auth.js';
import { config } from '../config.js';
import { webhookRateLimit, apiReadRateLimit, apiWriteRateLimit } from '../middleware/rateLimit.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { eventBus } from '../services/eventbus.js';
import { resolveHookTokenUser, extractBearerToken } from '../middleware/hook-auth.js';
import { emitInstanceUpdated } from './instances.js';
import { createHash } from 'node:crypto';
import { pricingService } from '../services/pricing.js';
import { resolveFallbackUserId } from '../lib/db-helpers.js';

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

/**
 * Returns true when the IP is a publicly-routable address.
 * Used to detect the client's public IP for display in the hook token UI.
 * SECURITY: Always call this on request.ip (Fastify's trustProxy-resolved value),
 * never on raw X-Forwarded-For or cf-connecting-ip headers.
 */
function isPublicIp(ip: string | undefined): ip is string {
  if (!ip) return false;
  return !(
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip === '::ffff:127.0.0.1'
  );
}


/**
 * Maps Claude Code hook event names to their canonical SSE event types so the
 * frontend EventSource listeners (which only know OpenCode-style dotted names)
 * can handle them.  OpenCode events pass through unchanged.
 *
 * Returns null for events that should NOT be broadcast to SSE clients (e.g.
 * subagent lifecycle noise that has no meaningful frontend representation).
 */
function toSSEEventType(hookEvent: string): string | null {
  switch (hookEvent) {
    case 'SessionStart':     return 'session.created';
    case 'UserPromptSubmit': return 'message.updated';
    case 'PreToolUse':       return 'tool.started';
    case 'PostToolUse':      return 'tool.completed';
    case 'Stop':             return 'session.idle';
    case 'SessionEnd':       return 'session.idle';
    case 'TaskCompleted':    return 'session.idle';
    // Subagent lifecycle — not meaningful for the session list / detail views
    case 'SubagentStart':    return null;
    case 'SubagentStop':     return null;
    // OpenCode events and report_event calls already use dotted names → pass through
    default:                 return hookEvent;
  }
}

const hookPayloadSchema = z.object({
  event: z.union([
    // Claude Code hook events
    z.enum([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'TaskCompleted',
      'SessionEnd',
    ]),
    // OpenCode plugin events
    z.enum([
      'session.created',
      'session.updated',
      'session.idle',
      'session.error',
      'session.compacting',
      'session.compacted',
      'message.updated',
      'message.part.updated',
      'tool.execute.after',
      'todo.updated',
      'mcp.tools.changed',
      'config.sync',
      'models.sync',
    ]),
  ]),
  timestamp: z.string(),
  sessionId: z.string(),
  data: z.record(z.string(), z.unknown()).refine(
    (d) => JSON.stringify(d).length <= 500_000,
    { message: 'Hook data payload exceeds the 500KB limit' },
  ),
});



export async function hookRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /hooks — webhook receiver (unchanged)
  fastify.post(
    '/',
    {
      config: { rateLimit: webhookRateLimit },
      bodyLimit: 1_048_576, // 1 MB — webhook payloads should be small JSON
    },
    async (request, reply) => {
      fastify.log.info('[hooks] POST /hooks received — headers: %s', JSON.stringify({
        'content-type': request.headers['content-type'],
        'x-conduit-timestamp': request.headers['x-conduit-timestamp'],
        'x-conduit-signature': request.headers['x-conduit-signature'] ? '(present)' : '(missing)',
        authorization: request.headers['authorization'] ? '(present)' : '(missing)',
      }));

      // 1. Resolve the hook token to a user
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        fastify.log.warn('[hooks] Auth failed — no valid token resolution');
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid or missing authorization token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const hookUserId = resolution.userId;

      // Extract the raw Bearer token for HMAC verification
      const rawBearerToken = extractBearerToken(request);
      if (!rawBearerToken) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing Bearer token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // For per-user tokens, look up the raw token from the DB for HMAC.
      // For legacy global tokens, use config.hookToken.
      let hmacSecret: string;
      if (hookUserId) {
        // Per-user token — the raw Bearer IS the HMAC secret
        hmacSecret = rawBearerToken;
      } else {
        // Legacy global token
        hmacSecret = config.hookToken;
      }

      // 2. Verify timestamp (±5 min replay window)
      const timestampHeader = request.headers['x-conduit-timestamp'] as string | undefined;
      if (!timestampHeader) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing X-Conduit-Timestamp header',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const timestamp = parseInt(timestampHeader, 10);
      if (isNaN(timestamp)) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid timestamp format',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const now = Date.now();
      const diff = Math.abs(now - timestamp);
      if (diff > REPLAY_WINDOW_MS) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Request timestamp outside acceptable window',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // 3. Verify HMAC signature
      const signatureHeader = request.headers['x-conduit-signature'] as string | undefined;
      if (!signatureHeader) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Missing X-Conduit-Signature header',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // SECURITY NOTE: We re-serialize the parsed body with JSON.stringify() to compute
      // the HMAC. This is safe because all clients (bash helper, PowerShell helper, JS
      // plugin) also use JSON.stringify() / ConvertTo-Json -Compress to produce the
      // signing payload. Both sides use deterministic JSON serialization, so the
      // signatures match. If raw body preservation were needed (e.g. for third-party
      // clients with different serializers), use Fastify's rawBody option instead.
      const rawBody = JSON.stringify(request.body);
      const signingData = `${timestampHeader}.${rawBody}`;

      const signature = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice(7)
        : signatureHeader;

      if (!verifyHmacSignature(hmacSecret, signingData, signature)) {
        fastify.log.warn(
          { bodyLength: rawBody.length, bodyPrefix: rawBody.slice(0, 200) },
          '[hooks] HMAC signature verification failed on POST /hooks',
        );
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid signature',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      // 4. Validate payload
      const parsed = hookPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const payload = parsed.data as HookPayload;
      const eventId = randomUUID();
      const db = fastify.db;
      // For legacy global tokens (hookUserId=null), resolve the single user in the
      // system so that instances and events are visible in the dashboard.
      const effectiveUserId = hookUserId ?? resolveFallbackUserId(db);

      // 5. Resolve instance_id — use instance type that matches the event source
      const CONDUIT_INTERNAL_EVENTS = new Set(['config.sync', 'models.sync']);
      const eventName = payload.event as string;
      const isConduitInternal = CONDUIT_INTERNAL_EVENTS.has(eventName);
      const isOpenCodeEvent = !isConduitInternal && eventName.includes('.');
      // For conduit-internal events (config.sync, models.sync), use the agentType field
      // from the payload to route to the correct instance. Both the OpenCode plugin and the
      // Claude Code MCP/bash helper now stamp this field; fall back to 'claude-code' for
      // older clients that predate this field.
      const instanceType = isConduitInternal
        ? ((payload.data as Record<string, unknown>)['agentType'] === 'opencode' ? 'opencode' : 'claude-code')
        : (isOpenCodeEvent ? 'opencode' : 'claude-code');

      // Scope to the user's instances when using a per-user token.
      // Resolution order (most specific → least specific):
      //   1. If the event carries a sessionId, find the instance that last sent
      //      events for that session — this ties the config.sync to the exact
      //      machine that owns the session, even when multiple Claude Code
      //      instances are registered for the same user.
      //   2. Fall back to the most-recently-seen instance of the correct type.
      let instanceRow: { id: string } | undefined;
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;

      if (effectiveUserId) {
        // 1. Session-scoped lookup (avoids multi-machine collision)
        if (sessionId && sessionId !== 'conduit-config' && sessionId !== 'conduit-models' && sessionId !== 'unknown') {
          instanceRow = db.query(`
            SELECT instance_id as id FROM hook_events
            WHERE session_id = ?
              AND instance_id IN (SELECT id FROM instances WHERE type = ? AND user_id = ?)
            ORDER BY received_at DESC LIMIT 1
          `).get(sessionId, instanceType, effectiveUserId) as { id: string } | undefined;
        }
        // 2. Fallback: most-recently-seen instance of the correct type
        if (!instanceRow) {
          instanceRow = db.query(`
            SELECT id FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1
          `).get(instanceType, effectiveUserId) as { id: string } | undefined;
        }
      } else {
        // Legacy global token with multiple users: match any instance (backward compat)
        if (sessionId && sessionId !== 'conduit-config' && sessionId !== 'conduit-models' && sessionId !== 'unknown') {
          instanceRow = db.query(`
            SELECT instance_id as id FROM hook_events
            WHERE session_id = ?
              AND instance_id IN (SELECT id FROM instances WHERE type = ?)
            ORDER BY received_at DESC LIMIT 1
          `).get(sessionId, instanceType) as { id: string } | undefined;
        }
        if (!instanceRow) {
          instanceRow = db.query(`
            SELECT id FROM instances WHERE type = ? ORDER BY last_seen DESC LIMIT 1
          `).get(instanceType) as { id: string } | undefined;
        }
      }

      // Auto-create instance if none registered yet (e.g. first config.sync before registration)
      if (!instanceRow) {
        const newInstanceId = randomUUID();
        db.query(`
          INSERT INTO instances (id, name, type, user_id, status, last_seen, created_at)
          VALUES (?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
        `).run(newInstanceId, instanceType === 'opencode' ? 'OpenCode' : 'Claude Code', instanceType, effectiveUserId);
        instanceRow = { id: newInstanceId };
      }

      const instanceId = instanceRow.id;

      // 5b. Update instance last_seen / status immediately (don't wait for health-check cycle).
      // Emit instance.updated SSE only when the status actually changes to avoid
      // flooding the bus with every hook event.
      const prevInstance = db.query(`SELECT status FROM instances WHERE id = ?`).get(instanceId) as { status: string } | undefined;
      db.query(`UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ?`).run(instanceId);
      if (prevInstance?.status !== 'connected') {
        emitInstanceUpdated(db, instanceId);
      }

      // 5c. Store event
      db.query(`
        INSERT INTO hook_events (id, instance_id, event_type, session_id, payload, received_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(eventId, instanceId, payload.event, payload.sessionId, JSON.stringify(payload.data));

      // 5c-bis. Update pre-aggregated metrics counters
      if (effectiveUserId) {
        const aggregator = fastify.metricsAggregator;
        const eventType = payload.event as string;
        const data = payload.data as Record<string, unknown>;

        // Message tracking — OpenCode: message.updated; Claude Code: UserPromptSubmit (one per user turn)
        if (eventType === 'message.updated') {
          const info = data['info'] as Record<string, unknown> | undefined;
          const msgId = (info?.['id'] as string) ?? (data['id'] as string) ?? eventId;
          aggregator.trackMessage(effectiveUserId, instanceId, msgId);

          // Token/cost tracking — only for assistant messages
          const role = info?.['role'] as string | undefined;
          if (role === 'assistant') {
            const tokensObj = info?.['tokens'] as Record<string, unknown> | undefined;
            const cacheObj = tokensObj?.['cache'] as Record<string, number> | undefined;
            const input = (tokensObj?.['input'] as number) ?? 0;
            const output = (tokensObj?.['output'] as number) ?? 0;
            const reasoning = (tokensObj?.['reasoning'] as number) ?? 0;
            const totalTokens = input + output + reasoning;
            if (totalTokens > 0) {
              const modelId = (info?.['modelID'] as string) ?? '';
              const provider = (info?.['providerID'] as string) ?? '';
              // Compute cost server-side — OpenCode always reports cost: 0
              pricingService.computeCost(modelId, provider, {
                input,
                output,
                reasoning,
                cache: { read: cacheObj?.['read'], write: cacheObj?.['write'] },
              }).then((cost) => {
                aggregator.trackTokensAndCost(effectiveUserId, instanceId, msgId, totalTokens, cost);
              }).catch(() => {
                aggregator.trackTokensAndCost(effectiveUserId, instanceId, msgId, totalTokens, 0);
              });
            }
          }
        }

        // Message tracking — Claude Code: UserPromptSubmit fires once per user prompt
        if (eventType === 'UserPromptSubmit') {
          aggregator.trackMessage(effectiveUserId, instanceId, eventId);
        }

        // Tool call tracking — OpenCode: message.part.updated with part.type="tool".
        // Only count on the first appearance (status="pending") to avoid a dedup
        // SELECT on every streaming chunk for the same call.
        if (eventType === 'message.part.updated') {
          const part = data['part'] as Record<string, unknown> | undefined;
          if (part?.['type'] === 'tool') {
            const state = part['state'] as Record<string, unknown> | undefined;
            if (state?.['status'] === 'pending') {
              const callId = (part['callID'] as string) ?? eventId;
              aggregator.trackToolCall(effectiveUserId, instanceId, callId);
            }
          }
        }

        // Tool call tracking — Claude Code: PostToolUse (fired after each tool)
        // PreToolUse is skipped to avoid double-counting (PostToolUse fires for every completed call)
        // tool.execute.after is skipped — message.part.updated status=pending already covers OpenCode
        if (eventType === 'PostToolUse') {
          aggregator.trackToolCall(effectiveUserId, instanceId, eventId);
        }
      }

      // 5c-ter. Broadcast to all connected SSE clients via the event bus.
      // Map Claude Code hook event names (e.g. "SessionStart") to the canonical
      // SSE event types the frontend listeners expect (e.g. "session.created").
      // The original event name is preserved in the data payload for traceability.
      const sseEventType = toSSEEventType(payload.event);
      fastify.log.info(
        '[hooks] Event stored — eventId=%s instanceId=%s event=%s sessionId=%s sseType=%s sseClients=%d',
        eventId, instanceId, payload.event, payload.sessionId, sseEventType ?? '(suppressed)', eventBus.clientCount,
      );
      if (sseEventType !== null) {
        eventBus.emit(sseEventType, {
          id: eventId,
          instanceId,
          sessionId: payload.sessionId,
          event: payload.event,
          data: payload.data,
          timestamp: payload.timestamp,
        });
      }

      // 5d. Handle config.sync — upsert the config snapshot for this instance
      if (payload.event === 'config.sync') {
        const configContent = typeof payload.data['content'] === 'string'
          ? payload.data['content']
          : JSON.stringify(payload.data['content'] ?? payload.data);
        db.query(`
          INSERT INTO config_snapshots (instance_id, agent_type, content, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(instance_id) DO UPDATE SET
            content    = excluded.content,
            agent_type = excluded.agent_type,
            updated_at = datetime('now')
        `).run(instanceId, instanceType, configContent);
      }

      // 5e. Handle models.sync — replace model list for this instance
      if (payload.event === 'models.sync') {
        const rawModels = payload.data['models'];
        if (Array.isArray(rawModels)) {
          const upsertModel = db.prepare(`
            INSERT INTO instance_models (instance_id, provider_id, model_id, model_name, synced_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(instance_id, provider_id, model_id) DO UPDATE SET
              model_name = excluded.model_name,
              synced_at  = datetime('now')
          `);
          // Replace all models for this instance in a transaction
          db.transaction(() => {
            db.query(`DELETE FROM instance_models WHERE instance_id = ?`).run(instanceId);
            for (const m of rawModels) {
              if (
                m && typeof m === 'object' &&
                typeof (m as Record<string, unknown>)['providerId'] === 'string' &&
                typeof (m as Record<string, unknown>)['modelId'] === 'string' &&
                typeof (m as Record<string, unknown>)['modelName'] === 'string'
              ) {
                const model = m as { providerId: string; modelId: string; modelName: string };
                upsertModel.run(instanceId, model.providerId, model.modelId, model.modelName);
              }
            }
          })();
        }
      }

      const response: HookResponse = {
        received: true,
        id: eventId,
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/batch — receive multiple hook events in a single request.
  // Accepts an array of up to 500 events, processes them all in one SQLite transaction.
  // Auth and HMAC signing are identical to POST /hooks — the signature covers the
  // entire batch body: `ts.JSON.stringify({ events: [...] })`.
  // This endpoint is the target of the OpenCode plugin's 1-second buffer flush,
  // reducing ~40 req/sec to ~1 req/sec during active generation.
  fastify.post(
    '/batch',
    {
      config: { rateLimit: webhookRateLimit },
      bodyLimit: 5_242_880, // 5 MB — batch of up to 500 events
    },
    async (request, reply) => {
      fastify.log.info('[hooks/batch] POST /hooks/batch received — events count: %s', Array.isArray((request.body as Record<string, unknown>)?.events) ? (request.body as { events: unknown[] }).events.length : 'N/A');

      // 1. Resolve hook token → user (same as single endpoint)
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        fastify.log.warn('[hooks/batch] Auth failed — no valid token resolution');
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid or missing authorization token', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const hookUserId = resolution.userId;

      const rawBearerToken = extractBearerToken(request);
      if (!rawBearerToken) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing Bearer token', statusCode: 401 };
        return reply.code(401).send(error);
      }

      const hmacSecret = hookUserId ? rawBearerToken : config.hookToken;

      // 2. Verify timestamp
      const timestampHeader = request.headers['x-conduit-timestamp'] as string | undefined;
      if (!timestampHeader) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing X-Conduit-Timestamp header', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const timestamp = parseInt(timestampHeader, 10);
      if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > REPLAY_WINDOW_MS) {
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired timestamp', statusCode: 401 };
        return reply.code(401).send(error);
      }

      // 3. Verify HMAC (signed over the entire batch body)
      const signatureHeader = request.headers['x-conduit-signature'] as string | undefined;
      if (!signatureHeader) {
        const error: ApiError = { error: 'Unauthorized', message: 'Missing X-Conduit-Signature header', statusCode: 401 };
        return reply.code(401).send(error);
      }
      const rawBody = JSON.stringify(request.body);
      const signingData = `${timestampHeader}.${rawBody}`;
      const signature = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
      if (!verifyHmacSignature(hmacSecret, signingData, signature)) {
        fastify.log.warn(
          { bodyLength: rawBody.length, bodyPrefix: rawBody.slice(0, 200) },
          '[hooks] HMAC signature verification failed on POST /hooks/batch',
        );
        const error: ApiError = { error: 'Unauthorized', message: 'Invalid signature', statusCode: 401 };
        return reply.code(401).send(error);
      }

      // 4. Validate batch body
      const body = request.body as { events?: unknown };
      if (!body || !Array.isArray(body.events)) {
        const error: ApiError = { error: 'Validation Error', message: 'Body must be { events: HookPayload[] }', statusCode: 400 };
        return reply.code(400).send(error);
      }
      if (body.events.length > 500) {
        const error: ApiError = { error: 'Validation Error', message: 'Batch size exceeds maximum of 500 events', statusCode: 400 };
        return reply.code(400).send(error);
      }

      // Parse and validate each event, collecting valid ones
      const validEvents: Array<{ payload: HookPayload; eventId: string }> = [];
      let skippedCount = 0;
      for (const raw of body.events) {
        const parsed = hookPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          // C-03: Log skipped events so operators can debug misconfigured agents.
          // Log at debug level to avoid flooding production logs during normal operation.
          skippedCount++;
          fastify.log.debug(
            { issues: parsed.error.issues, event: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).event : undefined },
            'Batch webhook: skipping malformed event',
          );
          continue;
        }
        validEvents.push({ payload: parsed.data as HookPayload, eventId: randomUUID() });
      }

      if (skippedCount > 0) {
        fastify.log.warn({ skipped: skippedCount, total: body.events.length }, 'Batch webhook: skipped malformed events');
      }

      if (validEvents.length === 0) {
        return reply.code(200).send({ received: true, count: 0, skipped: skippedCount });
      }

      const db = fastify.db;
      // For legacy global tokens (hookUserId=null), resolve the single user in the
      // system so that instances and events are visible in the dashboard.
      const effectiveUserId = hookUserId ?? resolveFallbackUserId(db);

      // 5. Resolve instance_id — detect type from first event (all events in a batch
      //    come from the same agent instance so type is uniform)
      const firstEvent = validEvents[0]!.payload;
      const isOpenCodeBatch = (firstEvent.event as string).includes('.');
      const instanceType = isOpenCodeBatch ? 'opencode' : 'claude-code';

      let instanceRow: { id: string } | undefined;
      if (effectiveUserId) {
        instanceRow = db.query(
          `SELECT id FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1`,
        ).get(instanceType, effectiveUserId) as { id: string } | undefined;
      } else {
        instanceRow = db.query(
          `SELECT id FROM instances WHERE type = ? ORDER BY last_seen DESC LIMIT 1`,
        ).get(instanceType) as { id: string } | undefined;
      }

      if (!instanceRow) {
        const newInstanceId = randomUUID();
        db.query(
          `INSERT INTO instances (id, name, type, user_id, status, last_seen, created_at)
           VALUES (?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))`,
        ).run(newInstanceId, instanceType === 'opencode' ? 'OpenCode' : 'Claude Code', instanceType, effectiveUserId);
        instanceRow = { id: newInstanceId };
      }

      const instanceId = instanceRow.id;
      const prevBatchStatus = (db.query(`SELECT status FROM instances WHERE id = ?`).get(instanceId) as { status: string } | undefined)?.status;
      db.query(`UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ?`).run(instanceId);
      if (prevBatchStatus !== 'connected') {
        emitInstanceUpdated(db, instanceId);
      }

      // 6. Insert all events + track metrics in a single transaction
      const aggregator = fastify.metricsAggregator;

      const insertEvent = db.prepare(
        `INSERT INTO hook_events (id, instance_id, event_type, session_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      );
      const upsertConfig = db.prepare(
        `INSERT INTO config_snapshots (instance_id, agent_type, content, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(instance_id) DO UPDATE SET
           content    = excluded.content,
           agent_type = excluded.agent_type,
           updated_at = datetime('now')`,
      );

      db.transaction(() => {
        for (const { payload, eventId } of validEvents) {
          const eventType = payload.event as string;
          const data = payload.data as Record<string, unknown>;

          insertEvent.run(eventId, instanceId, eventType, payload.sessionId, JSON.stringify(data));

          // Metrics tracking — same logic as single endpoint
          if (effectiveUserId) {
            if (eventType === 'message.updated') {
              const info = data['info'] as Record<string, unknown> | undefined;
              const msgId = (info?.['id'] as string) ?? (data['id'] as string) ?? eventId;
              aggregator.trackMessage(effectiveUserId, instanceId, msgId);
              const role = info?.['role'] as string | undefined;
              if (role === 'assistant') {
                const tokensObj = info?.['tokens'] as Record<string, unknown> | undefined;
                const cacheObj = tokensObj?.['cache'] as Record<string, number> | undefined;
                const input = (tokensObj?.['input'] as number) ?? 0;
                const output = (tokensObj?.['output'] as number) ?? 0;
                const reasoning = (tokensObj?.['reasoning'] as number) ?? 0;
                const totalTokens = input + output + reasoning;
                if (totalTokens > 0) {
                  const modelId = (info?.['modelID'] as string) ?? '';
                  const provider = (info?.['providerID'] as string) ?? '';
                  // Compute cost server-side — OpenCode always reports cost: 0
                  // Fire-and-forget within the transaction context (Promise resolves after tx commits)
                  pricingService.computeCost(modelId, provider, {
                    input,
                    output,
                    reasoning,
                    cache: { read: cacheObj?.['read'], write: cacheObj?.['write'] },
                  }).then((cost) => {
                    aggregator.trackTokensAndCost(effectiveUserId, instanceId, msgId, totalTokens, cost);
                  }).catch(() => {
                    aggregator.trackTokensAndCost(effectiveUserId, instanceId, msgId, totalTokens, 0);
                  });
                }
              }
            }

            if (eventType === 'UserPromptSubmit') {
              aggregator.trackMessage(effectiveUserId, instanceId, eventId);
            }

            if (eventType === 'message.part.updated') {
              const part = data['part'] as Record<string, unknown> | undefined;
              if (part?.['type'] === 'tool') {
                const state = part['state'] as Record<string, unknown> | undefined;
                if (state?.['status'] === 'pending') {
                  const callId = (part['callID'] as string) ?? eventId;
                  aggregator.trackToolCall(effectiveUserId, instanceId, callId);
                }
              }
            }

            // PostToolUse only — PreToolUse would double-count, tool.execute.after
            // is already covered by message.part.updated status=pending for OpenCode
            if (eventType === 'PostToolUse') {
              aggregator.trackToolCall(effectiveUserId, instanceId, eventId);
            }
          }

          // Config sync — upsert snapshot
          if (eventType === 'config.sync') {
            const configContent = typeof data['content'] === 'string'
              ? data['content']
              : JSON.stringify(data['content'] ?? data);
            upsertConfig.run(instanceId, instanceType, configContent);
          }

          // Models sync — replace model list for this instance
          if (eventType === 'models.sync') {
            const rawModels = data['models'];
            if (Array.isArray(rawModels)) {
              db.query(`DELETE FROM instance_models WHERE instance_id = ?`).run(instanceId);
              const upsertModel = db.prepare(`
                INSERT INTO instance_models (instance_id, provider_id, model_id, model_name, synced_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(instance_id, provider_id, model_id) DO UPDATE SET
                  model_name = excluded.model_name,
                  synced_at  = datetime('now')
              `);
              for (const m of rawModels) {
                if (
                  m && typeof m === 'object' &&
                  typeof (m as Record<string, unknown>)['providerId'] === 'string' &&
                  typeof (m as Record<string, unknown>)['modelId'] === 'string' &&
                  typeof (m as Record<string, unknown>)['modelName'] === 'string'
                ) {
                  const model = m as { providerId: string; modelId: string; modelName: string };
                  upsertModel.run(instanceId, model.providerId, model.modelId, model.modelName);
                }
              }
            }
          }
        }
      })();

      // 7. Broadcast all events to SSE clients (outside transaction — non-critical).
      // Apply the same Claude Code → SSE event type mapping as the single-event route.
      fastify.log.info('[hooks/batch] Broadcasting %d events — instanceId=%s sseClients=%d', validEvents.length, instanceId, eventBus.clientCount);
      for (const { payload, eventId } of validEvents) {
        const sseEventType = toSSEEventType(payload.event);
        if (sseEventType !== null) {
          eventBus.emit(sseEventType, {
            id: eventId,
            instanceId,
            sessionId: payload.sessionId,
            event: payload.event,
            data: payload.data,
            timestamp: payload.timestamp,
          });
        }
      }

      return reply.code(200).send({ received: true, count: validEvents.length, skipped: skippedCount });
    },
  );

  // GET /hooks/token — user-facing endpoint to retrieve the per-user hook token status + detected caller IP.
  // SECURITY (A-02): The raw token is never stored in the DB. On first access (no token yet), a new
  // token is generated and returned in plaintext exactly once. On subsequent calls, only the prefix is
  // returned (isSet: true, token: null) — the user must use POST /hooks/token/regenerate to get a new one.
  // Uses GET (no CSRF needed for read-only operations) so it works from mobile WebViews where
  // CapacitorHttp may not forward custom headers like X-Requested-With for POST requests.
  fastify.get(
    '/token',
    { preHandler: [requireAuth], config: { rateLimit: apiReadRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // SECURITY: Use request.ip which Fastify resolves correctly using the
      // configured trustProxy list. Do NOT manually parse cf-connecting-ip or
      // x-forwarded-for — that bypasses trustProxy and allows IP spoofing.
      const detectedIp = isPublicIp(request.ip) ? request.ip : null;

      const existing = db.query(
        `SELECT token_prefix FROM hook_tokens WHERE user_id = ? LIMIT 1`,
      ).get(userId) as { token_prefix: string } | undefined;

      if (existing) {
        // Token already exists — return masked representation only.
        // The plaintext can only be retrieved by regenerating via POST /hooks/token/regenerate.
        const response: ApiSuccess<{ token: null; prefix: string; isSet: true; detectedIp: string | null }> = {
          data: { token: null, prefix: existing.token_prefix, isSet: true, detectedIp },
        };
        return reply.code(200).send(response);
      }

      // No token yet — generate one and return it this one time.
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string; isSet: false; detectedIp: string | null }> = {
        data: { token: newToken, prefix: tokenPrefix, isSet: false, detectedIp },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/token — kept for backward compatibility (web app used this before).
  // The GET variant above is preferred for mobile clients.
  // Same semantics: returns token plaintext only on first creation; masked on subsequent calls.
  fastify.post(
    '/token',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // SECURITY: Use request.ip which Fastify resolves correctly using the
      // configured trustProxy list. Do NOT manually parse cf-connecting-ip or
      // x-forwarded-for — that bypasses trustProxy and allows IP spoofing.
      const detectedIp = isPublicIp(request.ip) ? request.ip : null;

      const existing = db.query(
        `SELECT token_prefix FROM hook_tokens WHERE user_id = ? LIMIT 1`,
      ).get(userId) as { token_prefix: string } | undefined;

      if (existing) {
        const response: ApiSuccess<{ token: null; prefix: string; isSet: true; detectedIp: string | null }> = {
          data: { token: null, prefix: existing.token_prefix, isSet: true, detectedIp },
        };
        return reply.code(200).send(response);
      }

      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string; isSet: false; detectedIp: string | null }> = {
        data: { token: newToken, prefix: tokenPrefix, isSet: false, detectedIp },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /hooks/token/regenerate — regenerate the per-user hook token.
  // Always returns the new plaintext token exactly once.
  fastify.post(
    '/token/regenerate',
    { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const userId = request.user!.id;
      const db = fastify.db;

      // Delete existing token(s) for this user
      db.query(`DELETE FROM hook_tokens WHERE user_id = ?`).run(userId);

      // Create a new token — return plaintext this one time only (never stored)
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      const response: ApiSuccess<{ token: string; prefix: string }> = {
        data: { token: newToken, prefix: tokenPrefix },
      };
      return reply.code(200).send(response);
    },
  );
}
