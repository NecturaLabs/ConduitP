import { useState, useRef, useEffect } from 'react';
import { Zap, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { api } from '@/lib/api';

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function Activate() {
  // 4 + 4 character code input (displayed as XXXX-XXXX)
  const [segments, setSegments] = useState(['', '']);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)] as const;

  // Auto-focus first input on mount
  useEffect(() => {
    inputRefs[0].current?.focus();
  }, []);

  const CHARSET = 'BCDFGHJKLMNPQRSTVWXZ';
  const SEG_LEN = 4;

  function filterInput(raw: string): string {
    return raw
      .toUpperCase()
      .replace(/[-\s]/g, '')
      .split('')
      .filter((c) => CHARSET.includes(c))
      .slice(0, SEG_LEN)
      .join('');
  }

  function handleChange(index: number, raw: string) {
    // Handle paste of full code (e.g. "WDJB-MJHT")
    const cleaned = raw.toUpperCase().replace(/[-\s]/g, '');
    if (cleaned.length > SEG_LEN && index === 0) {
      const filtered = cleaned
        .split('')
        .filter((c) => CHARSET.includes(c))
        .join('');
      const s0 = filtered.slice(0, SEG_LEN);
      const s1 = filtered.slice(SEG_LEN, SEG_LEN * 2);
      setSegments([s0, s1]);
      if (s1.length === SEG_LEN) {
        // Full code pasted — don't move focus, it's complete
      } else {
        inputRefs[1].current?.focus();
      }
      return;
    }

    const filtered = filterInput(raw);
    const next = [...segments];
    next[index] = filtered;
    setSegments(next);

    // Auto-advance to next segment
    if (filtered.length === SEG_LEN && index === 0) {
      inputRefs[1].current?.focus();
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace on empty second segment → go back to first
    if (e.key === 'Backspace' && index === 1 && segments[1] === '') {
      e.preventDefault();
      inputRefs[0].current?.focus();
    }
  }

  const [seg0, seg1] = segments as [string, string];
  const fullCode = `${seg0}-${seg1}`;
  const isComplete = seg0.length === SEG_LEN && seg1.length === SEG_LEN;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isComplete || status === 'submitting') return;

    setStatus('submitting');
    setErrorMsg('');

    try {
      await api.post('/auth/device/approve', { userCode: fullCode });
      setStatus('success');
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to approve. Please check the code and try again.';
      setErrorMsg(msg);
      setStatus('error');
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-base)] p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent)]">
            <Zap className="h-7 w-7 text-[var(--color-base)]" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Activate Device</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Enter the code shown in your terminal to connect Claude Code to Conduit.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-lg">
          {status === 'success' ? (
            <div className="flex flex-col items-center gap-3 py-6" role="status">
              <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden="true" />
              <p className="text-base font-medium text-[var(--color-text)]">Device approved</p>
              <p className="text-sm text-[var(--color-muted)] text-center">
                Return to your terminal — the installation will complete automatically.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {/* Code inputs */}
              <div className="flex items-center justify-center gap-3">
                {segments.map((seg, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <input
                      ref={inputRefs[i]}
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={i === 0 ? SEG_LEN * 2 + 1 : SEG_LEN}
                      value={seg}
                      onChange={(e) => handleChange(i, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(i, e)}
                      disabled={status === 'submitting'}
                      placeholder="····"
                      className="h-14 w-[clamp(5.5rem,22vw,7rem)] rounded-lg border-2 border-[var(--color-border)] bg-[var(--color-base)] text-center text-2xl font-mono font-bold tracking-[0.25em] text-[var(--color-text)] placeholder:text-[var(--color-muted)]/30 placeholder:tracking-[0.15em] transition-colors focus-visible:outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20 disabled:opacity-50"
                      aria-label={`Code segment ${i + 1}`}
                    />
                    {i === 0 && (
                      <span className="text-2xl font-bold text-[var(--color-muted)] select-none">
                        —
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Error message */}
              {status === 'error' && errorMsg && (
                <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/6 px-3 py-2.5" role="alert">
                  <AlertCircle className="h-4 w-4 text-[var(--color-danger)] shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-sm text-[var(--color-danger)]">{errorMsg}</p>
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                disabled={!isComplete || status === 'submitting'}
                className="w-full h-11 text-sm font-medium"
              >
                {status === 'submitting' ? (
                  <span className="flex items-center gap-2">
                    <Spinner size="sm" />
                    Approving...
                  </span>
                ) : (
                  'Approve'
                )}
              </Button>

              <p className="text-sm text-center text-[var(--color-muted)]">
                This code expires in 10 minutes. If expired, run the install command again.
              </p>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
