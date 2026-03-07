import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type {
  MagicLinkResponse,
  ApiError,
  ApiSuccess,
  User,
  JWTPayload,
  RefreshJWTPayload,
} from '@conduit/shared';
import {
  generateMagicLinkToken,
  verifyMagicLinkToken,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  hashToken,
  generateId,
  JWT_AUDIENCE_REFRESH,
} from '../services/auth.js';
import { sendMagicLink } from '../services/email.js';
import { config } from '../config.js';
import { requireAuth, requireCsrf } from '../middleware/auth.js';
import { authRateLimit, refreshRateLimit, apiReadRateLimit, apiWriteRateLimit } from '../middleware/rateLimit.js';
import { mapUserRow } from '../lib/db-helpers.js';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  cookieOptionsAccess,
  cookieOptionsRefresh,
} from '../lib/auth-cookies.js';

const magicLinkSchema = z.object({
  email: z.string().email().max(254),
});

// Grace window for refresh token reuse detection.
// If the same refresh token is seen a second time within this many seconds of
// first use, we treat it as a benign multi-tab race rather than an attack and
// re-issue silently. Outside this window, the family is revoked.
// SECURITY: 10 seconds is tight enough to limit the attack window from a
// stolen refresh token while still accommodating multi-tab race conditions.
const REFRESH_REUSE_GRACE_SECONDS = 10;

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /auth/magic-link
  fastify.post<{ Body: { email: string } }>(
    '/magic-link',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '15 minutes',
          keyGenerator: (request: FastifyRequest) => {
            const body = request.body as { email?: string } | undefined;
            return body?.email ?? request.ip;
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = magicLinkSchema.safeParse(request.body);
      if (!parsed.success) {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'A valid email address is required',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      const { email } = parsed.data;
      const db = fastify.db;

      // Always generate token regardless of whether user exists (prevent enumeration)
      const { raw, hash } = generateMagicLinkToken();
      const id = generateId();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      db.query(`
        INSERT INTO magic_link_tokens (id, token_hash, email, expires_at, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, hash, email.toLowerCase(), expiresAt, request.ip);

      // Fire-and-forget — never expose whether email was actually sent.
      // The link always uses the server's default https:// URL so App Links
      // on Android can intercept it and open the app directly.
      sendMagicLink(email.toLowerCase(), raw, config.appUrl, request.log);

      // Always identical response regardless of email existence
      const response: MagicLinkResponse = {
        message: 'If an account exists with that email, a magic link has been sent.',
      };
      return reply.code(200).send(response);
    },
  );

  // Shared token verification logic used by both POST and GET /auth/verify
  async function verifyTokenAndAuthenticate(
    token: string | undefined,
    reply: import('fastify').FastifyReply,
    requestOrigin?: string,
  ): Promise<{ user: User } | null> {
    if (!token || typeof token !== 'string') {
      const error: ApiError = {
        error: 'Validation Error',
        message: 'Token is required',
        statusCode: 400,
      };
      reply.code(400).send(error);
      return null;
    }

    const tokenHash = hashToken(token);
    const db = fastify.db;

    // SECURITY: Atomic token consumption to prevent TOCTOU race conditions.
    // Use UPDATE ... WHERE used = 0 so only the first concurrent request succeeds.
    // This prevents a magic link from being used twice in a race window.
    const tokenRow = db.query(`
      SELECT id, token_hash, email, used, expires_at
      FROM magic_link_tokens
      WHERE token_hash = ?
    `).get(tokenHash) as {
      id: string;
      token_hash: string;
      email: string;
      used: number;
      expires_at: string;
    } | undefined;

    if (!tokenRow) {
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired token', statusCode: 401 };
      reply.code(401).send(error);
      return null;
    }

    if (tokenRow.used === 1) {
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired token', statusCode: 401 };
      reply.code(401).send(error);
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(tokenRow.expires_at);
    if (now > expiresAt) {
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired token', statusCode: 401 };
      reply.code(401).send(error);
      return null;
    }

    if (!verifyMagicLinkToken(token, tokenRow.token_hash)) {
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired token', statusCode: 401 };
      reply.code(401).send(error);
      return null;
    }

    // Atomic mark-as-used: only succeeds if token hasn't been consumed by a concurrent request
    const result = db.query('UPDATE magic_link_tokens SET used = 1 WHERE id = ? AND used = 0').run(tokenRow.id);
    if ((result as { changes: number }).changes === 0) {
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired token', statusCode: 401 };
      reply.code(401).send(error);
      return null;
    }

    // Find or create user
    const email = tokenRow.email;
    let userRow = db.query('SELECT * FROM users WHERE email = ?').get(email) as Record<string, unknown> | undefined;

    if (!userRow) {
      const userId = generateId();
      db.query(`
        INSERT INTO users (id, email, trial_started_at)
        VALUES (?, ?, datetime('now'))
      `).run(userId, email);
      userRow = db.query('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
    }

    const user = mapUserRow(userRow!);

    // Generate tokens
    const familyId = generateId();
    const accessToken = createAccessToken(
      { sub: user.id, email: user.email },
      config.jwtSecret,
    );
    const refreshTokenJwt = createRefreshToken(
      { sub: user.id, family: familyId },
      config.jwtRefreshSecret,
    );

    // Store refresh token
    const refreshId = generateId();
    const refreshHash = hashToken(refreshTokenJwt);
    const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
    db.query(`
      INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(refreshId, refreshHash, user.id, familyId, refreshExpires);

    // Set cookies — use request origin to derive correct SameSite value
    reply.setCookie('conduit_access', accessToken, cookieOptionsAccess(requestOrigin));
    reply.setCookie('conduit_refresh', refreshTokenJwt, cookieOptionsRefresh(requestOrigin));

    return { user };
  }

  // POST /auth/verify — used by the frontend SPA (returns JSON)
  fastify.post<{ Body: { token: string } }>(
    '/verify',
    {
      config: { rateLimit: authRateLimit },
    },
    async (request, reply) => {
      const result = await verifyTokenAndAuthenticate(request.body?.token, reply, request.headers['origin']);
      if (!result) return; // error already sent

      const response: ApiSuccess<{ user: User }> = { data: result };
      return reply.code(200).send(response);
    },
  );

  // GET /auth/verify — fallback for direct links (redirects to frontend)
  fastify.get<{ Querystring: { token: string } }>(
    '/verify',
    {
      config: { rateLimit: authRateLimit },
    },
    async (request, reply) => {
      const result = await verifyTokenAndAuthenticate(request.query.token, reply, request.headers['origin']);
      if (!result) return; // error already sent

      const redirectUrl = result.user.onboardingComplete
        ? `${config.appUrl}/app/dashboard`
        : `${config.appUrl}/app/onboarding`;

      return reply.redirect(redirectUrl);
    },
  );

  // POST /auth/refresh
  // requireCsrf prevents cross-site token rotation abuse (which could trigger reuse
  // detection on the legitimate client's next refresh, forcing a logout).
  fastify.post('/refresh', {
    config: { rateLimit: refreshRateLimit },
    preHandler: [requireCsrf],
  }, async (request, reply) => {
    const refreshTokenJwt = request.cookies['conduit_refresh'];

    if (!refreshTokenJwt) {
      const error: ApiError = {
        error: 'Unauthorized',
        message: 'Refresh token is required',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    const payload = verifyToken<RefreshJWTPayload>(refreshTokenJwt, config.jwtRefreshSecret, JWT_AUDIENCE_REFRESH);
    if (!payload) {
      const error: ApiError = {
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    const db = fastify.db;
    const tokenHash = hashToken(refreshTokenJwt);

    const storedToken = db.query(`
      SELECT id, token_hash, user_id, family_id, used_at, revoked_at, expires_at
      FROM refresh_tokens
      WHERE token_hash = ?
    `).get(tokenHash) as {
      id: string;
      token_hash: string;
      user_id: string;
      family_id: string;
      used_at: string | null;
      revoked_at: string | null;
      expires_at: string;
    } | undefined;

    if (!storedToken) {
      const error: ApiError = {
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    // Check if revoked
    if (storedToken.revoked_at) {
      const error: ApiError = {
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    // REUSE DETECTION with grace window.
    // If a token was already used, check how long ago. Within REFRESH_REUSE_GRACE_SECONDS
    // we treat it as a benign multi-tab race: look up the new token that was already
    // issued for this family and re-return it (or simply issue a fresh pair).
    // Outside the grace window, assume token theft and revoke the entire family.
    if (storedToken.used_at) {
      const usedAtMs = new Date(storedToken.used_at).getTime();
      const nowMs = Date.now();
      const secondsSinceUse = (nowMs - usedAtMs) / 1000;

      if (secondsSinceUse <= REFRESH_REUSE_GRACE_SECONDS) {
        // Benign race — find the most recent valid token in this family and re-issue
        // a fresh access token for the same user without consuming the new refresh token.
        const userRow = db.query('SELECT * FROM users WHERE id = ?').get(storedToken.user_id) as Record<string, unknown> | undefined;
        if (!userRow) {
          const error: ApiError = { error: 'Unauthorized', message: 'User not found', statusCode: 401 };
          return reply.code(401).send(error);
        }
        const user = mapUserRow(userRow);
        const newAccessToken = createAccessToken(
          { sub: user.id, email: user.email },
          config.jwtSecret,
        );
        // Re-issue a brand-new refresh token so this tab now has a fresh one
        const newRefreshTokenJwt = createRefreshToken(
          { sub: user.id, family: storedToken.family_id },
          config.jwtRefreshSecret,
        );
        const newRefreshId = generateId();
        const newRefreshHash = hashToken(newRefreshTokenJwt);
        const newRefreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
        db.query(`
          INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(newRefreshId, newRefreshHash, user.id, storedToken.family_id, newRefreshExpires);

        reply.setCookie('conduit_access', newAccessToken, cookieOptionsAccess(request.headers['origin']));
        reply.setCookie('conduit_refresh', newRefreshTokenJwt, cookieOptionsRefresh(request.headers['origin']));

        const response: ApiSuccess<{ user: User }> = { data: { user } };
        return reply.code(200).send(response);
      }

      // Outside grace window — genuine reuse, revoke family
      db.query(`
        UPDATE refresh_tokens
        SET revoked_at = datetime('now')
        WHERE family_id = ? AND revoked_at IS NULL
      `).run(storedToken.family_id);

      reply.clearCookie('conduit_access', { path: '/' });
      reply.clearCookie('conduit_refresh', { path: '/auth/refresh' });

      const error: ApiError = {
        error: 'Unauthorized',
        message: 'Token reuse detected. All sessions in this family have been revoked.',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    // Mark current refresh token as used — atomic: only succeeds if not already consumed.
    // This prevents TOCTOU race conditions where two concurrent refresh requests
    // could both read used_at = NULL and both proceed to issue new token pairs.
    const markResult = db.query(`
      UPDATE refresh_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL
    `).run(storedToken.id);
    if ((markResult as { changes: number }).changes === 0) {
      // Another concurrent request already consumed this token — treat as benign race
      // within the grace window, or revoke if outside it.
      const error: ApiError = { error: 'Unauthorized', message: 'Invalid or expired refresh token', statusCode: 401 };
      return reply.code(401).send(error);
    }

    // Get user
    const userRow = db.query('SELECT * FROM users WHERE id = ?').get(storedToken.user_id) as Record<string, unknown> | undefined;
    if (!userRow) {
      const error: ApiError = {
        error: 'Unauthorized',
        message: 'User not found',
        statusCode: 401,
      };
      return reply.code(401).send(error);
    }

    const user = mapUserRow(userRow);

    // Issue new token pair (same family)
    const newAccessToken = createAccessToken(
      { sub: user.id, email: user.email },
      config.jwtSecret,
    );
    const newRefreshTokenJwt = createRefreshToken(
      { sub: user.id, family: storedToken.family_id },
      config.jwtRefreshSecret,
    );

    const newRefreshId = generateId();
    const newRefreshHash = hashToken(newRefreshTokenJwt);
    const newRefreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
    db.query(`
      INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(newRefreshId, newRefreshHash, user.id, storedToken.family_id, newRefreshExpires);

    reply.setCookie('conduit_access', newAccessToken, cookieOptionsAccess(request.headers['origin']));
    reply.setCookie('conduit_refresh', newRefreshTokenJwt, cookieOptionsRefresh(request.headers['origin']));

    const response: ApiSuccess<{ user: User }> = {
      data: { user },
    };
    return reply.code(200).send(response);
  });

  // POST /auth/logout
  // requireCsrf prevents cross-site logout (denial-of-service via forced session termination).
  fastify.post('/logout', { preHandler: [requireAuth, requireCsrf], config: { rateLimit: apiWriteRateLimit } }, async (request, reply) => {
    const db = fastify.db;

    // Revoke current access token
    const accessToken = request.cookies['conduit_access'];
    if (accessToken) {
      const accessHash = hashToken(accessToken);
      const payload = verifyToken<JWTPayload>(accessToken, config.jwtSecret);
      const expiresAt = payload
        ? new Date(payload.exp * 1000).toISOString()
        : new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString();

      db.query(`
        INSERT OR IGNORE INTO revoked_access_tokens (token_hash, expires_at)
        VALUES (?, ?)
      `).run(accessHash, expiresAt);
    }

    // Revoke refresh token family
    const refreshTokenJwt = request.cookies['conduit_refresh'];
    if (refreshTokenJwt) {
      const refreshHash = hashToken(refreshTokenJwt);
      const storedToken = db.query(
        'SELECT family_id FROM refresh_tokens WHERE token_hash = ?',
      ).get(refreshHash) as { family_id: string } | undefined;

      if (storedToken) {
        db.query(`
          UPDATE refresh_tokens
          SET revoked_at = datetime('now')
          WHERE family_id = ? AND revoked_at IS NULL
        `).run(storedToken.family_id);
      }
    }

    reply.clearCookie('conduit_access', { path: '/' });
    reply.clearCookie('conduit_refresh', { path: '/auth/refresh' });

    const response: ApiSuccess<{ message: string }> = {
      data: { message: 'Logged out successfully' },
    };
    return reply.code(200).send(response);
  });

  // GET /auth/me
  fastify.get('/me', { preHandler: [requireAuth], config: { rateLimit: apiReadRateLimit } }, async (request, reply) => {
    const db = fastify.db;
    const userRow = db.query('SELECT * FROM users WHERE id = ?').get(request.user!.id) as Record<string, unknown> | undefined;

    if (!userRow) {
      const error: ApiError = {
        error: 'Not Found',
        message: 'User not found',
        statusCode: 404,
      };
      return reply.code(404).send(error);
    }

    const user = mapUserRow(userRow);
    const response: ApiSuccess<{ user: User }> = {
      data: { user },
    };
    return reply.code(200).send(response);
  });

  // POST /auth/device/approve — approve a pending device flow session.
  // Requires the user to be logged in (JWT cookie). Takes a user code (XXXX-XXXX),
  // generates a new hook token for the user, and marks the session as approved.
  fastify.post<{ Body: { userCode?: string } }>(
    '/device/approve',
    { preHandler: [requireAuth], config: { rateLimit: apiWriteRateLimit } },
    async (request, reply) => {
      const rawCode = request.body?.userCode;
      if (!rawCode || typeof rawCode !== 'string') {
        const error: ApiError = {
          error: 'Validation Error',
          message: 'userCode is required',
          statusCode: 400,
        };
        return reply.code(400).send(error);
      }

      // Normalize: uppercase and strip dashes (stored raw without dash)
      const normalized = rawCode.toUpperCase().replace(/-/g, '');

      const db = fastify.db;
      const userId = request.user!.id;

      // Generate a new hook token BEFORE the atomic UPDATE so it can be committed atomically.
      const newToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(newToken).digest('hex');
      const tokenPrefix = newToken.slice(0, 8);

      // Atomic UPDATE: acts as the gate against both double-approval (TOCTOU) and
      // brute-force (attempt_count < 10). Only one concurrent request will get changes = 1.
      // Increment attempt_count on every attempt regardless of outcome (done below).
      const approveResult = db.query(
        `UPDATE device_flow_sessions
         SET approved = 1, user_id = ?, hook_token = ?
         WHERE user_code = ? AND approved = 0 AND expires_at > datetime('now') AND attempt_count < 10`,
      ).run(userId, newToken, normalized) as { changes: number };

      // Always increment the attempt counter so brute-force attempts are bounded.
      db.query(
        `UPDATE device_flow_sessions SET attempt_count = attempt_count + 1 WHERE user_code = ?`,
      ).run(normalized);

      if (approveResult.changes === 0) {
        const error: ApiError = {
          error: 'Not Found',
          message: 'Invalid or expired code',
          statusCode: 404,
        };
        return reply.code(404).send(error);
      }

      // INSERT the hook token only after we know we won the atomic UPDATE race.
      // SQLite serializes writes so no second approval can slip through between these two statements.
      db.query(
        `INSERT INTO hook_tokens (id, user_id, token_hash, token_prefix) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), userId, tokenHash, tokenPrefix);

      return reply.code(200).send({ ok: true });
    },
  );

  // DELETE /auth/account — permanently delete the user's account and all associated data
  fastify.delete('/account', { preHandler: [requireAuth], config: { rateLimit: apiWriteRateLimit } }, async (request, reply) => {
    const db = fastify.db;
    const userId = request.user!.id;
    const userEmail = request.user!.email;

    // SECURITY: Wrap all deletions in a transaction to ensure atomicity.
    // Without a transaction, a crash mid-way could leave orphaned data or
    // a user row without its associated data.
    db.transaction(() => {
      // Delete all user-specific auth data
      db.query('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
      db.query('DELETE FROM magic_link_tokens WHERE email = ?').run(userEmail);
      db.query('DELETE FROM oauth_connections WHERE user_id = ?').run(userId);
      db.query('DELETE FROM hook_tokens WHERE user_id = ?').run(userId);
      db.query('DELETE FROM device_flow_sessions WHERE user_id = ?').run(userId);
      db.query('DELETE FROM revoked_access_tokens WHERE expires_at <= datetime("now")').run(); // best-effort; they expire anyway

      // Delete pending_prompts scoped to this user's instances via hook_events.
      // pending_prompts.session_id → hook_events.session_id → hook_events.instance_id → instances.user_id
      // Must run BEFORE hook_events are deleted (subquery depends on them).
      db.query(`
        DELETE FROM pending_prompts
        WHERE session_id IN (
          SELECT DISTINCT session_id FROM hook_events
          WHERE instance_id IN (SELECT id FROM instances WHERE user_id = ?)
        )
      `).run(userId);

      // Delete all application data scoped to this user's instances
      db.query(`DELETE FROM hook_events WHERE instance_id IN (SELECT id FROM instances WHERE user_id = ?)`).run(userId);
      db.query(`DELETE FROM config_snapshots WHERE instance_id IN (SELECT id FROM instances WHERE user_id = ?)`).run(userId);
      db.query(`DELETE FROM config_pending WHERE instance_id IN (SELECT id FROM instances WHERE user_id = ?)`).run(userId);
      db.query(`DELETE FROM metrics_snapshots WHERE instance_id IN (SELECT id FROM instances WHERE user_id = ?)`).run(userId);
      db.query(`DELETE FROM metrics_counters WHERE user_id = ?`).run(userId);
      db.query(`DELETE FROM archived_sessions WHERE user_id = ?`).run(userId);

      // Delete instances last (foreign key anchor for the above subqueries)
      db.query('DELETE FROM instances WHERE user_id = ?').run(userId);

      // Delete the user row last
      db.query('DELETE FROM users WHERE id = ?').run(userId);
    })();

    // Clear cookies
    reply.clearCookie('conduit_access', { path: '/' });
    reply.clearCookie('conduit_refresh', { path: '/auth/refresh' });

    const response: ApiSuccess<{ message: string }> = {
      data: { message: 'Account and all associated data deleted' },
    };
    return reply.code(200).send(response);
  });
}
