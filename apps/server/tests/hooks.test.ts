import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { getApp, getTestSecrets } from './setup.js';
import type { HookPayload, HookResponse } from '@conduit/shared';

function createValidHookRequest(hookToken: string, payload: HookPayload) {
  const timestamp = Date.now().toString();
  const rawBody = JSON.stringify(payload);
  const signingData = `${timestamp}.${rawBody}`;
  const signature = createHmac('sha256', hookToken).update(signingData).digest('hex');

  return {
    payload,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${hookToken}`,
      'X-Conduit-Timestamp': timestamp,
      'X-Conduit-Signature': signature,
    },
  };
}

const samplePayload: HookPayload = {
  event: 'SessionStart',
  timestamp: new Date().toISOString(),
  sessionId: 'session-abc-123',
  data: { tool: 'bash', args: { command: 'ls' } },
};

describe('Hooks Routes', () => {
   describe('POST /api/hooks', () => {
     it('should accept a valid webhook with correct bearer + HMAC + timestamp', async () => {
       const app = getApp();
       const { hookToken } = getTestSecrets();
       const { payload, headers } = createValidHookRequest(hookToken, samplePayload);

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
        payload,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as HookResponse;
      expect(body.received).toBe(true);
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe('string');

      // Verify event was stored in DB
      const event = app.db.prepare(
        'SELECT * FROM hook_events WHERE id = ?',
      ).get(body.id) as Record<string, unknown>;
      expect(event).toBeDefined();
      expect(event['event_type']).toBe('SessionStart');
      expect(event['session_id']).toBe('session-abc-123');
    });

    it('should reject request with invalid bearer token', async () => {
      const app = getApp();
      const timestamp = Date.now().toString();
      const rawBody = JSON.stringify(samplePayload);
      const signingData = `${timestamp}.${rawBody}`;
      const { hookToken } = getTestSecrets();
      const signature = createHmac('sha256', hookToken).update(signingData).digest('hex');

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
         payload: samplePayload,
         headers: {
           'Content-Type': 'application/json',
           'Authorization': 'Bearer wrong-token',
          'X-Conduit-Timestamp': timestamp,
          'X-Conduit-Signature': signature,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('authorization');
    });

    it('should reject request with missing bearer token', async () => {
      const app = getApp();
      const timestamp = Date.now().toString();
      const { hookToken } = getTestSecrets();
      const rawBody = JSON.stringify(samplePayload);
      const signature = createHmac('sha256', hookToken).update(`${timestamp}.${rawBody}`).digest('hex');

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
         payload: samplePayload,
         headers: {
           'Content-Type': 'application/json',
           'X-Conduit-Timestamp': timestamp,
           'X-Conduit-Signature': signature,
         },
       });

       expect(res.statusCode).toBe(401);
     });

     it('should reject request with invalid HMAC signature', async () => {
       const app = getApp();
       const { hookToken } = getTestSecrets();
       const timestamp = Date.now().toString();

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
        payload: samplePayload,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hookToken}`,
          'X-Conduit-Timestamp': timestamp,
          'X-Conduit-Signature': 'deadbeef'.repeat(8),
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('signature');
    });

    it('should reject request with expired timestamp (>5 min)', async () => {
      const app = getApp();
      const { hookToken } = getTestSecrets();
      const expiredTimestamp = (Date.now() - 6 * 60 * 1000).toString(); // 6 minutes ago
      const rawBody = JSON.stringify(samplePayload);
      const signingData = `${expiredTimestamp}.${rawBody}`;
      const signature = createHmac('sha256', hookToken).update(signingData).digest('hex');

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
         payload: samplePayload,
         headers: {
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${hookToken}`,
           'X-Conduit-Timestamp': expiredTimestamp,
           'X-Conduit-Signature': signature,
         },
       });

       expect(res.statusCode).toBe(401);
       expect(res.json().message).toContain('timestamp');
     });

     it('should reject request with future timestamp (>5 min)', async () => {
       const app = getApp();
       const { hookToken } = getTestSecrets();
       const futureTimestamp = (Date.now() + 6 * 60 * 1000).toString(); // 6 minutes in the future
       const rawBody = JSON.stringify(samplePayload);
       const signingData = `${futureTimestamp}.${rawBody}`;
       const signature = createHmac('sha256', hookToken).update(signingData).digest('hex');

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
        payload: samplePayload,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hookToken}`,
          'X-Conduit-Timestamp': futureTimestamp,
          'X-Conduit-Signature': signature,
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject request with missing timestamp', async () => {
      const app = getApp();
      const { hookToken } = getTestSecrets();

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
         payload: samplePayload,
         headers: {
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${hookToken}`,
           'X-Conduit-Signature': 'doesnotmatter',
         },
       });

       expect(res.statusCode).toBe(401);
       expect(res.json().message).toContain('Timestamp');
     });

     it('should reject request with missing signature', async () => {
       const app = getApp();
       const { hookToken } = getTestSecrets();
       const timestamp = Date.now().toString();

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
        payload: samplePayload,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${hookToken}`,
          'X-Conduit-Timestamp': timestamp,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Signature');
    });

    it('should reject invalid payload schema', async () => {
      const app = getApp();
      const { hookToken } = getTestSecrets();
      const invalidPayload = { event: 'InvalidEvent', sessionId: 123 };
      const timestamp = Date.now().toString();
      const rawBody = JSON.stringify(invalidPayload);
      const signingData = `${timestamp}.${rawBody}`;
      const signature = createHmac('sha256', hookToken).update(signingData).digest('hex');

       const res = await app.inject({
         method: 'POST',
         url: '/hooks',
         payload: invalidPayload,
         headers: {
           'Content-Type': 'application/json',
           'Authorization': `Bearer ${hookToken}`,
           'X-Conduit-Timestamp': timestamp,
           'X-Conduit-Signature': signature,
         },
       });

       expect(res.statusCode).toBe(400);
     });

     it('should store multiple events independently', async () => {
       const app = getApp();
       const { hookToken } = getTestSecrets();

       const payloads: HookPayload[] = [
         { event: 'SessionStart', timestamp: new Date().toISOString(), sessionId: 'sess-1', data: {} },
         { event: 'PreToolUse', timestamp: new Date().toISOString(), sessionId: 'sess-1', data: { tool: 'read' } },
         { event: 'PostToolUse', timestamp: new Date().toISOString(), sessionId: 'sess-1', data: { tool: 'read' } },
       ];

       const ids: string[] = [];

       for (const payload of payloads) {
         const { headers } = createValidHookRequest(hookToken, payload);
         const res = await app.inject({
           method: 'POST',
           url: '/hooks',
          payload,
          headers,
        });
        expect(res.statusCode).toBe(200);
        ids.push(res.json().id);
      }

      // Verify all 3 events stored with unique IDs
      const events = app.db.prepare(
        'SELECT id FROM hook_events ORDER BY received_at',
      ).all() as Array<{ id: string }>;
      expect(events.length).toBe(3);
      expect(new Set(events.map(e => e.id)).size).toBe(3);
    });
  });
});
