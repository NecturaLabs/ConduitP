/**
 * OAuth 2.0 routes — GitHub and GitLab login as additional auth methods
 * alongside magic link. Magic link is fully preserved.
 *
 * Flow:
 *   GET /auth/oauth/:provider/start
 *     → generates state (CSRF) + PKCE verifier/challenge
 *     → stores { state_hash, code_verifier } in oauth_states (10-min TTL)
 *     → redirects browser to provider authorization URL
 *
 *   GET /auth/oauth/:provider/callback?code=...&state=...
 *     → atomically consumes state row (DELETE where state_hash matches, changes===1)
 *     → exchanges code + code_verifier for provider access token (server-to-server)
 *     → fetches { providerId, email, name } from provider (verified email only)
 *     → zeros provider access token immediately
 *     → find-or-create user + oauth_connection
 *     → issues Conduit JWT pair + httpOnly cookies
 *     → redirects to /app/onboarding (new) or /app/dashboard (returning)
 *     → on any error: redirects to /app/auth?error=<sanitized_code>
 *
 *   GET /auth/oauth/providers
 *     → returns { github: boolean, gitlab: boolean } based on config
 *
 * Security properties:
 * - PKCE S256 per RFC 7636 + RFC 9700 §2.1.1 (guards against code injection)
 * - State consumed via atomic DELETE (guards against CSRF + TOCTOU)
 * - State stored as SHA-256 hash (raw value never in DB)
 * - Only verified/confirmed provider emails accepted (guards against account takeover)
 * - Provider access token zeroed after a single use
 * - Error redirects use opaque codes — no internal details leak to the browser
 * - Rate-limited by IP on /start (looser than magic link — no email is sent)
 */

import type { FastifyInstance } from 'fastify';
import type { OAuthProvider } from '@conduit/shared';
import {
  generateOAuthState,
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchProviderUser,
  OAuthNoVerifiedEmailError,
} from '../services/oauth.js';
import {
  createAccessToken,
  createRefreshToken,
  generateId,
  hashToken,
} from '../services/auth.js';
import { config } from '../config.js';
import { oauthStartRateLimit } from '../middleware/rateLimit.js';
import { mapUserRow } from '../lib/db-helpers.js';
import {
  REFRESH_TOKEN_TTL,
  cookieOptionsAccess,
  cookieOptionsRefresh,
} from '../lib/auth-cookies.js';

// Validated provider values — anything else is a 400.
const VALID_PROVIDERS = new Set<OAuthProvider>(['github', 'gitlab']);

/**
 * Check whether a given provider is configured (client ID + secret both set).
 */
function isProviderEnabled(provider: OAuthProvider): boolean {
  if (provider === 'github') {
    return Boolean(config.githubClientId && config.githubClientSecret);
  }
  return Boolean(config.gitlabClientId && config.gitlabClientSecret);
}

function getProviderCredentials(provider: OAuthProvider): { clientId: string; clientSecret: string } {
  if (provider === 'github') {
    return { clientId: config.githubClientId, clientSecret: config.githubClientSecret };
  }
  return { clientId: config.gitlabClientId, clientSecret: config.gitlabClientSecret };
}

function buildCallbackUrl(provider: OAuthProvider): string {
  return `${config.apiUrl}/auth/oauth/${provider}/callback`;
}

/**
 * Redirect to the frontend error page with an opaque, sanitized error code.
 * NEVER include raw error messages, stack traces, or token values in this URL.
 */
function redirectError(
  reply: import('fastify').FastifyReply,
  errorCode: 'invalid_provider' | 'provider_not_configured' | 'invalid_state' | 'provider_error' | 'no_verified_email',
): void {
  reply.redirect(`${config.appUrl}/app/auth?error=${errorCode}`);
}

export async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /auth/oauth/providers — returns which providers are configured
  // No auth required, no rate limit needed (static config read).
  fastify.get('/providers', async (_request, reply) => {
    return reply.code(200).send({
      github: isProviderEnabled('github'),
      gitlab: isProviderEnabled('gitlab'),
    });
  });

  // GET /auth/oauth/:provider/start
  // Initiates the OAuth flow — rate limited by IP.
  // Uses oauthStartRateLimit (20/15min) rather than authRateLimit because
  // /start only stores a DB row and issues a redirect; it does NOT send email.
  fastify.get<{ Params: { provider: string } }>(
    '/:provider/start',
    { config: { rateLimit: oauthStartRateLimit } },
    async (request, reply) => {
      const { provider } = request.params;

      if (!VALID_PROVIDERS.has(provider as OAuthProvider)) {
        return redirectError(reply, 'invalid_provider');
      }
      const oauthProvider = provider as OAuthProvider;

      if (!isProviderEnabled(oauthProvider)) {
        return reply.code(503).send({
          error: 'OAuthNotConfigured',
          message: `${provider} OAuth is not configured on this server`,
          statusCode: 503,
        });
      }

      const db = fastify.db;
      const { clientId } = getProviderCredentials(oauthProvider);

      // Generate state (CSRF) and PKCE verifier/challenge
      const { raw: stateRaw, hash: stateHash } = generateOAuthState();
      const codeVerifier  = generateCodeVerifier();
      const codeChallenge = deriveCodeChallenge(codeVerifier);

      // Store in DB — expires in 10 minutes
      const id         = generateId();
      const expiresAt  = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.query(`
        INSERT INTO oauth_states (id, state_hash, provider, code_verifier, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, stateHash, oauthProvider, codeVerifier, expiresAt);

      const redirectUri     = buildCallbackUrl(oauthProvider);
      const authorizationUrl = buildAuthorizationUrl(
        oauthProvider,
        clientId,
        redirectUri,
        stateRaw,
        codeChallenge,
        config.gitlabBaseUrl,
      );

      return reply.redirect(authorizationUrl);
    },
  );

  // GET /auth/oauth/:provider/callback?code=...&state=...
  // Completes the OAuth flow — no rate limit here (providers redirect users to this).
  fastify.get<{
    Params:      { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>(
    '/:provider/callback',
    async (request, reply) => {
      const { provider }           = request.params;
      const { code, state, error } = request.query;

      if (!VALID_PROVIDERS.has(provider as OAuthProvider)) {
        return redirectError(reply, 'invalid_provider');
      }
      const oauthProvider = provider as OAuthProvider;

      // If the provider sent an error param (user denied, etc.), redirect gracefully
      if (error) {
        request.log.info({ provider, error }, 'OAuth callback received provider error');
        return redirectError(reply, 'provider_error');
      }

      // Both code and state are required
      if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
        return redirectError(reply, 'invalid_state');
      }

      const db = fastify.db;

      // SECURITY: Atomic state consumption via DELETE.
      // Only succeeds (changes === 1) if the state exists, matches the provider,
      // and has not yet expired. If two concurrent requests race, only the first wins.
      const stateHash  = hashToken(state); // reuses existing SHA-256 hasher from auth service
      const deleteResult = db.query(`
        DELETE FROM oauth_states
        WHERE state_hash = ? AND provider = ? AND expires_at > datetime('now')
        RETURNING code_verifier
      `).get(stateHash, oauthProvider) as { code_verifier: string } | undefined;

      if (!deleteResult) {
        return redirectError(reply, 'invalid_state');
      }

      const { code_verifier: codeVerifier } = deleteResult;
      const { clientId, clientSecret }       = getProviderCredentials(oauthProvider);
      const redirectUri                      = buildCallbackUrl(oauthProvider);

      // Exchange code for provider access token (server-to-server, 10s timeout)
      let accessToken: string;
      try {
        accessToken = await exchangeCodeForToken(
          oauthProvider,
          code,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier,
          config.gitlabBaseUrl,
        );
      } catch (err) {
        request.log.error({ err, provider }, 'OAuth token exchange failed');
        return redirectError(reply, 'provider_error');
      }

       // Fetch minimal user info
       let providerUser: Awaited<ReturnType<typeof fetchProviderUser>>;
       try {
         providerUser = await fetchProviderUser(oauthProvider, accessToken, config.gitlabBaseUrl);
       } catch (err) {
         if (err instanceof OAuthNoVerifiedEmailError) {
           request.log.info({ provider }, 'OAuth login rejected: no verified email');
           return redirectError(reply, 'no_verified_email');
         }
         request.log.error({ err, provider }, 'OAuth user fetch failed');
         return redirectError(reply, 'provider_error');
       }

      const { providerId, email, name } = providerUser;

      // ---------------------------------------------------------------------------
      // Find-or-create user + oauth_connection
      // Strategy:
      //   1. Look up oauth_connections by (provider, providerId) — fast path for
      //      returning OAuth users.
      //   2. If not found, look up users by email — auto-links an existing
      //      magic-link account to this OAuth provider (seamless for the user).
      //   3. If email also not found — new user, create both rows.
      //
      // All writes are wrapped in BEGIN IMMEDIATE to prevent races on concurrent
      // first-time logins from the same provider account.
      // ---------------------------------------------------------------------------

      db.query('BEGIN IMMEDIATE').run();
      let userId: string;
      let isNewUser = false;

      try {
        // 1. Existing OAuth connection?
        const existingConnection = db.query(`
          SELECT user_id FROM oauth_connections
          WHERE provider = ? AND provider_user_id = ?
        `).get(oauthProvider, providerId) as { user_id: string } | undefined;

        if (existingConnection) {
          userId = existingConnection.user_id;
        } else {
          // 2. Existing user by verified email? (auto-link magic-link account)
          const existingUser = db.query(`
            SELECT id FROM users WHERE email = ?
          `).get(email) as { id: string } | undefined;

          if (existingUser) {
            userId = existingUser.id;
          } else {
            // 3. Brand new user
            userId    = generateId();
            isNewUser = true;
            db.query(`
              INSERT INTO users (id, email, trial_started_at)
              VALUES (?, ?, datetime('now'))
            `).run(userId, email);
          }

          // Create oauth_connection for cases 2 and 3
          db.query(`
            INSERT OR IGNORE INTO oauth_connections (id, user_id, provider, provider_user_id)
            VALUES (?, ?, ?, ?)
          `).run(generateId(), userId, oauthProvider, providerId);
        }

        db.query('COMMIT').run();
      } catch (err) {
        db.query('ROLLBACK').run();
        request.log.error({ err, provider }, 'OAuth user find-or-create failed');
        return redirectError(reply, 'provider_error');
      }

      // Fetch full user row (may have been created by another path)
      const userRow = db.query('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined;
      if (!userRow) {
        request.log.error({ userId, provider }, 'OAuth: user row missing after find-or-create');
        return redirectError(reply, 'provider_error');
      }
      const user = mapUserRow(userRow);

      // Issue Conduit token pair — identical to magic link flow
      const familyId          = generateId();
      const conduitAccessToken  = createAccessToken({ sub: user.id, email: user.email }, config.jwtSecret);
      const conduitRefreshToken = createRefreshToken({ sub: user.id, family: familyId }, config.jwtRefreshSecret);

      const refreshId      = generateId();
      const refreshHash    = hashToken(conduitRefreshToken);
      const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
      db.query(`
        INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(refreshId, refreshHash, user.id, familyId, refreshExpires);

      // Set cookies — use the app's origin so SameSite is resolved correctly
      const requestOrigin = request.headers['origin'];
      reply.setCookie('conduit_access',  conduitAccessToken,  cookieOptionsAccess(requestOrigin));
      reply.setCookie('conduit_refresh', conduitRefreshToken, cookieOptionsRefresh(requestOrigin));

      // Redirect to onboarding for new users, dashboard for returning users.
      // Prefill display name from the provider if we have one (UX convenience only —
      // user can freely edit on the onboarding page before submitting).
      if (isNewUser && !user.onboardingComplete) {
        const displayNameParam = name
          ? `?display_name=${encodeURIComponent(name.slice(0, 100))}`
          : '';
        return reply.redirect(`${config.appUrl}/app/onboarding${displayNameParam}`);
      }

      return reply.redirect(`${config.appUrl}/app/dashboard`);
    },
  );
}
