import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ApiError, ApiSuccess, Instance } from '@conduit/shared';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { resolveHookTokenUser } from '../middleware/hook-auth.js';
import { normalizeTs } from '../lib/db-helpers.js';
import * as opencode from '../services/opencode.js';
import { validateUrlNotPrivate } from '../services/url-validation.js';
import { eventBus } from '../services/eventbus.js';
import { apiReadRateLimit, apiWriteRateLimit } from '../middleware/rateLimit.js';

const createInstanceSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['opencode', 'claude-code']),
  url: z.string().url().optional(),
});

const registerInstanceSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['opencode', 'claude-code']),
  url: z.string().url().optional(),
  version: z.string().max(50).optional(),
});

function mapInstanceRow(row: Record<string, unknown>): Instance {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    type: row['type'] as Instance['type'],
    url: (row['url'] as string) ?? null,
    version: (row['version'] as string) ?? null,
    status: (row['status'] as Instance['status']) ?? 'disconnected',
    lastSeen: normalizeTs(row['last_seen'] as string | null),
    createdAt: normalizeTs(row['created_at'] as string),
  };
}

// Periodic health check interval (60s)
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

async function runHealthChecks(fastify: FastifyInstance): Promise<void> {
  const db = fastify.db;

  // Check OpenCode instances via HTTP health endpoint
  const rows = db.query(
    `SELECT * FROM instances WHERE type = 'opencode' AND url IS NOT NULL`,
  ).all() as Array<Record<string, unknown>>;

  for (const row of rows) {
    const url = row['url'] as string;
    const id = row['id'] as string;
    const oldStatus = row['status'] as string;
    try {
      const { healthy } = await opencode.checkHealth(url);
      const newStatus = healthy ? 'connected' : 'error';
      db.query(`UPDATE instances SET status = ?, last_seen = datetime('now') WHERE id = ?`).run(
        newStatus,
        id,
      );
      if (newStatus !== oldStatus) {
        emitInstanceUpdated(db, id);
      }
    } catch {
      db.query(`UPDATE instances SET status = 'error' WHERE id = ?`).run(id);
      if (oldStatus !== 'error') {
        emitInstanceUpdated(db, id);
      }
    }
  }

  // For Claude Code instances — check if we received any hook_events in the last 5 minutes
  const claudeRows = db.query(
    `SELECT * FROM instances WHERE type = 'claude-code'`,
  ).all() as Array<Record<string, unknown>>;

  for (const row of claudeRows) {
    const id = row['id'] as string;
    const oldStatus = row['status'] as string;
    const recentEvent = db.query(`
      SELECT id FROM hook_events
      WHERE instance_id = ?
        AND received_at >= datetime('now', '-5 minutes')
      LIMIT 1
    `).get(id) as { id: string } | undefined;

    const newStatus = recentEvent ? 'connected' : 'disconnected';
    if (recentEvent) {
      db.query(`UPDATE instances SET status = ?, last_seen = datetime('now') WHERE id = ?`).run(newStatus, id);
    } else {
      db.query(`UPDATE instances SET status = ? WHERE id = ?`).run(newStatus, id);
    }
    if (newStatus !== oldStatus) {
      emitInstanceUpdated(db, id);
    }
  }
}

/**
 * Emit an `instance.updated` SSE event for a given instance.
 * Called after any status change so connected browser clients update
 * immediately instead of waiting for the 10-second polling interval.
 */
function emitInstanceUpdated(db: FastifyInstance['db'], instanceId: string): void {
  const row = db.query(`SELECT * FROM instances WHERE id = ?`).get(instanceId) as Record<string, unknown> | undefined;
  if (!row) return;
  const userId = row['user_id'] as string | undefined;
  eventBus.emit('instance.updated', {
    instanceId,
    userId,
    status: row['status'],
    lastSeen: row['last_seen'],
  });
}

/**
 * Exported so hooks.ts can emit instance.updated immediately when a
 * hook event is received (which means the instance is definitely alive),
 * without waiting for the next 60-second health check cycle.
 */
export { emitInstanceUpdated };

/**
 * Public registration endpoint — called by CLI scripts to auto-register instances.
 * Must be registered OUTSIDE the CSRF-protected route group.
 */
export async function instanceRegisterRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/',
    async (request, reply) => {
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid or missing hook token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const hookUserId = resolution.userId;

      const parsed = registerInstanceSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { name, type, url, version } = parsed.data;
      const db = fastify.db;

      // SSRF protection: validate that the instance URL doesn't point to private networks
      if (url) {
        try {
          validateUrlNotPrivate(url);
        } catch (err) {
          const error: ApiError = {
            error: 'Validation Error',
            message: `Invalid instance URL: ${(err as Error).message}`,
            statusCode: 400,
          };
          return reply.code(400).send(error);
        }
      }

      // If instance with same URL already exists (scoped to user), update it
      if (url) {
        const existingQuery = hookUserId
          ? 'SELECT * FROM instances WHERE url = ? AND user_id = ?'
          : 'SELECT * FROM instances WHERE url = ?';
        const existingParams = hookUserId ? [url, hookUserId] : [url];
        const existing = db.query(existingQuery).get(...existingParams) as Record<string, unknown> | undefined;
        if (existing) {
          db.query(`
            UPDATE instances SET name = ?, type = ?, version = ?, status = 'connected', last_seen = datetime('now') WHERE id = ?
          `).run(name, type, version ?? null, existing['id'] as string);

          const updated = db.query('SELECT * FROM instances WHERE id = ?').get(existing['id'] as string) as Record<string, unknown>;
          const instance = mapInstanceRow(updated);
          const response: ApiSuccess<{ instance: Instance }> = {
            data: { instance },
          };
          return reply.code(200).send(response);
        }
      }

      // No URL provided — match by type + user to avoid creating duplicate instances
      // on every agent restart (e.g. OpenCode plugin calling register on startup).
      if (hookUserId) {
        const existing = db.query(
          `SELECT * FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1`,
        ).get(type, hookUserId) as Record<string, unknown> | undefined;
        if (existing) {
          db.query(
            `UPDATE instances SET name = ?, version = ?, status = 'connected', last_seen = datetime('now') WHERE id = ?`,
          ).run(name, version ?? null, existing['id'] as string);
          const updated = db.query('SELECT * FROM instances WHERE id = ?').get(existing['id'] as string) as Record<string, unknown>;
          const instance = mapInstanceRow(updated);
          const response: ApiSuccess<{ instance: Instance }> = { data: { instance } };
          return reply.code(200).send(response);
        }
      }

      const id = randomUUID();
      db.query(`
        INSERT INTO instances (id, name, type, url, version, user_id, status, last_seen, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
      `).run(id, name, type, url ?? null, version ?? null, hookUserId);

      const row = db.query('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>;
      const instance = mapInstanceRow(row);

      const response: ApiSuccess<{ instance: Instance }> = {
        data: { instance },
      };
      return reply.code(201).send(response);
    },
  );
}

/**
 * Public heartbeat endpoint — called periodically by the MCP server to keep
 * the instance marked 'connected' during idle sessions (no hook events firing).
 * Authenticates with the hook token (same as registration). Finds the
 * most-recently-seen instance of the given type and bumps last_seen + status.
 */
export async function instanceHeartbeatRoute(fastify: FastifyInstance): Promise<void> {
  const heartbeatSchema = z.object({
    type: z.enum(['opencode', 'claude-code']),
  });

  fastify.post(
    '/',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid or missing hook token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const hookUserId = resolution.userId;

      const parsed = heartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { type } = parsed.data;
      const db = fastify.db;

      // Find the most-recently-seen instance of this type for this user.
      const query = hookUserId
        ? `SELECT id, status FROM instances WHERE type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1`
        : `SELECT id, status FROM instances WHERE type = ? ORDER BY last_seen DESC LIMIT 1`;
      const params = hookUserId ? [type, hookUserId] : [type];
      const row = db.query(query).get(...params) as { id: string; status: string } | undefined;

      if (!row) {
        // No instance registered yet — nothing to heartbeat.
        const response: ApiSuccess<{ message: string }> = {
          data: { message: 'No instance found for this type' },
        };
        return reply.code(200).send(response);
      }

      const prevStatus = row.status;
      db.query(
        `UPDATE instances SET status = 'connected', last_seen = datetime('now') WHERE id = ?`,
      ).run(row.id);

      // Only emit SSE if the status actually changed (e.g. was 'disconnected').
      if (prevStatus !== 'connected') {
        emitInstanceUpdated(db, row.id);
      }

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Heartbeat received' },
      };
      return reply.code(200).send(response);
    },
  );
}

/**
 * Public deregistration endpoint — called by CLI uninstall scripts.
 * Authenticates with the hook token (same as registration). Matches by
 * machine name + type since the script doesn't know the instance UUID.
 */
export async function instanceDeregisterRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/',
    async (request, reply) => {
      const resolution = resolveHookTokenUser(request);
      if (!resolution) {
        const error: ApiError = {
          error: 'Unauthorized',
          message: 'Invalid or missing hook token',
          statusCode: 401,
        };
        return reply.code(401).send(error);
      }

      const hookUserId = resolution.userId;

      const bodySchema = z.object({
        name: z.string().min(1).max(200),
        type: z.enum(['opencode', 'claude-code']),
      });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { name, type } = parsed.data;
      const db = fastify.db;

      // Find the most-recently-seen instance matching name + type, scoped to user
      const query = hookUserId
        ? `SELECT id FROM instances WHERE name = ? AND type = ? AND user_id = ? ORDER BY last_seen DESC LIMIT 1`
        : `SELECT id FROM instances WHERE name = ? AND type = ? ORDER BY last_seen DESC LIMIT 1`;
      const params = hookUserId ? [name, type, hookUserId] : [name, type];
      const row = db.query(query).get(...params) as { id: string } | undefined;

      if (!row) {
        // Nothing to delete — treat as success (idempotent)
        const response: ApiSuccess<{ message: string }> = {
          data: { message: 'No matching instance found (already removed)' },
        };
        return reply.code(200).send(response);
      }

      // Null out hook_events.instance_id to preserve historical event data
      // while satisfying the FK constraint (foreign_keys = ON).
      db.query('UPDATE hook_events SET instance_id = NULL WHERE instance_id = ?').run(row.id);
      // Delete all rows that reference this instance (FK constraints enforced).
      db.query('DELETE FROM metrics_counters WHERE instance_id = ?').run(row.id);
      db.query('DELETE FROM config_snapshots WHERE instance_id = ?').run(row.id);
      db.query('DELETE FROM config_pending WHERE instance_id = ?').run(row.id);
      db.query('DELETE FROM metrics_snapshots WHERE instance_id = ?').run(row.id);
      db.query('DELETE FROM instances WHERE id = ?').run(row.id);

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Instance removed' },
      };
      return reply.code(200).send(response);
    },
  );
}


export async function instanceRoutes(fastify: FastifyInstance): Promise<void> {
  // Start periodic health checks
  if (!healthCheckInterval) {
    setTimeout(() => {
      void runHealthChecks(fastify);
    }, 5_000);
    healthCheckInterval = setInterval(() => {
      void runHealthChecks(fastify);
    }, 60_000);

    fastify.addHook('onClose', async () => {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    });
  }

  // All routes require auth
  fastify.addHook('preHandler', requireAuth);

  // GET /instances
  fastify.get('/', { config: { rateLimit: apiReadRateLimit } }, async (request, reply) => {
    const db = fastify.db;
    const userId = request.user!.id;
    const rows = db.query('SELECT * FROM instances WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Array<Record<string, unknown>>;
    const instances = rows.map(mapInstanceRow);

    const response: ApiSuccess<{ instances: Instance[] }> = {
      data: { instances },
    };
    return reply.code(200).send(response);
  });

  // POST /instances
  fastify.post(
    '/',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const parsed = createInstanceSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: parsed.error.issues.map(i => i.message).join(', '),
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { name, type, url } = parsed.data;
      const id = randomUUID();
      const db = fastify.db;
      const userId = request.user!.id;

      // SSRF protection: validate that the instance URL doesn't point to private networks
      if (url) {
        try {
          validateUrlNotPrivate(url);
        } catch (err) {
          const error: ApiError = {
            error: 'Validation Error',
            message: `Invalid instance URL: ${(err as Error).message}`,
            statusCode: 400,
          };
          return reply.code(400).send(error);
        }
      }

      db.query(`
        INSERT INTO instances (id, name, type, url, user_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'disconnected', datetime('now'))
      `).run(id, name, type, url ?? null, userId);

      const row = db.query('SELECT * FROM instances WHERE id = ?').get(id) as Record<string, unknown>;
      const instance = mapInstanceRow(row);

      const response: ApiSuccess<{ instance: Instance }> = {
        data: { instance },
      };
      return reply.code(201).send(response);
    },
  );

  // DELETE /instances/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const db = fastify.db;

      const userId = request.user!.id;
      const existing = db.query('SELECT id FROM instances WHERE id = ? AND user_id = ?').get(id, userId);
      if (!existing) {
        const error: ApiError = {
          error: 'Not Found',
          message: 'Instance not found',
          statusCode: 404,
        };
        return reply.code(404).send(error);
      }

      // Null out hook_events.instance_id to preserve historical event data
      // while satisfying the FK constraint (foreign_keys = ON).
      db.query('UPDATE hook_events SET instance_id = NULL WHERE instance_id = ?').run(id);
      // Delete all rows that reference this instance (FK constraints enforced).
      db.query('DELETE FROM metrics_counters WHERE instance_id = ?').run(id);
      db.query('DELETE FROM config_snapshots WHERE instance_id = ?').run(id);
      db.query('DELETE FROM config_pending WHERE instance_id = ?').run(id);
      db.query('DELETE FROM metrics_snapshots WHERE instance_id = ?').run(id);
      db.query('DELETE FROM instances WHERE id = ? AND user_id = ?').run(id, userId);

      const response: ApiSuccess<{ message: string }> = {
        data: { message: 'Instance deleted' },
      };
      return reply.code(200).send(response);
    },
  );

  // POST /instances/:id/test
  fastify.post<{ Params: { id: string } }>(
    '/:id/test',
    { preHandler: [requireCsrf], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const { id } = request.params;
      const db = fastify.db;
      const userId = request.user!.id;

      const row = db.query('SELECT * FROM instances WHERE id = ? AND user_id = ?').get(id, userId) as Record<string, unknown> | undefined;
      if (!row) {
        const error: ApiError = {
          error: 'Not Found',
          message: 'Instance not found',
          statusCode: 404,
        };
        return reply.code(404).send(error);
      }

      const instance = mapInstanceRow(row);
      const start = Date.now();

      // Primary check: did we receive any hook events from this instance recently?
      const recentEvent = db.query(`
        SELECT received_at FROM hook_events
        WHERE instance_id = ?
          AND received_at >= datetime('now', '-5 minutes')
        ORDER BY received_at DESC
        LIMIT 1
      `).get(id) as { received_at: string } | undefined;

      let healthy = !!recentEvent;
      let latency = Date.now() - start;

      // Secondary check: if the instance has a URL (OpenCode), also try HTTP health
      if (instance.url && instance.type === 'opencode') {
        const httpResult = await opencode.checkHealth(instance.url);
        if (httpResult.healthy) {
          healthy = true;
          latency = httpResult.latency;
        }
      }

      const newStatus = healthy ? 'connected' : 'disconnected';
      const prevTestStatus = (row['status'] as string) ?? 'disconnected';

      db.query(`
        UPDATE instances SET status = ?, last_seen = datetime('now') WHERE id = ?
      `).run(newStatus, id);

      if (newStatus !== prevTestStatus) {
        emitInstanceUpdated(db, id);
      }

      const result: ApiSuccess<{ status: string; connected: boolean; latency: number }> = {
        data: { status: newStatus, connected: healthy, latency },
      };
      return reply.code(200).send(result);
    },
  );
}
