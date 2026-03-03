/**
 * Shared cookie configuration for auth tokens.
 *
 * Extracted here so both routes/auth.ts (magic link) and routes/oauth.ts
 * (GitHub/GitLab callbacks) issue cookies with identical security properties,
 * eliminating any risk of divergence between the two auth paths.
 *
 * Security properties:
 * - httpOnly: prevents JS access — XSS cannot steal tokens
 * - secure: derived from API_URL scheme — true for HTTPS, false for HTTP (dev only)
 * - sameSite: 'lax' when same registrable domain; 'none' cross-origin
 * - path-scoped refresh token: limits the cookie's exposure surface
 */

import { config } from '../config.js';

// Access token: 2 hours
export const ACCESS_TOKEN_TTL = 2 * 60 * 60; // seconds
// Refresh token: 30 days (rolling — each use re-issues a fresh 30-day token)
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // seconds

/**
 * Known multi-part second-level TLDs that require three labels to form a registrable domain.
 * e.g. "example.co.uk" → registrable = "example.co.uk" (not "co.uk").
 *
 * This list covers the most common ccTLD second-levels. For a complete PSL implementation,
 * replace this with the `tldts` or `psl` npm package.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.za', 'org.za', 'net.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.in', 'net.in', 'org.in', 'gov.in', 'edu.in',
]);

/**
 * Extract the registrable domain (eTLD+1) from a hostname.
 * Handles multi-part second-level TLDs from the MULTI_PART_TLDS set.
 * Falls back to the last two labels for unrecognised TLDs (single-level TLDs like .com).
 */
function registrableDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname; // already apex or bare hostname
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    // Three-label registrable domain: e.g. "example.co.uk"
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Determine whether the dashboard and API share the same registrable domain.
 * If same-site, we use 'lax' (stronger CSRF protection).
 * If cross-origin (different TLDs or localhost dev), fall back to 'none' (requires Secure).
 */
function deriveSameSite(): 'lax' | 'none' {
  try {
    const appHost = new URL(config.appUrl).hostname;
    const apiHost = new URL(config.apiUrl).hostname;
    if (registrableDomain(appHost) === registrableDomain(apiHost)) return 'lax';
  } catch {
    // Malformed URLs — safest to fall back to 'none'
  }
  return 'none';
}

export const COOKIE_SAME_SITE = deriveSameSite();

/**
 * Derive a shared cookie domain so cookies set by the API are readable by the
 * frontend after the OAuth redirect (e.g. api.conduit.example.com → conduit.example.com).
 * Returns '.registrable-domain' (dot-prefixed) when app and API share the same
 * registrable domain, undefined otherwise (cookie stays scoped to the API host).
 */
function deriveCookieDomain(): string | undefined {
  try {
    const appHost = new URL(config.appUrl).hostname;
    const apiHost = new URL(config.apiUrl).hostname;
    const appReg = registrableDomain(appHost);
    const apiReg = registrableDomain(apiHost);
    if (appReg === apiReg && appReg !== 'localhost') return `.${appReg}`;
  } catch {
    // ignore
  }
  return undefined;
}

export const COOKIE_DOMAIN = deriveCookieDomain();

/**
 * Derive `Secure` flag from the API URL scheme.
 * In production, config.ts enforces https:// for API_URL, so this is always `true`.
 * In development (HTTP), `Secure` must be `false` or browsers silently reject Set-Cookie.
 */
export const COOKIE_SECURE = config.apiUrl.startsWith('https://');

/**
 * Resolve the effective SameSite value for a given request origin.
 * Capacitor Android sends requests from 'capacitor://localhost' or 'https://localhost'.
 * SameSite=none requires Secure=true — neither holds for capacitor://, so we
 * force 'lax' for Capacitor origins regardless of domain derivation.
 */
export function resolveSameSite(requestOrigin: string | undefined): 'lax' | 'none' {
  if (!requestOrigin) return COOKIE_SAME_SITE;
  if (config.capacitorOrigins.includes(requestOrigin)) return 'lax';
  return COOKIE_SAME_SITE;
}

export function cookieOptionsAccess(requestOrigin: string | undefined) {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: resolveSameSite(requestOrigin),
    path: '/',
    maxAge: ACCESS_TOKEN_TTL,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  } as const;
}

export function cookieOptionsRefresh(requestOrigin: string | undefined) {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: resolveSameSite(requestOrigin),
    path: '/auth/refresh',
    maxAge: REFRESH_TOKEN_TTL,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  } as const;
}
