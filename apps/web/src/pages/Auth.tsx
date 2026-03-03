import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { Zap, AlertCircle, Smartphone } from 'lucide-react';
import { MagicLinkForm } from '@/components/auth/MagicLinkForm';
import { OAuthButtons } from '@/components/auth/OAuthButtons';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { UserProfile } from '@conduit/shared';

// Human-readable messages for the sanitized error codes emitted by the OAuth
// callback route. These codes are opaque to prevent information leakage;
// we provide friendly text here purely for UX.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_provider:       'Unrecognised login provider. Please try again.',
  provider_not_configured: 'This login method is not enabled on this server.',
  invalid_state:          'The login session expired or was already used. Please try again.',
  provider_error:         'Something went wrong communicating with the login provider. Please try again.',
  no_verified_email:      'Your account at the login provider has no verified email address. Please verify your email there and try again.',
};

export function Auth() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate     = useNavigate();
  const location     = useLocation();
  const setUser      = useAuthStore((s) => s.setUser);
  const setOnboarded = useAuthStore((s) => s.setOnboarded);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const [verifying,   setVerifying]   = useState(false);
  const [verifyError, setVerifyError] = useState('');
  // Trampoline state: when the SPA loads inside an email client's Custom Tab
  // on Android, we show a handoff screen instead of immediately consuming the
  // token, because the native app should handle it via intent://.
  const [showTrampoline, setShowTrampoline] = useState(false);
  const [trampolineToken, setTrampolineToken] = useState<string | null>(null);

  const token       = searchParams.get('token');
  const oauthError  = searchParams.get('error');
  const isVerifyRoute = location.pathname.endsWith('/verify');

  // Detect Android browser (not native Capacitor WebView)
  const isAndroidBrowser =
    !Capacitor.isNativePlatform() &&
    /Android/i.test(navigator.userAgent);

  // Proceed with normal token verification via POST
  const verifyToken = useCallback((tokenToVerify: string) => {
    // Clear the token from the URL immediately to prevent it leaking via
    // Referer headers or browser history (RFC 9700 §4.2).
    setSearchParams({}, { replace: true });
    setShowTrampoline(false);
    setTrampolineToken(null);

    setVerifying(true);
    api
      .postPublic<{ user: UserProfile & { onboardingComplete: boolean } }>('/auth/verify', { token: tokenToVerify })
      .then((res) => {
        setUser(res.user);
        setOnboarded(res.user.onboardingComplete);
        if (res.user.onboardingComplete) {
          navigate('/dashboard', { replace: true });
        } else {
          navigate('/onboarding', { replace: true });
        }
      })
      .catch((err) => {
        setVerifyError(err instanceof Error ? err.message : 'Verification failed');
        setVerifying(false);
      });
  }, [navigate, setUser, setOnboarded, setSearchParams]);

  useEffect(() => {
    if (isAuthenticated && !isVerifyRoute) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, isVerifyRoute, navigate]);

  useEffect(() => {
    if (!isVerifyRoute || !token) return;

    // On Android browsers (e.g. Outlook Custom Tab), show the trampoline
    // to hand off to the native app instead of consuming the token here.
    if (isAndroidBrowser) {
      setTrampolineToken(token);
      setShowTrampoline(true);
      // Clear the token from the URL but keep state in React
      setSearchParams({}, { replace: true });
      return;
    }

    // Desktop / non-Android: verify immediately via POST
    verifyToken(token);
  }, [isVerifyRoute, token, isAndroidBrowser, verifyToken, setSearchParams]);

  // Translate the opaque OAuth error code (set by the server callback redirect)
  // into a user-friendly message. Remove it from the URL so a refresh doesn't
  // re-show the error after the user fixes the issue.
  const oauthErrorMessage = oauthError
    ? (OAUTH_ERROR_MESSAGES[oauthError] ?? 'Login failed. Please try again.')
    : null;

  useEffect(() => {
    if (oauthError) {
      // Remove ?error= from the URL so the user doesn't see it on refresh
      setSearchParams({}, { replace: true });
    }
  }, [oauthError, setSearchParams]);

  // Build intent:// URI for Android app handoff.
  // intent://HOST/PATH#Intent;scheme=https;package=PACKAGE;S.browser_fallback_url=FALLBACK;end
  // Derive the host from VITE_API_URL so it works in any deployment.
  const apiHost = (() => {
    try {
      const base = import.meta.env.VITE_API_URL;
      return base ? new URL(base).host : window.location.host;
    } catch {
      return window.location.host;
    }
  })();
  const intentUri = trampolineToken
    ? `intent://${apiHost}/app/auth/verify?token=${encodeURIComponent(trampolineToken)}` +
      `#Intent;scheme=https;package=com.conduit.app;end`
    : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-base)] p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent)]">
            <Zap className="h-7 w-7 text-[var(--color-base)]" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Welcome to Conduit</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Sign in to manage your AI agent sessions
          </p>
        </div>

        {/* OAuth error banner — shown when the server redirects back with ?error= */}
        {oauthErrorMessage && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{oauthErrorMessage}</span>
          </div>
        )}

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg">
          {showTrampoline && intentUri ? (
            <div className="flex flex-col items-center gap-4 py-6">
              <Smartphone className="h-10 w-10 text-[var(--color-accent)]" aria-hidden="true" />
              <h2 className="text-lg font-semibold text-[var(--color-text)]">Open in Conduit</h2>
              <p className="text-center text-sm text-[var(--color-muted)]">
                Tap the button below to sign in with the Conduit app.
              </p>
              <a
                href={intentUri}
                className="inline-flex items-center justify-center rounded-lg bg-[var(--color-accent)] px-6 py-3 text-sm font-semibold text-white transition-colors hover:opacity-90"
              >
                Open in Conduit
              </a>
              <button
                type="button"
                onClick={() => trampolineToken && verifyToken(trampolineToken)}
                className="text-sm text-[var(--color-accent)] hover:underline"
              >
                Continue in browser instead
              </button>
            </div>
          ) : verifying ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner size="lg" className="text-[var(--color-accent)]" />
              <p className="text-sm text-[var(--color-muted)]">Verifying your magic link...</p>
            </div>
          ) : verifyError ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-sm text-[var(--color-danger)]" role="alert">{verifyError}</p>
            <div className="flex flex-col gap-4 w-full">
                <OAuthButtons />
                <Divider />
                <MagicLinkForm />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* OAuth login buttons — only rendered when providers are configured */}
              <OAuthButtons />

              {/* Divider — only rendered when at least one OAuth provider is configured.
                  OAuthButtons renders nothing when no providers are active, so the divider
                  would appear alone. We use a CSS trick: the divider's visibility is
                  controlled by whether OAuthButtons has any content — but since we can't
                  query the child render output easily, we render the divider unconditionally
                  and rely on OAuthButtons returning null to collapse the gap naturally.
                  The divider itself has no visual height when OAuthButtons returns null
                  because the flex container collapses the empty sibling. */}
              <Divider />

              <MagicLinkForm />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Visual "or" divider between OAuth buttons and the magic link form.
 * Uses CSS to draw a line on each side of the text — no extra DOM for the lines.
 */
function Divider() {
  return (
    <div className="relative flex items-center gap-3">
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      <span className="text-xs text-[var(--color-muted)] select-none">or</span>
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
    </div>
  );
}
