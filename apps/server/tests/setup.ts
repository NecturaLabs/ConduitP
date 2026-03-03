import { afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createAccessToken, createRefreshToken, generateId, hashToken } from '../src/services/auth.js';

let app: FastifyInstance;

const TEST_JWT_SECRET = 'a'.repeat(64);
const TEST_JWT_REFRESH_SECRET = 'b'.repeat(64);
const TEST_HOOK_TOKEN = 'test-hook-token-for-testing-purposes';

// Set env vars before config module is imported
process.env['JWT_SECRET'] = TEST_JWT_SECRET;
process.env['JWT_REFRESH_SECRET'] = TEST_JWT_REFRESH_SECRET;
process.env['CONDUIT_HOOK_TOKEN'] = TEST_HOOK_TOKEN;
process.env['RESEND_API_KEY'] = 'test-resend-key';
process.env['APP_URL'] = 'http://localhost:5173';

beforeEach(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    skipSecretValidation: true,
  });
  await app.ready();
});

afterEach(async () => {
  if (app) {
    await app.close();
  }
});

export function getApp(): FastifyInstance {
  return app;
}

export function getTestSecrets() {
  return {
    jwtSecret: TEST_JWT_SECRET,
    jwtRefreshSecret: TEST_JWT_REFRESH_SECRET,
    hookToken: TEST_HOOK_TOKEN,
  };
}

export function createTestUser(overrides: Record<string, unknown> = {}): {
  id: string;
  email: string;
} {
  const id = generateId();
  const email = `test-${id.slice(0, 8)}@example.com`;

  const db = app.db;
  db.prepare(`
    INSERT INTO users (id, email, display_name, use_case, onboarding_complete, trial_started_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    (overrides['id'] as string) ?? id,
    (overrides['email'] as string) ?? email,
    (overrides['display_name'] as string) ?? 'Test User',
    (overrides['use_case'] as string) ?? 'personal',
    (overrides['onboarding_complete'] as number) ?? 1,
  );

  return {
    id: (overrides['id'] as string) ?? id,
    email: (overrides['email'] as string) ?? email,
  };
}

export function createTestTokens(user: { id: string; email: string }): {
  accessToken: string;
  refreshToken: string;
  familyId: string;
} {
  const familyId = generateId();

  const accessToken = createAccessToken(
    { sub: user.id, email: user.email },
    TEST_JWT_SECRET,
  );

  const refreshToken = createRefreshToken(
    { sub: user.id, family: familyId },
    TEST_JWT_REFRESH_SECRET,
  );

  // Store refresh token in DB
  const refreshId = generateId();
  const refreshHash = hashToken(refreshToken);
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  app.db.prepare(`
    INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(refreshId, refreshHash, user.id, familyId, expires);

  return { accessToken, refreshToken, familyId };
}
