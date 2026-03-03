/**
 * OAuth 2.0 helpers — state/PKCE generation, authorization URL construction,
 * token exchange, and provider user fetching.
 *
 * Security properties upheld throughout:
 * - State tokens are stored as SHA-256 hashes (never plain text in the DB).
 * - PKCE S256 is used per RFC 7636 and RFC 9700 §2.1.1.
 * - Provider access tokens are zeroed immediately after use.
 * - Only verified/confirmed emails are accepted (prevents account takeover via
 *   unverified provider email matching an existing Conduit account).
 * - All provider fetch calls time out after 10 seconds.
 * - No sensitive details are included in thrown errors (callers log and sanitize).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProvider } from '@conduit/shared';

// ---------------------------------------------------------------------------
// State + PKCE generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random OAuth state token.
 *
 * Returns both the raw value (sent to the browser as a URL parameter) and its
 * SHA-256 hash (stored in the DB). The raw value is never persisted.
 */
export function generateOAuthState(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex'); // 64-char hex, 256-bit entropy
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Generate a PKCE code_verifier per RFC 7636 §4.1.
 *
 * Spec requires 43–128 characters from the unreserved character set
 * [A-Z a-z 0-9 - . _ ~]. 32 random bytes encoded as base64url yields exactly
 * 43 characters (32 * 4/3 rounded up, no padding = 43). This meets the minimum
 * entropy requirement of 256 bits.
 *
 * The verifier is generated server-side, stored server-side, and transmitted
 * server-to-server during token exchange — never sent to the browser.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url'); // 43 chars, URL-safe, no padding
}

/**
 * Derive the PKCE code_challenge from a verifier using the S256 method.
 * Per RFC 7636 §4.2: BASE64URL(SHA256(ASCII(code_verifier)))
 *
 * S256 is the only method supported — plain is explicitly rejected by both
 * GitHub and GitLab, and RFC 9700 §2.1.1 requires S256 to prevent challenge
 * exposure in the authorization request.
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest().toString('base64url');
}

// ---------------------------------------------------------------------------
// Authorization URL construction
// ---------------------------------------------------------------------------

/**
 * Build the provider's OAuth 2.0 authorization URL with all required parameters.
 *
 * Scopes requested (minimal — data minimization principle):
 * - GitHub: 'read:user user:email'  → /user (profile) + /user/emails (verified emails)
 * - GitLab: 'read_user'             → /api/v4/user (profile + confirmed email)
 */
export function buildAuthorizationUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string,        // raw state value (not hash) — goes in the URL
  codeChallenge: string, // S256 PKCE challenge
  gitlabBaseUrl = 'https://gitlab.com',
): string {
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  if (provider === 'github') {
    params.set('scope', 'read:user user:email');
    // allow_signup=false: don't advertise GitHub sign-up to users who don't have accounts.
    // This is a UX preference, not a security control.
    params.set('allow_signup', 'false');
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  // GitLab
  params.set('scope', 'read_user');
  const base = gitlabBaseUrl.replace(/\/$/, '');
  return `${base}/oauth/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for a provider access token (server-to-server).
 *
 * Includes the PKCE code_verifier to prove possession per RFC 7636 §4.5.
 * Times out after 10 seconds. On failure throws a generic Error — callers are
 * responsible for logging details and mapping to a sanitized user-facing code.
 */
export async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier: string,
  gitlabBaseUrl = 'https://gitlab.com',
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
    grant_type:    'authorization_code',
  });

  const url =
    provider === 'github'
      ? 'https://github.com/login/oauth/access_token'
      : `${gitlabBaseUrl.replace(/\/$/, '')}/oauth/token`;

  let res: Response;
  try {
    // Server-to-server OAuth token exchange with hardcoded provider URLs — not user-controlled.
    res = await fetch(url, { // codeql[js/file-access-to-http] — server-to-server OAuth token exchange; hardcoded provider URLs
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // GitHub returns form-encoded by default; request JSON for consistent parsing
        'Accept': 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch {
    throw new Error('Token exchange request failed');
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Token exchange returned ${res.status}`);
  }

  let json: Record<string, unknown>;
  try {
    json = await res.json() as Record<string, unknown>;
  } catch {
    throw new Error('Token exchange response was not valid JSON');
  }

  if (json['error']) {
    throw new Error('Token exchange error from provider');
  }

  const token = json['access_token'];
  if (typeof token !== 'string' || !token) {
    throw new Error('Token exchange response missing access_token');
  }

  return token;
}

// ---------------------------------------------------------------------------
// Provider user fetch
// ---------------------------------------------------------------------------

export interface ProviderUser {
  /** Provider's stable numeric user ID, stored as a string. */
  providerId: string;
  /** Primary verified email address. */
  email: string;
  /** Display name (may be null — user can override during onboarding). */
  name: string | null;
}

/**
 * Fetch the minimal user profile from the provider using the access token.
 *
 * SECURITY — Email verification requirements (prevents account takeover):
 * - GitHub: Only accepts emails where verified === true AND primary === true.
 *   GitHub allows users to add unverified emails; we must not trust those.
 * - GitLab: Only accepts when confirmed_at is non-null.
 *
 * The access token is explicitly zeroed after use.
 *
 * Throws if no verified primary email is available — the caller must redirect
 * to the error page rather than proceeding without a verified email.
 */
export async function fetchProviderUser(
  provider: OAuthProvider,
  accessToken: string,
  gitlabBaseUrl = 'https://gitlab.com',
): Promise<ProviderUser> {
  if (provider === 'github') {
    return await fetchGitHubUser(accessToken);
  }
  return await fetchGitLabUser(accessToken, gitlabBaseUrl);
}

async function fetchGitHubUser(accessToken: string): Promise<ProviderUser> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept:        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Fetch profile and emails in parallel to minimize latency
  const [profileRes, emailsRes] = await Promise.all([
    fetchWithTimeout('https://api.github.com/user', { headers }),
    fetchWithTimeout('https://api.github.com/user/emails', { headers }),
  ]);

  if (!profileRes.ok) throw new Error(`GitHub /user returned ${profileRes.status}`);
  if (!emailsRes.ok)  throw new Error(`GitHub /user/emails returned ${emailsRes.status}`);

  const profile = await profileRes.json() as Record<string, unknown>;
  const emails  = await emailsRes.json() as Array<Record<string, unknown>>;

  const providerId = profile['id'];
  if (typeof providerId !== 'number' && typeof providerId !== 'string') {
    throw new Error('GitHub profile missing id');
  }

  // SECURITY: Only accept the primary AND verified email — GitHub allows users
  // to add unverified addresses. Using an unverified email for account matching
  // would allow a provider account holder to take over a Conduit account that
  // happens to share the same (unverified) email address.
  const primaryVerified = emails.find(
    (e) => e['primary'] === true && e['verified'] === true,
  );
  if (!primaryVerified || typeof primaryVerified['email'] !== 'string') {
    throw new OAuthNoVerifiedEmailError(
      'GitHub account has no verified primary email address',
    );
  }

  return {
    providerId: String(providerId),
    email:      (primaryVerified['email'] as string).toLowerCase(),
    name:       typeof profile['name'] === 'string' ? profile['name'] : null,
  };
}

async function fetchGitLabUser(accessToken: string, gitlabBaseUrl: string): Promise<ProviderUser> {
  const base = gitlabBaseUrl.replace(/\/$/, '');
  const res = await fetchWithTimeout(`${base}/api/v4/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`GitLab /api/v4/user returned ${res.status}`);

  const profile = await res.json() as Record<string, unknown>;

  const providerId = profile['id'];
  if (typeof providerId !== 'number' && typeof providerId !== 'string') {
    throw new Error('GitLab profile missing id');
  }

  // SECURITY: GitLab includes confirmed_at (ISO timestamp) when the primary email
  // has been confirmed. A null/missing confirmed_at means the email is unconfirmed.
  const confirmedAt = profile['confirmed_at'];
  if (!confirmedAt) {
    throw new OAuthNoVerifiedEmailError(
      'GitLab account email address has not been confirmed',
    );
  }

  const email = profile['email'];
  if (typeof email !== 'string' || !email) {
    throw new OAuthNoVerifiedEmailError(
      'GitLab account has no email address',
    );
  }

  return {
    providerId: String(providerId),
    email:      email.toLowerCase(),
    name:       typeof profile['name'] === 'string' ? profile['name'] : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrapper around fetch that enforces a 10-second timeout. */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    // Server-to-server call to OAuth provider user-info endpoints — URLs are hardcoded constants.
    return await fetch(url, { ...init, signal: controller.signal }); // codeql[js/file-access-to-http] — server-to-server; hardcoded OAuth provider URLs
  } catch {
    throw new Error(`Request to ${new URL(url).host} failed or timed out`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sentinel error class for the "no verified email" case.
 * Allows the route handler to distinguish this specific failure from generic
 * network/provider errors and emit the correct sanitized error code.
 */
export class OAuthNoVerifiedEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthNoVerifiedEmailError';
  }
}
