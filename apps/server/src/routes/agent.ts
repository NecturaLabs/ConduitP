import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { ApiError } from '@conduit/shared';
import { requireAgentToken } from '../middleware/hook-auth.js';
import { emitInstanceUpdated } from './instances.js';
import { pricingService } from '../services/pricing.js';
import { config } from '../config.js';
import { apiWriteRateLimit } from '../middleware/rateLimit.js';

// ── Helper: find or create the claude-code instance for a user ────────────────

async function resolveOrCreateInstance(
  db: Database,
  userId: string,
  name?: string,
): Promise<string> {
  const existing = db.query(
    `SELECT id FROM instances WHERE user_id = ? AND type = 'claude-code' LIMIT 1`,
  ).get(userId) as { id: string } | null;

  if (existing) return existing.id;

  const id = randomUUID();
  db.query(
    `INSERT INTO instances (id, user_id, type, name, status, last_seen, created_at)
     VALUES (?, ?, 'claude-code', ?, 'connected', datetime('now'), datetime('now'))`,
  ).run(id, userId, name ?? 'claude-code');

  return id;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const registerBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  version: z.string().max(50).optional(),
});

const eventBodySchema = z.object({
  type: z.enum(['session.start', 'session.end', 'message', 'tool.use']),
  sessionId: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

const ackBodySchema = z.object({
  status: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});

const modelsBodySchema = z.object({
  models: z.array(
    z.object({
      providerId: z.string(),
      modelId: z.string(),
      modelName: z.string(),
    }),
  ).max(500),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // ── POST /agent/register ──────────────────────────────────────────────────

  fastify.post(
    '/register',
    { preHandler: requireAgentToken },
    async (request, reply) => {
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map((i) => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { name } = parsed.data;
      const userId = request.agentUserId!;
      const db = fastify.db;

      const instanceId = await resolveOrCreateInstance(db, userId, name);

      // Update name/version if they differ from what was stored
      db.query(
        `UPDATE instances
         SET name = COALESCE(?, name),
             status = 'connected',
             last_seen = datetime('now')
         WHERE id = ? AND user_id = ?`,
      ).run(name ?? null, instanceId, userId);

      emitInstanceUpdated(db, instanceId);

      return reply.code(200).send({ instanceId, status: 'registered' });
    },
  );

  // ── POST /agent/event ─────────────────────────────────────────────────────

  fastify.post(
    '/event',
    { preHandler: requireAgentToken },
    async (request, reply) => {
      const parsed = eventBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map((i) => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { type, sessionId, data } = parsed.data;
      const userId = request.agentUserId!;
      const db = fastify.db;
      const aggregator = fastify.metricsAggregator;

      const instanceId = await resolveOrCreateInstance(db, userId);
      const eventId = randomUUID();

      // Map agent event type → hook_events event_type + build payload
      let eventType: string;
      let payload: Record<string, unknown>;

      switch (type) {
        case 'session.start': {
          eventType = 'SessionStart';
          payload = { ...data };
          break;
        }

        case 'session.end': {
          eventType = 'Stop';
          payload = { ...data };
          break;
        }

        case 'message': {
          eventType = 'message.updated';
          const inputTokens = typeof data['inputTokens'] === 'number' ? data['inputTokens'] : 0;
          const outputTokens = typeof data['outputTokens'] === 'number' ? data['outputTokens'] : 0;
          const cacheReadTokens = typeof data['cacheReadTokens'] === 'number' ? data['cacheReadTokens'] : 0;
          // Store payload in the shape sessions.ts expects:
          // p.info ?? p — we use the `info` key so the nested shape is unambiguous.
          payload = {
            info: {
              id: eventId,
              role: 'assistant',
              tokens: {
                input: inputTokens,
                output: outputTokens,
                cache: { read: cacheReadTokens },
              },
              ...data,
            },
          };

          // Track metrics
          aggregator.trackMessage(userId, instanceId, eventId);
          const totalTokens = inputTokens + outputTokens;
          if (totalTokens > 0) {
            pricingService.computeCost('', '', {
              input: inputTokens,
              output: outputTokens,
              reasoning: 0,
              cache: { read: cacheReadTokens },
            }).then((cost) => {
              aggregator.trackTokensAndCost(userId, instanceId, eventId, totalTokens, cost);
            }).catch(() => {
              aggregator.trackTokensAndCost(userId, instanceId, eventId, totalTokens, 0);
            });
          }
          break;
        }

        case 'tool.use': {
          eventType = 'PostToolUse';
          const toolName = typeof data['toolName'] === 'string' ? data['toolName'] : '';
          payload = { ...data, tool_name: toolName };
          aggregator.trackToolCall(userId, instanceId, eventId);
          break;
        }

        default: {
          // TypeScript exhaustiveness guard — z.enum already rejects unknown types
          // but this satisfies the compiler and returns a clean 400 at runtime.
          const error: ApiError = {
            error: 'Bad Request',
            message: `Unknown event type: ${String(type)}`,
            statusCode: 400,
          };
          return reply.code(400).send(error);
        }
      }

      db.query(
        `INSERT INTO hook_events (id, instance_id, event_type, session_id, payload, received_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).run(eventId, instanceId, eventType, sessionId, JSON.stringify(payload));

      // Keep instance marked connected
      db.query(
        `UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ? AND user_id = ?`,
      ).run(instanceId, userId);

      return reply.code(200).send({ ok: true });
    },
  );

  // ── GET /agent/prompts ────────────────────────────────────────────────────

  fastify.get('/prompts', { preHandler: requireAgentToken }, async (request, reply) => {
    const userId = request.agentUserId!;
    const db = fastify.db;

    // Atomically promote pending → processing, then return only the rows we just claimed.
    // This prevents the legacy /prompts/pending endpoint from racing and returning the same rows.
    db.query(
      `UPDATE pending_prompts SET status = 'processing' WHERE user_id = ? AND status = 'pending'`,
    ).run(userId);

    const prompts = db.query(
      `SELECT id, session_id, content, is_command, command_name, created_at
       FROM pending_prompts
       WHERE user_id = ? AND status = 'processing'
       ORDER BY created_at ASC`,
    ).all(userId) as Array<{
      id: string;
      session_id: string;
      content: string;
      is_command: number;
      command_name: string | null;
      created_at: string;
    }>;

    return reply.code(200).send({
      prompts: prompts.map((p) => ({
        id: p.id,
        sessionId: p.session_id,
        content: p.content,
        isCommand: p.is_command === 1,
        commandName: p.command_name,
        createdAt: p.created_at,
      })),
    });
  });

  // ── POST /agent/prompts/:id/ack ───────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/prompts/:id/ack',
    { preHandler: requireAgentToken },
    async (request, reply) => {
      const userId = request.agentUserId!;
      const { id } = request.params;
      const db = fastify.db;

      const parsed = ackBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map((i) => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const prompt = db.query(
        `SELECT id FROM pending_prompts WHERE id = ? AND user_id = ?`,
      ).get(id, userId) as { id: string } | undefined;

      if (!prompt) {
        const error: ApiError = { error: 'Not Found', message: 'Prompt not found', statusCode: 404 };
        return reply.code(404).send(error);
      }

      db.query(
        `UPDATE pending_prompts SET status = ? WHERE id = ? AND user_id = ?`,
      ).run(parsed.data.status, id, userId);

      return reply.code(200).send({ ok: true });
    },
  );

  // ── POST /agent/models ────────────────────────────────────────────────────

  fastify.post('/models', { preHandler: requireAgentToken }, async (request, reply) => {
    const userId = request.agentUserId!;
    const db = fastify.db;

    const parsed = modelsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const error: ApiError = {
        error: 'Validation Error',
        message: parsed.error.issues.map((i) => i.message).join(', '),
        statusCode: 400,
      };
      return reply.code(400).send(error);
    }

    const instanceId = await resolveOrCreateInstance(db, userId);

    for (const model of parsed.data.models) {
      db.query(`
        INSERT INTO instance_models (instance_id, provider_id, model_id, model_name, synced_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(instance_id, provider_id, model_id) DO UPDATE SET
          model_name = excluded.model_name,
          synced_at = excluded.synced_at
      `).run(instanceId, model.providerId, model.modelId, model.modelName);
    }

    return reply.code(200).send({ ok: true, synced: parsed.data.models.length });
  });

  // ── POST /agent/auth/device ───────────────────────────────────────────────
  // Initiates a device flow session. No auth required — called before the user
  // has a token. Returns a user code and device code for polling.

  fastify.post(
    '/auth/device',
    { config: { rateLimit: apiWriteRateLimit } },
    async (_request, reply) => {
      const db = fastify.db;

      // Prune expired sessions inline to keep the table tidy
      db.query(`DELETE FROM device_flow_sessions WHERE expires_at <= datetime('now')`).run();

      const deviceCode = randomUUID();

      // Generate 8 random uppercase consonants, formatted as XXXX-XXXX
      const CHARSET = 'BCDFGHJKLMNPQRSTVWXZ';
      let rawCode = '';
      const buf = randomBytes(16);
      let i = 0;
      while (rawCode.length < 8) {
        const byte = buf[i++ % buf.length]!;
        rawCode += CHARSET[byte % CHARSET.length];
      }
      const userCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      db.query(
        `INSERT INTO device_flow_sessions (device_code, user_code, approved, expires_at, user_id, hook_token)
         VALUES (?, ?, 0, ?, NULL, NULL)`,
      ).run(deviceCode, userCode, expiresAt);

      const baseUrl = config.appUrl;

      return reply.code(200).send({
        deviceCode,
        userCode,
        verificationUrl: `${baseUrl}/activate`,
        expiresIn: 600,
        interval: 5,
      });
    },
  );

  // ── GET /agent/auth/poll ──────────────────────────────────────────────────
  // Polls for device flow approval. No auth required — called by the CLI agent
  // while waiting for the user to approve on the web.

  fastify.get<{ Querystring: { deviceCode?: string } }>(
    '/auth/poll',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { deviceCode } = request.query;

      if (!deviceCode || typeof deviceCode !== 'string') {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'deviceCode query parameter is required',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const db = fastify.db;

      const row = db.query(
        `SELECT device_code, approved, hook_token
         FROM device_flow_sessions
         WHERE device_code = ? AND expires_at > datetime('now')`,
      ).get(deviceCode) as { device_code: string; approved: number; hook_token: string | null } | undefined;

      if (!row) {
        return reply.code(200).send({ status: 'expired' });
      }

      if (row.approved === 0) {
        return reply.code(200).send({ status: 'pending' });
      }

      // Approved — return the token and delete the row (one-time use)
      const token = row.hook_token;
      db.query(`DELETE FROM device_flow_sessions WHERE device_code = ?`).run(deviceCode);

      return reply.code(200).send({ status: 'approved', token });
    },
  );
}
