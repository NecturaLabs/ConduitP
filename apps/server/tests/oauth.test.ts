/**
 * OAuth service + route tests.
 *
 * Covers:
 * - generateOAuthState() correctness
 * - generateCodeVerifier() format compliance (RFC 7636)
 * - deriveCodeChallenge() S256 correctness against RFC 7636 Appendix B test vector
 * - GET /auth/oauth/providers — reflects config
 * - GET /auth/oauth/:provider/start — creates DB row, redirects with PKCE params
 * - GET /auth/oauth/:provider/start — 503 when provider not configured
 * - GET /auth/oauth/:provider/callback — invalid state → error redirect
 * - GET /auth/oauth/:provider/callback — expired state → error redirect
 * - GET /auth/oauth/:provider/callback — reused state → error redirect (TOCTOU)
 * - GET /auth/oauth/:provider/callback — provider error param → error redirect
 * - GET /auth/oauth/:provider/callback — valid flow, new user created
 * - GET /auth/oauth/:provider/callback — valid flow, existing user (by email) linked
 * - GET /auth/oauth/:provider/callback — returning OAuth user, no duplicate rows
 * - Account deletion removes oauth_connections
 */

import { describe, it, expect, vi } from 'vitest';
import { getApp, createTestUser, createTestTokens } from './setup.js';
import {
  generateOAuthState,
  generateCodeVerifier,
  deriveCodeChallenge,
} from '../src/services/oauth.js';
import { hashToken, generateId } from '../src/services/auth.js';

// ---------------------------------------------------------------------------
// OAuth Service unit tests
// ---------------------------------------------------------------------------

describe('OAuth Service', () => {
  describe('generateOAuthState()', () => {
    it('returns a 64-char hex raw value and a 64-char hex hash', () => {
      const { raw, hash } = generateOAuthState();
      expect(raw).toHaveLength(64);
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(raw)).toBe(true);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });

    it('raw and hash are different', () => {
      const { raw, hash } = generateOAuthState();
      expect(raw).not.toBe(hash);
    });

    it('hash is the SHA-256 of raw', () => {
      const { raw, hash } = generateOAuthState();
      expect(hashToken(raw)).toBe(hash);
    });

    it('generates unique values on each call', () => {
      const a = generateOAuthState();
      const b = generateOAuthState();
      expect(a.raw).not.toBe(b.raw);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('generateCodeVerifier()', () => {
    it('produces a 43-character base64url string (RFC 7636 §4.1 minimum)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toHaveLength(43);
    });

    it('contains only base64url characters (A-Z a-z 0-9 - _)', () => {
      const verifier = generateCodeVerifier();
      expect(/^[A-Za-z0-9\-_]+$/.test(verifier)).toBe(true);
    });

    it('generates unique values on each call', () => {
      expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    });
  });

  describe('deriveCodeChallenge()', () => {
    // RFC 7636 Appendix B test vector:
    // code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // expected S256 challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    it('produces the correct S256 challenge for the RFC 7636 test vector', () => {
      const verifier  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = deriveCodeChallenge(verifier);
      expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('produces a base64url string without padding', () => {
      const challenge = deriveCodeChallenge(generateCodeVerifier());
      expect(challenge.includes('=')).toBe(false);
      expect(/^[A-Za-z0-9\-_]+$/.test(challenge)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// OAuth Routes integration tests
// ---------------------------------------------------------------------------

describe('OAuth Routes', () => {
  describe('GET /api/auth/oauth/providers', () => {
     it('returns github: false and gitlab: false when no providers are configured', async () => {
       const app = getApp();
       const res = await app.inject({ method: 'GET', url: '/auth/oauth/providers' });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { github: boolean; gitlab: boolean };
      // In the test environment no OAuth env vars are set
      expect(body.github).toBe(false);
      expect(body.gitlab).toBe(false);
    });
  });

   describe('GET /api/auth/oauth/:provider/start', () => {
     it('returns 503 for github when not configured', async () => {
       const app = getApp();
       const res = await app.inject({ method: 'GET', url: '/auth/oauth/github/start' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('OAuthNotConfigured');
    });

     it('returns 503 for gitlab when not configured', async () => {
       const app = getApp();
       const res = await app.inject({ method: 'GET', url: '/auth/oauth/gitlab/start' });
      expect(res.statusCode).toBe(503);
    });

     it('redirects to invalid_provider error for an unknown provider', async () => {
       const app = getApp();
       const res = await app.inject({ method: 'GET', url: '/auth/oauth/unknown/start' });
      // Redirects to frontend error page
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=invalid_provider');
    });

    it('creates an oauth_states row and redirects to provider when configured', async () => {
      const app = getApp();

      // Temporarily inject GitHub credentials into config for this test
      const { config } = await import('../src/config.js');
      const origId     = config.githubClientId;
      const origSecret = config.githubClientSecret;
      config.githubClientId     = 'test-client-id';
      config.githubClientSecret = 'test-client-secret';

       try {
         const res = await app.inject({ method: 'GET', url: '/auth/oauth/github/start' });
         expect(res.statusCode).toBe(302);

        const location = res.headers['location'] as string;
        expect(location).toContain('github.com/login/oauth/authorize');
        expect(location).toContain('code_challenge_method=S256');
        expect(location).toContain('code_challenge=');
        expect(location).toContain('state=');
        expect(location).toContain('scope=read%3Auser+user%3Aemail');

        // Verify the state was stored in the DB
        const stateParam = new URL(location).searchParams.get('state')!;
        const stateHash  = hashToken(stateParam);
        const row = app.db.prepare(
          'SELECT * FROM oauth_states WHERE state_hash = ?',
        ).get(stateHash) as { code_verifier: string; provider: string } | undefined;

        expect(row).toBeDefined();
        expect(row!.provider).toBe('github');
        expect(row!.code_verifier).toHaveLength(43); // PKCE verifier
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
      }
    });
  });

  describe('GET /api/auth/oauth/:provider/callback', () => {
    // Helper: insert an oauth_states row and return the raw state value
    function insertOAuthState(
      provider: 'github' | 'gitlab',
      opts: { expired?: boolean } = {},
    ): { raw: string; codeVerifier: string } {
      const app        = getApp();
      const id         = generateId();
      const raw        = 'a'.repeat(64); // predictable raw value for tests
      const stateHash  = hashToken(raw);
      const verifier   = generateCodeVerifier();
      const expiresAt  = opts.expired
        ? new Date(Date.now() - 1000).toISOString()      // already expired
        : new Date(Date.now() + 10 * 60 * 1000).toISOString(); // valid

      app.db.prepare(`
        INSERT INTO oauth_states (id, state_hash, provider, code_verifier, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, stateHash, provider, verifier, expiresAt);

      return { raw, codeVerifier: verifier };
    }

     it('redirects to invalid_state when state param is missing', async () => {
       const app = getApp();
       const res = await app.inject({
         method: 'GET',
         url:    '/auth/oauth/github/callback?code=abc123',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=invalid_state');
    });

     it('redirects to invalid_state when state does not match any DB row', async () => {
       const app = getApp();
       const res = await app.inject({
         method: 'GET',
         url:    '/auth/oauth/github/callback?code=abc123&state=nonexistent',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=invalid_state');
    });

    it('redirects to invalid_state when state is expired', async () => {
      const app = getApp();
      const { raw } = insertOAuthState('github', { expired: true });
      const res = await app.inject({
        method: 'GET',
        url:    `/api/auth/oauth/github/callback?code=abc123&state=${raw}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=invalid_state');
    });

    it('redirects to invalid_state on second use of same state (TOCTOU prevention)', async () => {
      // The first request will succeed (mocking the provider calls) and DELETE the state row.
      // The second request should find no row and return invalid_state.
      // We test the second-request case directly by not inserting a row for a known hash.
      const app = getApp();
      insertOAuthState('github');

      // Consume the state manually (simulating a prior successful callback)
      const { raw } = insertOAuthState('github');
      const stateHash = hashToken(raw);
      app.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash);

      const res = await app.inject({
        method: 'GET',
        url:    `/api/auth/oauth/github/callback?code=abc123&state=${raw}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=invalid_state');
    });

     it('redirects to provider_error when the provider sends an error param', async () => {
       const app = getApp();
       const res = await app.inject({
         method: 'GET',
         url:    '/auth/oauth/github/callback?error=access_denied',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toContain('error=provider_error');
    });

    it('redirects to provider_error when token exchange fails', async () => {
      const app         = getApp();
      const { raw }     = insertOAuthState('github');
      const { config }  = await import('../src/config.js');

      const origId      = config.githubClientId;
      const origSecret  = config.githubClientSecret;
      config.githubClientId     = 'test-id';
      config.githubClientSecret = 'test-secret';

      // Mock fetch to simulate a failed token exchange
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }),
      );

      try {
        const res = await app.inject({
          method: 'GET',
          url:    `/api/auth/oauth/github/callback?code=badcode&state=${raw}`,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toContain('error=provider_error');
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
        fetchSpy.mockRestore();
      }
    });

    it('redirects to no_verified_email when GitHub returns no verified primary email', async () => {
      const app        = getApp();
      const { raw }    = insertOAuthState('github');
      const { config } = await import('../src/config.js');

      const origId     = config.githubClientId;
      const origSecret = config.githubClientSecret;
      config.githubClientId     = 'test-id';
      config.githubClientSecret = 'test-secret';

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // First call: token exchange — success
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'gh_test_token' }), { status: 200 }),
        )
        // Second call: GET /user — success
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 12345, name: 'Test User', login: 'testuser' }), { status: 200 }),
        )
        // Third call: GET /user/emails — returns only an unverified email
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ email: 'test@example.com', primary: true, verified: false }]),
            { status: 200 },
          ),
        );

      try {
        const res = await app.inject({
          method: 'GET',
          url:    `/api/auth/oauth/github/callback?code=validcode&state=${raw}`,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toContain('error=no_verified_email');
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
        fetchSpy.mockRestore();
      }
    });

    it('creates a new user + oauth_connection for a first-time GitHub login', async () => {
      const app        = getApp();
      const { raw }    = insertOAuthState('github');
      const { config } = await import('../src/config.js');

      const origId     = config.githubClientId;
      const origSecret = config.githubClientSecret;
      config.githubClientId     = 'test-id';
      config.githubClientSecret = 'test-secret';

      const testEmail = `new-gh-user-${generateId().slice(0, 8)}@example.com`;

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'gh_test_token' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 99991, name: 'New User', login: 'newuser' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ email: testEmail, primary: true, verified: true }]),
            { status: 200 },
          ),
        );

      try {
        const res = await app.inject({
          method: 'GET',
          url:    `/api/auth/oauth/github/callback?code=validcode&state=${raw}`,
        });

        // Should redirect to onboarding (new user)
        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toContain('/app/onboarding');

        // Cookies should be set
        const cookies = res.cookies;
        expect(cookies.some((c) => c.name === 'conduit_access')).toBe(true);
        expect(cookies.some((c) => c.name === 'conduit_refresh')).toBe(true);

        // User row should exist
        const user = app.db.prepare('SELECT * FROM users WHERE email = ?').get(testEmail) as { id: string } | undefined;
        expect(user).toBeDefined();

        // oauth_connections row should exist
        const conn = app.db.prepare(
          "SELECT * FROM oauth_connections WHERE provider = 'github' AND provider_user_id = '99991'",
        ).get() as { user_id: string } | undefined;
        expect(conn).toBeDefined();
        expect(conn!.user_id).toBe(user!.id);
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
        fetchSpy.mockRestore();
      }
    });

    it('links oauth_connection to an existing magic-link account with matching email', async () => {
      const app        = getApp();
      // Pre-create a magic-link user
      const existing   = createTestUser({ email: 'existing@example.com' });
      const { raw }    = insertOAuthState('github');
      const { config } = await import('../src/config.js');

      const origId     = config.githubClientId;
      const origSecret = config.githubClientSecret;
      config.githubClientId     = 'test-id';
      config.githubClientSecret = 'test-secret';

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'gh_test_token' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 99992, name: 'Existing User', login: 'existinguser' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ email: 'existing@example.com', primary: true, verified: true }]),
            { status: 200 },
          ),
        );

      try {
        const res = await app.inject({
          method: 'GET',
          url:    `/api/auth/oauth/github/callback?code=validcode&state=${raw}`,
        });

        // Should redirect to dashboard (user already onboarded)
        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toContain('/app/dashboard');

        // No duplicate user row should have been created
        const users = app.db.prepare('SELECT * FROM users WHERE email = ?').all('existing@example.com') as unknown[];
        expect(users).toHaveLength(1);

        // oauth_connection should now link to the existing user
        const conn = app.db.prepare(
          "SELECT * FROM oauth_connections WHERE provider = 'github' AND provider_user_id = '99992'",
        ).get() as { user_id: string } | undefined;
        expect(conn).toBeDefined();
        expect(conn!.user_id).toBe(existing.id);
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
        fetchSpy.mockRestore();
      }
    });

    it('does not create duplicate rows when a returning OAuth user logs in again', async () => {
      const app        = getApp();
      const { config } = await import('../src/config.js');

      const origId     = config.githubClientId;
      const origSecret = config.githubClientSecret;
      config.githubClientId     = 'test-id';
      config.githubClientSecret = 'test-secret';

      const testEmail = `returning-${generateId().slice(0, 8)}@example.com`;
      const providerId = '99993';

      // Pre-create the user and connection (simulates a prior login)
      const userId = generateId();
      app.db.prepare(
        "INSERT INTO users (id, email, onboarding_complete, trial_started_at) VALUES (?, ?, 1, datetime('now'))",
      ).run(userId, testEmail);
      app.db.prepare(
        "INSERT INTO oauth_connections (id, user_id, provider, provider_user_id) VALUES (?, ?, 'github', ?)",
      ).run(generateId(), userId, providerId);

      const mockProviderResponse = () => vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'gh_test_token' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: Number(providerId), name: 'Returning', login: 'ret' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ email: testEmail, primary: true, verified: true }]),
            { status: 200 },
          ),
        );

      const { raw } = insertOAuthState('github');
      const fetchSpy = mockProviderResponse();

      try {
        const res = await app.inject({
          method: 'GET',
          url:    `/api/auth/oauth/github/callback?code=validcode&state=${raw}`,
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers['location']).toContain('/app/dashboard');

        // Still only one user row
        const users = app.db.prepare('SELECT * FROM users WHERE email = ?').all(testEmail) as unknown[];
        expect(users).toHaveLength(1);

        // Still only one connection row
        const conns = app.db.prepare(
          "SELECT * FROM oauth_connections WHERE provider = 'github' AND provider_user_id = ?",
        ).all(providerId) as unknown[];
        expect(conns).toHaveLength(1);
      } finally {
        config.githubClientId     = origId;
        config.githubClientSecret = origSecret;
        fetchSpy.mockRestore();
      }
    });
  });

  describe('DELETE /api/auth/account — oauth_connections cleanup', () => {
    it('removes oauth_connections when the account is deleted', async () => {
      const app  = getApp();
      const user = createTestUser({ email: 'delete-oauth@example.com' });
      const { accessToken } = createTestTokens(user);

      // Insert an oauth_connection for this user
      app.db.prepare(
        "INSERT INTO oauth_connections (id, user_id, provider, provider_user_id) VALUES (?, ?, 'github', '77777')",
      ).run(generateId(), user.id);

      // Verify it exists
      const before = app.db.prepare('SELECT * FROM oauth_connections WHERE user_id = ?').all(user.id) as unknown[];
      expect(before).toHaveLength(1);

      const res = await app.inject({
         method:  'DELETE',
         url:     '/auth/account',
         headers: {
          Cookie:            `conduit_access=${accessToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      expect(res.statusCode).toBe(200);

      // Connection should be gone
      const after = app.db.prepare('SELECT * FROM oauth_connections WHERE user_id = ?').all(user.id) as unknown[];
      expect(after).toHaveLength(0);
    });
  });
});
