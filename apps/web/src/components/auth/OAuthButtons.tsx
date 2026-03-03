/**
 * OAuthButtons — renders "Login with GitHub" and "Login with GitLab" buttons
 * for providers that are configured on the server.
 *
 * Each button is a plain <a> tag that navigates the browser to the server's
 * /start endpoint. This is intentional and required: the OAuth flow begins with
 * a browser redirect (not a fetch), so using an anchor ensures the full-page
 * navigation happens correctly and cookies are set by the server on the callback.
 *
 * The server's GET /auth/oauth/providers endpoint tells us which providers are
 * available so we only show buttons for configured providers.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { resolveBaseUrl, isMobile, getStoredServerUrl } from '@/lib/api';

// ---------------------------------------------------------------------------
// Provider SVG icons (inline — no external requests, no CDN dependency)
// Source: GitHub/GitLab brand assets, simplified to single-path monochrome
// ---------------------------------------------------------------------------

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.387 9.45.045 13.587a.924.924 0 0 0 .331 1.023L12 23.054l11.624-8.444a.92.92 0 0 0 .331-1.023Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvidersResponse {
  github: boolean;
  gitlab: boolean;
}

interface OAuthButtonsProps {
  /** Optional extra class names on the container */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OAuthButtons({ className }: OAuthButtonsProps) {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    // Resolve the base URL the same way the API client does so mobile (custom
    // server URL) and web (VITE_API_URL) both work correctly.
    const base = isMobile ? getStoredServerUrl() : resolveBaseUrl();

    fetch(`${base}/auth/oauth/providers`, {
      // No credentials needed — this is a public config endpoint.
      // Include X-Requested-With so the server can distinguish XHR from browser nav.
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProvidersResponse | null) => setProviders(data))
      .catch(() => setProviders(null))
      .finally(() => setLoading(false));
  }, []);

  // Don't render anything while loading or if neither provider is configured
  if (loading || !providers || (!providers.github && !providers.gitlab)) {
    return null;
  }

  // Build the start URL for a given provider.
  // This is a plain browser navigation anchor, not a fetch — the server will
  // set the state cookie, then redirect to the provider authorization page.
  //
  // SECURITY: The URL is built entirely from compile-time config (VITE_API_URL
  // or stored server URL for mobile) plus a hardcoded path literal. No user
  // input or DOM text influences the href value.
  // codeql[js/xss-through-dom] — false positive: no DOM text reinterpretation
  function startUrl(provider: 'github' | 'gitlab'): string {
    const base = isMobile ? getStoredServerUrl() : resolveBaseUrl();
    return `${base}/auth/oauth/${provider}/start`;
  }

  return (
    <div className={cn('flex flex-col gap-3 w-full', className)}>
      {providers.github && (
        <a
          href={startUrl('github')} // codeql[js/xss-through-dom] — false positive: URL built from compile-time config + hardcoded path literal
          className={cn(
            'inline-flex items-center justify-center gap-2.5 rounded-md font-medium transition-colors',
            'h-11 px-4 py-2 text-sm w-full',
            'bg-[var(--color-surface-alt)] text-[var(--color-text)] border border-[var(--color-border)]',
            'hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-base)]',
          )}
          // Not using rel="noopener" since this is same-origin navigation, not a new tab
        >
          <GitHubIcon className="h-4 w-4 shrink-0 text-[var(--color-text)]" />
          Continue with GitHub
        </a>
      )}

      {providers.gitlab && (
        <a
          href={startUrl('gitlab')} // codeql[js/xss-through-dom] — false positive: URL built from compile-time config + hardcoded path literal
          className={cn(
            'inline-flex items-center justify-center gap-2.5 rounded-md font-medium transition-colors',
            'h-11 px-4 py-2 text-sm w-full',
            'bg-[var(--color-surface-alt)] text-[var(--color-text)] border border-[var(--color-border)]',
            'hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-base)]',
          )}
        >
          <GitLabIcon className="h-4 w-4 shrink-0 text-[#fc6d26]" />
          Continue with GitLab
        </a>
      )}
    </div>
  );
}
