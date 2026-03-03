import type { ApiError } from '@conduit/shared';
import { useAuthStore } from '@/store/auth';

const STORAGE_KEY = 'conduit_server_url';
const DEFAULT_SERVER = '';

export const isMobile = Boolean(import.meta.env.VITE_MOBILE);

export function getStoredServerUrl(): string {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SERVER;
}

export function setStoredServerUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url.trim().replace(/\/$/, ''));
}

/** Resolved per-request so URL changes take effect immediately without reload. */
export function resolveBaseUrl(): string {
  if (isMobile) {
    return getStoredServerUrl();
  }
  return import.meta.env.VITE_API_URL ?? '/api';
}

// Keep BASE_URL as a non-null export for the rare direct usages (tryRefresh, etc.)
// In mobile mode it resolves dynamically; in web mode it's a build-time constant.
export const BASE_URL = isMobile ? DEFAULT_SERVER : (import.meta.env.VITE_API_URL ?? '/api');

class ApiClientError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function parseError(res: Response): Promise<ApiClientError> {
  try {
    const body = (await res.json()) as ApiError;
    return new ApiClientError(body.statusCode, body.error, body.message);
  } catch {
    return new ApiClientError(res.status, res.statusText, 'An unexpected error occurred');
  }
}

/**
 * Result of a token refresh attempt.
 * - 'refreshed'  — new tokens issued, retry the original request.
 * - 'expired'    — server definitively rejected (401/403). Session is gone, log out.
 * - 'error'      — transient failure (network, 429, 5xx). Do NOT log out; just retry later.
 */
export type RefreshResult = 'refreshed' | 'expired' | 'error';

let refreshPromise: Promise<RefreshResult> | null = null;

/**
 * Attempt to refresh the access token. Coalesces concurrent calls so only one
 * request is in-flight at a time. Shared by both the fetch-based API client and
 * the SSE hook to prevent duplicate refresh requests that trigger reuse detection.
 *
 * Returns a tri-state result so callers can distinguish definitive auth failure
 * (→ logout) from transient network / rate-limit errors (→ retry with backoff).
 */
export async function tryRefresh(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${resolveBaseUrl()}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.ok) return 'refreshed';
      // 401/403 = definitive auth failure (token revoked, expired, invalid)
      if (res.status === 401 || res.status === 403) return 'expired';
      // 429 (rate-limited), 5xx (server error) = transient
      return 'error';
    } catch {
      // Network error, DNS failure, etc. — NOT an auth failure
      return 'error';
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retry = true,
): Promise<T> {
  const url = `${resolveBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiClientError(503, 'Service Unavailable', 'Unable to reach the server. Please check your connection and try again.');
  }

  if (res.status === 401 && retry) {
    const result = await tryRefresh();
    if (result === 'refreshed') {
      return request<T>(method, path, body, false);
    }
    if (result === 'expired') {
      // Refresh definitively failed (401/403) — session is gone. Clear
      // persisted auth state so ProtectedRoute redirects to /auth.
      useAuthStore.getState().clearUser();
      throw new ApiClientError(401, 'Unauthorized', 'Session expired. Please log in again.');
    }
    // Transient error (network, rate-limit, server error). Don't log out —
    // surface the error so the UI can show a retry message.
    throw new ApiClientError(503, 'Service Unavailable', 'Unable to reach the server. Please check your connection and try again.');
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  const json = await res.json();

  // Backend wraps successful responses in ApiSuccess<T> = { data: T, meta? }.
  // Unwrap automatically so consumers get T directly.
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }

  return json as T;
}

export const api = {
  get<T>(path: string) {
    return request<T>('GET', path);
  },
  post<T>(path: string, body?: unknown) {
    return request<T>('POST', path, body);
  },
  /** POST without triggering token refresh on 401 — for public/unauthenticated endpoints. */
  postPublic<T>(path: string, body?: unknown) {
    return request<T>('POST', path, body, false);
  },
  patch<T>(path: string, body?: unknown) {
    return request<T>('PATCH', path, body);
  },
  delete<T>(path: string) {
    return request<T>('DELETE', path);
  },
};

export { ApiClientError };
