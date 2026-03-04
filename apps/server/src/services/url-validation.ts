/**
 * URL validation utilities to prevent Server-Side Request Forgery (SSRF).
 *
 * Before making outbound HTTP requests to user-supplied URLs, validate that
 * the target is not a private/internal network address. This prevents
 * attackers from using the server as a proxy to scan or interact with
 * internal infrastructure.
 *
 * References:
 * - OWASP SSRF Prevention Cheat Sheet
 * - https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
 */

import { promises as dnsPromises } from 'node:dns';

/**
 * Normalize an IP string to a canonical IPv4 dotted-decimal form if possible.
 * Handles:
 * - Decimal IPs (e.g. 2130706433 → 127.0.0.1)
 * - Octal IPs (e.g. 0177.0.0.1 → 127.0.0.1)
 * - IPv4-mapped IPv6 hex variants (e.g. ::ffff:7f00:1 → 127.0.0.1)
 * - Mixed IPv4-mapped (e.g. ::ffff:127.0.0.1 → 127.0.0.1)
 */
function normalizeIP(ip: string): string {
  const lower = ip.toLowerCase();

  // Handle IPv4-mapped IPv6 in hex form: ::ffff:XXYY:ZZWW
  const hexMappedMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMappedMatch) {
    const hi = parseInt(hexMappedMatch[1]!, 16);
    const lo = parseInt(hexMappedMatch[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  // Handle IPv4-mapped IPv6 in dotted form: ::ffff:A.B.C.D
  const dottedMappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMappedMatch) {
    return dottedMappedMatch[1]!;
  }

  // Handle single-integer decimal IPv4 (e.g. 2130706433)
  if (/^\d+$/.test(ip) && !ip.startsWith('0')) {
    const num = parseInt(ip, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return `${(num >>> 24) & 0xff}.${(num >>> 16) & 0xff}.${(num >>> 8) & 0xff}.${num & 0xff}`;
    }
  }

  // Handle octal IPv4 (e.g. 0177.0.0.01) — any octet starting with 0 followed by digits
  const octets = ip.split('.');
  if (octets.length === 4 && octets.some(o => /^0\d+$/.test(o))) {
    const parsed = octets.map(o => {
      if (/^0[0-7]*$/.test(o)) return parseInt(o, 8);
      if (/^0x[0-9a-fA-F]+$/i.test(o)) return parseInt(o, 16);
      return parseInt(o, 10);
    });
    if (parsed.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
      return parsed.join('.');
    }
  }

  // Handle hex octets in IPv4 (e.g. 0x7f.0x0.0x0.0x1)
  if (octets.length === 4 && octets.some(o => /^0x/i.test(o))) {
    const parsed = octets.map(o => {
      if (/^0x[0-9a-fA-F]+$/i.test(o)) return parseInt(o, 16);
      return parseInt(o, 10);
    });
    if (parsed.every(n => !isNaN(n) && n >= 0 && n <= 255)) {
      return parsed.join('.');
    }
  }

  return ip;
}

/**
 * Check if an IP address belongs to a private/reserved network range.
 * Covers RFC 1918, RFC 6598 (CGNAT), loopback, link-local, multicast,
 * and IPv6 equivalents.
 */
function isPrivateIP(rawIp: string): boolean {
  // Normalize the IP to catch evasion techniques
  const ip = normalizeIP(rawIp);

  // IPv4 private ranges
  if (
    ip === '127.0.0.1' ||
    ip.startsWith('127.') ||                                // Loopback
    ip.startsWith('10.') ||                                  // RFC 1918 Class A
    ip.startsWith('192.168.') ||                             // RFC 1918 Class C
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||                // RFC 1918 Class B
    ip.startsWith('100.64.') ||                              // RFC 6598 CGNAT
    ip.startsWith('169.254.') ||                             // Link-local
    ip.startsWith('0.') ||                                   // Current network
    ip === '0.0.0.0' ||                                      // Unspecified
    ip === '255.255.255.255' ||                              // Broadcast
    /^22[4-9]\./.test(ip) || /^23\d\./.test(ip) ||          // Multicast (224-239)
    ip.startsWith('198.18.') || ip.startsWith('198.19.') || // RFC 2544 benchmarking
    ip.startsWith('192.0.0.') ||                             // IETF protocol assignments
    ip.startsWith('192.0.2.') ||                             // TEST-NET-1
    ip.startsWith('198.51.100.') ||                          // TEST-NET-2
    ip.startsWith('203.0.113.')                              // TEST-NET-3
  ) {
    return true;
  }

  // IPv6 private/reserved ranges (check original input since normalization
  // converts mapped addresses to IPv4)
  const ipLower = rawIp.toLowerCase();
  if (
    ipLower === '::1' ||                                     // Loopback
    ipLower === '::' ||                                      // Unspecified
    ipLower.startsWith('fc') ||                              // Unique local (fc00::/7)
    ipLower.startsWith('fd') ||                              // Unique local
    ipLower.startsWith('fe80') ||                            // Link-local
    ipLower.startsWith('ff') ||                              // Multicast
    ipLower.startsWith('::ffff:')                            // All IPv4-mapped — handled by normalizeIP above
  ) {
    // For ::ffff: mapped, re-check the normalized IPv4
    if (ipLower.startsWith('::ffff:')) {
      // normalizeIP already converted it; the IPv4 checks above will have caught it
      // if it was private. If we got here, it wasn't caught, so it's fine.
      // But we need to re-run the IPv4 check on the normalized form:
      const normalized = normalizeIP(rawIp);
      if (normalized !== rawIp) {
        return isPrivateIP(normalized); // safe: won't recurse again since normalized is plain IPv4
      }
    }
    return true;
  }

  return false;
}

/** Hostnames that resolve to private addresses. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',       // GCP metadata service
  'metadata.internal',
  'metadata',                        // Common short alias
]);

/** Options for {@link validateUrlNotPrivate}. */
export interface ValidateUrlOptions {
  /**
   * When true, loopback addresses (127.x.x.x, ::1, localhost) are permitted.
   *
   * Use this when the Conduit server and the target agent are co-located on
   * the same machine (e.g. OpenCode running on http://127.0.0.1:4096).
   * The SSRF concern — using the server as a proxy to reach internal
   * infrastructure — does not apply to the machine the user is already
   * operating on.
   */
  allowLoopback?: boolean;
}

/** Returns true if the given (already-normalised) IP or hostname is a loopback address. */
function isLoopback(hostname: string): boolean {
  const raw = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return (
    raw === 'localhost' ||
    raw === '::1' ||
    raw.startsWith('127.')
  );
}

/**
 * Validate that a URL is safe to make outbound requests to.
 * Throws an Error if the URL targets a private/reserved network.
 *
 * NOTE: This performs static analysis on the parsed URL hostname.
 * A DNS rebinding attack could bypass this if the hostname resolves
 * to a private IP after validation. For production, consider also
 * validating the resolved IP at connect time.
 */
export function validateUrlNotPrivate(urlString: string, options: ValidateUrlOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  // Only allow http/https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  // Block URLs with credentials
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const hostname = parsed.hostname.toLowerCase();

  // If the caller explicitly permits loopback, skip all loopback-related checks
  // before falling through to the broader private-IP checks.
  if (options.allowLoopback && isLoopback(hostname)) {
    return;
  }

  // Block well-known private hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL points to a blocked hostname');
  }

  // Block hostnames ending with common internal TLDs
  if (
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    throw new Error('URL points to a blocked hostname');
  }

  // Check if hostname is a raw IP address
  // Remove IPv6 brackets if present
  const rawHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (isPrivateIP(rawHost)) {
    throw new Error('URL points to a private/reserved network address');
  }

  // Block cloud metadata endpoints by IP (already caught by 169.254.x.x above,
  // but explicit check for clarity)
  if (rawHost === '169.254.169.254') {
    throw new Error('URL points to a cloud metadata endpoint');
  }
}

/**
 * Validate a URL against both static SSRF rules AND the resolved DNS address.
 *
 * This defeats DNS rebinding attacks: an attacker cannot register a hostname
 * that passes the static hostname check but resolves to an internal IP,
 * because we re-check the resolved IP here before any outbound request is made.
 *
 * Throws if the URL is invalid, targets a private hostname/IP (static check),
 * or resolves to a private/reserved IP address (DNS check).
 */
export async function resolveAndValidateUrl(urlString: string): Promise<void> {
  // Step 1 — static checks (scheme, credentials, blocked hostnames, raw IPs)
  validateUrlNotPrivate(urlString);

  // Step 2 — DNS resolution check
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1) // strip IPv6 brackets
    : parsed.hostname;

  // If the hostname is already a raw IP, isPrivateIP was checked in step 1 — no DNS needed.
  // We detect a raw IP heuristically: it either contains only digits/dots (IPv4) or
  // contains colons (IPv6). If neither, it is a hostname that requires resolution.
  const isRawIP = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isRawIP) {
    return;
  }

  let resolvedAddress: string;
  try {
    const result = await dnsPromises.lookup(hostname);
    resolvedAddress = result.address;
  } catch {
    // Resolution failure — treat as unsafe (could be a dangling domain or unreachable host).
    throw new Error(`DNS resolution failed for hostname: ${hostname}`);
  }

  if (isPrivateIP(resolvedAddress)) {
    throw new Error(`URL resolves to a private/reserved address: ${resolvedAddress}`);
  }
}
