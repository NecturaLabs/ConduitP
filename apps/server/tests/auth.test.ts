import { describe, it, expect } from 'vitest';
import { getApp, createTestUser, createTestTokens, getTestSecrets } from './setup.js';
import {
  generateMagicLinkToken,
  verifyMagicLinkToken,
  hashToken,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  generateId,
} from '../src/services/auth.js';
import type { JWTPayload, RefreshJWTPayload } from '@conduit/shared';

describe('Auth Service', () => {
  describe('Magic Link Token', () => {
    it('should generate a token with raw and hash', () => {
      const { raw, hash } = generateMagicLinkToken();
      expect(raw).toHaveLength(64); // 32 bytes hex
      expect(hash).toHaveLength(64); // SHA-256 hex
      expect(raw).not.toBe(hash);
    });

    it('should verify a valid token against its hash', () => {
      const { raw, hash } = generateMagicLinkToken();
      expect(verifyMagicLinkToken(raw, hash)).toBe(true);
    });

    it('should reject an invalid token', () => {
      const { hash } = generateMagicLinkToken();
      const { raw: wrongRaw } = generateMagicLinkToken();
      expect(verifyMagicLinkToken(wrongRaw, hash)).toBe(false);
    });
  });

  describe('JWT Access Token', () => {
    it('should create and verify an access token', () => {
      const { jwtSecret } = getTestSecrets();
      const token = createAccessToken({ sub: 'user-123', email: 'test@example.com' }, jwtSecret);
      const payload = verifyToken<JWTPayload>(token, jwtSecret);

      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user-123');
      expect(payload!.email).toBe('test@example.com');
      expect(payload!.exp - payload!.iat).toBe(15 * 60);
    });

    it('should reject a token with wrong secret', () => {
      const { jwtSecret } = getTestSecrets();
      const token = createAccessToken({ sub: 'user-123', email: 'test@example.com' }, jwtSecret);
      const payload = verifyToken<JWTPayload>(token, 'wrong-secret'.padEnd(64, 'x'));
      expect(payload).toBeNull();
    });

    it('should reject a tampered token', () => {
      const { jwtSecret } = getTestSecrets();
      const token = createAccessToken({ sub: 'user-123', email: 'test@example.com' }, jwtSecret);
      const parts = token.split('.');
      // Tamper with the payload
      const tampered = `${parts[0]}.${Buffer.from('{"sub":"hacker","email":"hack@evil.com","iat":0,"exp":9999999999}').toString('base64url')}.${parts[2]}`;
      const payload = verifyToken<JWTPayload>(tampered, jwtSecret);
      expect(payload).toBeNull();
    });
  });

  describe('JWT Refresh Token', () => {
     it('should create and verify a refresh token', () => {
       const { jwtRefreshSecret } = getTestSecrets();
       const familyId = generateId();
       const token = createRefreshToken({ sub: 'user-123', family: familyId }, jwtRefreshSecret);
      const payload = verifyToken<RefreshJWTPayload>(token, jwtRefreshSecret);

      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe('user-123');
      expect(payload!.family).toBe(familyId);
      expect(payload!.exp - payload!.iat).toBe(7 * 24 * 60 * 60);
    });
  });
});

describe('Auth Routes', () => {
  describe('POST /api/auth/magic-link', () => {
    it('should return success for a valid email', async () => {
      const app = getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        payload: { email: 'user@example.com' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.message).toBe('If an account exists with that email, a magic link has been sent.');
    });

    it('should return 400 for invalid email format', async () => {
      const app = getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return identical response for non-existing email (enumeration prevention)', async () => {
      const app = getApp();
      // Create a known user
      createTestUser({ email: 'exists@example.com' });

      const res1 = await app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        payload: { email: 'exists@example.com' },
      });

      const res2 = await app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        payload: { email: 'doesnotexist@example.com' },
      });

      expect(res1.statusCode).toBe(res2.statusCode);
      expect(res1.json().message).toBe(res2.json().message);
    });
  });

  describe('GET /api/auth/verify', () => {
    it('should verify a valid token and set cookies', async () => {
      const app = getApp();
      const { raw, hash } = generateMagicLinkToken();
      const id = generateId();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      app.db.prepare(`
        INSERT INTO magic_link_tokens (id, token_hash, email, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(id, hash, 'verify@example.com', expiresAt);

       const res = await app.inject({
         method: 'GET',
         url: `/auth/verify?token=${raw}`,
      });

      expect(res.statusCode).toBe(302);
      const cookies = res.cookies;
      expect(cookies.some(c => c.name === 'conduit_access')).toBe(true);
      expect(cookies.some(c => c.name === 'conduit_refresh')).toBe(true);
    });

    it('should reject an already-used token', async () => {
      const app = getApp();
      const { raw, hash } = generateMagicLinkToken();
      const id = generateId();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      app.db.prepare(`
        INSERT INTO magic_link_tokens (id, token_hash, email, used, expires_at)
        VALUES (?, ?, ?, 1, ?)
      `).run(id, hash, 'used@example.com', expiresAt);

       const res = await app.inject({
         method: 'GET',
         url: `/auth/verify?token=${raw}`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('already been used');
    });

    it('should reject an expired token', async () => {
      const app = getApp();
      const { raw, hash } = generateMagicLinkToken();
      const id = generateId();
      const expiresAt = new Date(Date.now() - 1000).toISOString(); // Expired

      app.db.prepare(`
        INSERT INTO magic_link_tokens (id, token_hash, email, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(id, hash, 'expired@example.com', expiresAt);

       const res = await app.inject({
         method: 'GET',
         url: `/auth/verify?token=${raw}`,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('expired');
    });

     it('should reject an invalid token', async () => {
       const app = getApp();
       const res = await app.inject({
         method: 'GET',
         url: '/auth/verify?token=invalid-token-value',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should issue new tokens with rotation', async () => {
      const app = getApp();
      const user = createTestUser();
      const { refreshToken } = createTestTokens(user);

      const res = await app.inject({
         method: 'POST',
         url: '/auth/refresh',
         cookies: { conduit_refresh: refreshToken },
      });

      expect(res.statusCode).toBe(200);
      const cookies = res.cookies;
      expect(cookies.some(c => c.name === 'conduit_access')).toBe(true);
      expect(cookies.some(c => c.name === 'conduit_refresh')).toBe(true);
    });

    it('should detect refresh token reuse and revoke family', async () => {
      const app = getApp();
      const user = createTestUser();
      const { refreshToken, familyId } = createTestTokens(user);

      // First use — should succeed
       const res1 = await app.inject({
         method: 'POST',
         url: '/auth/refresh',
         cookies: { conduit_refresh: refreshToken },
      });
      expect(res1.statusCode).toBe(200);

      // Second use of same token — should detect reuse and revoke family
       const res2 = await app.inject({
         method: 'POST',
         url: '/auth/refresh',
         cookies: { conduit_refresh: refreshToken },
      });
      expect(res2.statusCode).toBe(401);
      expect(res2.json().message).toContain('reuse detected');

      // Verify all tokens in family are revoked
      const familyTokens = app.db.prepare(
        'SELECT revoked_at FROM refresh_tokens WHERE family_id = ?',
      ).all(familyId) as Array<{ revoked_at: string | null }>;

      for (const token of familyTokens) {
        expect(token.revoked_at).not.toBeNull();
      }
    });

     it('should reject request without refresh cookie', async () => {
       const app = getApp();
       const res = await app.inject({
         method: 'POST',
         url: '/auth/refresh',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should revoke tokens and clear cookies', async () => {
      const app = getApp();
      const user = createTestUser();
      const { accessToken, refreshToken } = createTestTokens(user);

       const res = await app.inject({
         method: 'POST',
         url: '/auth/logout',
         cookies: {
          conduit_access: accessToken,
          conduit_refresh: refreshToken,
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify access token is revoked
      const accessHash = hashToken(accessToken);
      const revoked = app.db.prepare(
        'SELECT 1 FROM revoked_access_tokens WHERE token_hash = ?',
      ).get(accessHash);
      expect(revoked).toBeDefined();
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user profile for authenticated request', async () => {
      const app = getApp();
      const user = createTestUser();
      const { accessToken } = createTestTokens(user);

       const res = await app.inject({
         method: 'GET',
         url: '/auth/me',
         cookies: { conduit_access: accessToken },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.user.id).toBe(user.id);
      expect(body.data.user.email).toBe(user.email);
    });

    it('should return 401 without access token', async () => {
      const app = getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
