import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { tryRefresh, resolveBaseUrl } from '@/lib/api';
import type { SSEEventType } from '@conduit/shared';

const MAX_RETRY_DELAY = 30_000;
const INITIAL_RETRY_DELAY = 1_000;

interface SSEHookResult {
  isConnected: boolean;
  isConfigured: boolean;
  lastEvent: { type: SSEEventType; data: unknown } | null;
  error: string | null;
  /** Force an immediate reconnect (e.g. after app comes to foreground). */
  reconnect: () => void;
  /** Close the SSE connection without scheduling a retry (e.g. app backgrounded). */
  pause: () => void;
}

type SSEHandler = (type: SSEEventType, data: unknown) => void;

export function useSSE(onEvent?: SSEHandler): SSEHookResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConfigured, setIsConfigured] = useState(true);
  const [lastEvent, setLastEvent] = useState<SSEHookResult['lastEvent']>(null);
  const [error, setError] = useState<string | null>(null);
  const retryDelay = useRef(INITIAL_RETRY_DELAY);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  const consecutiveErrors = useRef(0);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${resolveBaseUrl()}/events`, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
      retryDelay.current = INITIAL_RETRY_DELAY;
      consecutiveErrors.current = 0;
    };

    // Named SSE events (server sends `event: session.created\ndata: ...`)
    const namedEvents: SSEEventType[] = [
      'session.created',
      'session.updated',
      'session.deleted',
      'session.idle',
      'session.error',
      'session.compacting',
      'session.compacted',
      'message.created',
      'message.updated',
      'message.completed',
      'message.part.updated',
      'tool.started',
      'tool.completed',
      'tool.execute.after',
      'todo.updated',
      'mcp.tools.changed',
      'config.updated',
      'config.sync',
      'instance.updated',
      'connected',
      'heartbeat',
    ];

    for (const eventType of namedEvents) {
      es.addEventListener(eventType, (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as unknown;
          setIsConfigured(true);
          setLastEvent({ type: eventType, data: parsed });
          onEventRef.current?.(eventType, parsed);
        } catch {
          // ignore malformed events
        }
      });
    }

    // Fallback for unnamed messages
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { type: SSEEventType; data: unknown };
        if (parsed.type) {
          setIsConfigured(true);
          setLastEvent(parsed);
          onEventRef.current?.(parsed.type, parsed.data);
        }
      } catch {
        // ignore malformed events
      }
    };

    // Listen for the "not_configured" event from server
    es.addEventListener('not_configured', () => {
      setIsConfigured(false);
      setIsConnected(true);
      setError(null);
    });

    es.onerror = () => {
      setIsConnected(false);
      es.close();
      eventSourceRef.current = null;
      consecutiveErrors.current += 1;

      const scheduleReconnect = () => {
        setError('Connection lost. Reconnecting...');
        retryTimer.current = setTimeout(() => {
          retryDelay.current = Math.min(retryDelay.current * 2, MAX_RETRY_DELAY);
          connect();
        }, retryDelay.current);
      };

      // Try refreshing the access token before reconnecting.
      // Only force-logout if refresh definitively returns 'expired' (401/403).
      // Transient errors (network, rate-limit, 5xx) just trigger backoff+retry.
      tryRefresh().then((result) => {
        if (result === 'refreshed') {
          retryDelay.current = INITIAL_RETRY_DELAY;
          consecutiveErrors.current = 0;
          connect();
        } else if (result === 'expired') {
          // Server definitively said the session is gone
          setError('Session expired. Please log in again.');
          useAuthStore.getState().clearUser();
        } else {
          // Transient error — back off and retry, do NOT logout
          scheduleReconnect();
        }
      });
    };
  }, []);

  // Expose a pause handle for native app backgrounding — closes the connection
  // and cancels any pending retry without scheduling a new one.
  const pause = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
      }
    };
  }, [connect]);

  return { isConnected, isConfigured, lastEvent, error, reconnect: connect, pause };
}
