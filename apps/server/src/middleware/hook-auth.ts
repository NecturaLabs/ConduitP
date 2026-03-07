/**
 * Per-user hook-token authentication middleware.
 *
 * Each user has their own hook token stored as a SHA-256 hash in the
 * `hook_tokens` table. Agent-facing endpoints extract the Bearer token,
 * hash it, and look up the owning user — ensuring complete user isolation.
 *
 * The global CONDUIT_HOOK_TOKEN is kept as a legacy fallback: if a Bearer
 * token doesn't match any per-user token, it's checked against the global
 * token. This allows a grace period for agents that haven't re-installed
 * with a per-user token yet. Legacy fallback does NOT set a userId —
 * callers must handle the null case.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiError } from '@conduit/shared';
import { config } from '../config.js';

/** Result of resolving a hook token: the owning user's ID, or null for legacy global token. */
export interface HookTokenResolution {
  userId: string | null;
}

/**
 * Extract the raw Bearer token from the Authorization header.
 * Returns null if the header is missing or malformed.
 */
export function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

/**
 * Timing-safe comparison of a candidate token against the configured global hook token.
 */
function verifyGlobalHookToken(token: string): boolean {
  if (!config.hookToken) return false;
  const a = Buffer.from(token, 'utf-8');
  const b = Buffer.from(config.hookToken, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve a raw Bearer token to its owning user.
 *
 * 1. SHA-256 hash the token
 * 2. Look up the hash in `hook_tokens` → get `user_id`
 * 3. If no match, fall back to global CONDUIT_HOOK_TOKEN (legacy)
 *
 * Returns `{ userId }` on success, or null if the token is invalid.
 */
export function resolveHookTokenUser(request: FastifyRequest): HookTokenResolution | null {
  const rawToken = extractBearerToken(request);
  if (!rawToken) return null;

  // Try per-user token first
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const db = request.server.db;
  const row = db.query(
    `SELECT user_id FROM hook_tokens WHERE token_hash = ?`,
  ).get(tokenHash) as { user_id: string } | undefined;

  if (row) {
    return { userId: row.user_id };
  }

  // Legacy fallback: global hook token (no user association)
  if (verifyGlobalHookToken(rawToken)) {
    return { userId: null };
  }

  request.server.log.warn(
    { tokenHashPrefix: tokenHash.slice(0, 8) },
    'Hook token auth failed: no matching per-user token or global token',
  );
  return null;
}

/**
 * Verify the Bearer token from the Authorization header of a Fastify request.
 * Returns true if the token matches either a per-user token or the global hook token.
 */
export function verifyBearerToken(request: FastifyRequest): boolean {
  return resolveHookTokenUser(request) !== null;
}

/**
 * Fastify preHandler hook that requires a valid hook token.
 * Sets `request.hookTokenUserId` if a per-user token is used.
 * Sends a 401 response if the token is missing or invalid.
 */
export async function requireHookToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const resolution = resolveHookTokenUser(request);
  if (!resolution) {
    const error: ApiError = {
      error: 'Unauthorized',
      message: 'Invalid or missing hook token',
      statusCode: 401,
    };
    reply.code(401).send(error);
    return;
  }
  // Stash the userId on the request for downstream handlers
  (request as FastifyRequest & { hookTokenUserId?: string | null }).hookTokenUserId = resolution.userId;
}

declare module 'fastify' {
  interface FastifyRequest {
    agentUserId?: string;
  }
}

/**
 * Fastify preHandler hook that requires a valid per-user hook token.
 * Rejects global/legacy tokens (those that resolve to userId === null).
 * Sets `request.agentUserId` on success.
 * Sends a 401 response if the token is missing, invalid, or a global token.
 */
export async function requireAgentToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const resolution = resolveHookTokenUser(request);
  if (!resolution || resolution.userId === null) {
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'A valid per-user hook token is required for agent endpoints',
      statusCode: 401,
    });
    return;
  }
  request.agentUserId = resolution.userId;
}
