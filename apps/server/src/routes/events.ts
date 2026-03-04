import type { FastifyInstance } from 'fastify';
import type { ApiError } from '@conduit/shared';
import { requireAuth } from '../middleware/auth.js';
import { eventBus } from '../services/eventbus.js';
import { config } from '../config.js';
import { sanitizeEventType, encodeSSEData } from '../lib/sse.js';

// SECURITY: Limit concurrent SSE connections per user to prevent resource exhaustion.
// Each connection holds an open HTTP response, an EventBus subscription, and a heartbeat timer.
// A limit of 10 is generous for multi-tab/multi-device usage while bounding server exposure.
const MAX_SSE_PER_USER = 10;
const sseConnectionCounts = new Map<string, number>();

export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /events — SSE endpoint for browser clients.
  // Events are pushed here by the EventBus when webhooks arrive at POST /hooks.
  // Scoped to the authenticated user's instances.
  fastify.get(
    '/',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const userId = request.user!.id;
      fastify.log.info('[sse] New SSE connection — userId=%s', userId);

      // Enforce per-user connection limit
      const current = sseConnectionCounts.get(userId) ?? 0;
      if (current >= MAX_SSE_PER_USER) {
        const error: ApiError = {
          error: 'Too Many Requests',
          message: 'Too many concurrent event stream connections',
          statusCode: 429,
        };
        return reply.code(429).send(error);
      }
      sseConnectionCounts.set(userId, current + 1);

      // SSE streams must not be killed by the global requestTimeout
      request.raw.setTimeout(0);

      // Pre-load the set of instance IDs owned by this user
      const instanceRows = fastify.db.query(
        `SELECT id FROM instances WHERE user_id = ?`,
      ).all(userId) as Array<{ id: string }>;
      const userInstanceIds = new Set(instanceRows.map(r => r.id));

      // Resolve the correct CORS origin for this specific request.
      // Capacitor Android WebViews use 'capacitor://localhost' or 'https://localhost'
      // as their origin — both are listed in config.capacitorOrigins.
      // For any other trusted origin (including the web app), reflect it back verbatim.
      const requestOrigin = request.headers['origin'];
      const allowedOrigins = [config.appUrl, ...config.capacitorOrigins];
      const corsOrigin = requestOrigin && allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : config.appUrl;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': corsOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Credentials': 'true',
      });

      // Send an initial "connected" event so the client knows the stream is live
      fastify.log.info('[sse] SSE stream established — userId=%s instances=%d origin=%s', userId, userInstanceIds.size, corsOrigin);
      reply.raw.write(`event: connected\n${encodeSSEData(JSON.stringify({ message: 'SSE stream connected' }))}\n\n`);

      // Subscribe this client to the event bus, filtering to user's instances
      const unsubscribe = eventBus.subscribe((eventType: string, data: string) => {
        try {
          // Filter: only forward events from this user's instances
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const instanceId = parsed.instanceId as string | undefined;
          if (instanceId) {
            if (!userInstanceIds.has(instanceId)) {
              // Check if this is a newly-registered instance for this user
              const exists = fastify.db.query(
                `SELECT 1 FROM instances WHERE id = ? AND user_id = ?`,
              ).get(instanceId, userId);
              if (!exists) {
                fastify.log.info('[sse] Event filtered out — instanceId=%s not owned by userId=%s', instanceId, userId);
                return;
              }
              userInstanceIds.add(instanceId);
            }
          }
          fastify.log.info('[sse] Forwarding event to client — userId=%s event=%s instanceId=%s', userId, eventType, instanceId ?? '(none)');
          reply.raw.write(`event: ${sanitizeEventType(eventType)}\n${encodeSSEData(data)}\n\n`);
        } catch {
          unsubscribe();
        }
      });

      // Heartbeat every 30 seconds to keep the connection alive
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`:heartbeat\n\n`);
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 30_000);

      // Clean up on client disconnect
      request.raw.on('close', () => {
        fastify.log.info('[sse] Client disconnected — userId=%s', userId);
        clearInterval(heartbeat);
        unsubscribe();
        const count = sseConnectionCounts.get(userId) ?? 1;
        if (count <= 1) {
          sseConnectionCounts.delete(userId);
        } else {
          sseConnectionCounts.set(userId, count - 1);
        }
      });
    },
  );
}
