import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { Copy, Check, Palette, Server, Plug, RefreshCw, AlertCircle, Trash2, Eye, EyeOff, Unplug, ChevronDown, Accessibility, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ThemeSwatch } from '@/components/theme/ThemeSwatch';
import { AgentCard } from '@/components/agents/AgentCard';
import { useInstancesQuery } from '@/hooks/useInstances';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth';
import { useAccessibilityStore } from '@/store/accessibility';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const REFRESH_COOLDOWN_MS = 5_000;
const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [align, setAlign] = useState<'left' | 'center' | 'right'>('center');

  const updateAlign = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const tipWidth = 260;
    const half = tipWidth / 2;
    if (rect.left < half) setAlign('left');
    else if (window.innerWidth - rect.right < half) setAlign('right');
    else setAlign('center');
  }, []);

  return (
    <span
      ref={ref}
      className="relative inline-flex items-center"
      onMouseEnter={() => { updateAlign(); setOpen(true); }}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => { updateAlign(); setOpen(true); }}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'pointer-events-none absolute top-full mt-2 z-50 w-max max-w-[min(260px,90vw)] rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-alt)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--color-text)] shadow-lg',
            align === 'center' && 'left-1/2 -translate-x-1/2',
            align === 'left' && 'left-0',
            align === 'right' && 'right-0',
          )}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ── Copy block ────────────────────────────────────────────────────────────────

function CopyBlock({ command, copyValue, maxHeight, copyDisabled, copyDisabledTitle }: { command: string; copyValue?: string; maxHeight?: string; copyDisabled?: boolean; copyDisabledTitle?: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function copy() {
    if (copyDisabled) return;
    void navigator.clipboard.writeText(copyValue ?? command);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative group">
      <pre
        className={cn(
          'rounded-md border border-[var(--color-border)] bg-[var(--color-base)] px-3 py-2.5 text-sm font-mono text-[var(--color-text)] break-all whitespace-pre-wrap leading-relaxed pr-10',
          maxHeight && 'overflow-y-auto',
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {command}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        onClick={copy}
        disabled={copyDisabled}
        title={copyDisabled ? (copyDisabledTitle ?? 'Reveal the token first to copy') : undefined}
        className={cn(
          'absolute top-1.5 right-1.5 h-9 w-9 transition-opacity',
          copyDisabled
            ? 'opacity-25 cursor-not-allowed'
            : 'opacity-60 group-hover:opacity-100',
        )}
        aria-label={copyDisabled ? (copyDisabledTitle ?? 'Reveal the token first to copy') : 'Copy command'}
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-success)]" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

// ── Collapsible card ──────────────────────────────────────────────────────────

interface CollapsibleCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  defaultOpen?: boolean;
  headerAction?: React.ReactNode;
  cardClassName?: string;
  children: React.ReactNode;
}

function CollapsibleCard({
  icon,
  title,
  description,
  defaultOpen = true,
  headerAction,
  cardClassName,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card className={cardClassName}>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          <div className="flex items-center gap-1">
            {headerAction && (
              <span onClick={(e) => e.stopPropagation()}>{headerAction}</span>
            )}
            <ChevronDown
              className={cn(
                'h-4 w-4 text-[var(--color-muted)] transition-transform duration-200',
                open && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </div>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

// ── Tab primitives ────────────────────────────────────────────────────────────

function InnerTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-0 border-b border-[var(--color-border)] overflow-x-auto scrollbar-hide">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px min-h-[44px] whitespace-nowrap shrink-0',
            active === tab.id
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ── Top-level page tabs ───────────────────────────────────────────────────────

const pageTabs = [
  { id: 'general', label: 'General' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'setup', label: 'Setup' },
  { id: 'account', label: 'Account' },
] as const;

type PageTab = (typeof pageTabs)[number]['id'];

function PageTabs({ active, onChange }: { active: PageTab; onChange: (id: PageTab) => void }) {
  return (
    <div className="overflow-x-auto scrollbar-hide shrink-0">
    <div role="tablist" className="flex gap-1 rounded-lg bg-[var(--color-surface)] p-1 border border-[var(--color-border)] min-w-max">
      {pageTabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-3 py-1.5 text-sm font-medium rounded-md transition-all min-h-[44px] whitespace-nowrap',
            active === tab.id
              ? 'bg-[var(--color-accent)] text-[var(--color-base)] shadow-sm'
              : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
    </div>
  );
}

// ── Setup instructions ────────────────────────────────────────────────────────

type TokenState = 'loading' | 'loaded' | 'error';

/** OpenCode uses "mcp" key, "type": "local", command array, "environment" key. */
function buildOpenCodeMcpConfig(apiUrl: string, token: string): string {
  return [
    `    "conduit": {`,
    `      "type": "local",`,
    `      "command": [`,
    `        "npx",`,
    `        "-y",`,
    `        "@conduit-ai/mcp-server"`,
    `      ],`,
    `      "environment": {`,
    `        "CONDUIT_API_URL": "${apiUrl}",`,
    `        "CONDUIT_HOOK_TOKEN": "${token}"`,
    `      }`,
    `    }`,
  ].join('\n');
}

// ── Regenerate confirmation modal ─────────────────────────────────────────────

function RegenerateConfirmModal({
  onConfirm,
  onCancel,
  regenerating,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  regenerating: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="regen-modal-title"
      aria-describedby="regen-modal-desc"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-base)]/80 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div className="relative w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-[var(--color-warning)] shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h2 id="regen-modal-title" className="text-base font-semibold text-[var(--color-text)]">
              Regenerate hook token?
            </h2>
            <p id="regen-modal-desc" className="text-sm text-[var(--color-muted)] mt-1.5 leading-relaxed">
              This will generate a new token and <strong className="text-[var(--color-text)]">immediately disconnect all existing connections</strong>.
              Any agents or editors currently using this token will stop working until you update their config with the new token.
            </p>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={regenerating}
            className="h-9"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={regenerating}
            className="h-9"
          >
            {regenerating ? (
              <><RefreshCw aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Regenerating…</>
            ) : (
              'Yes, regenerate'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetupInstructions() {
  const HOOK_TOKEN_KEY = 'conduit_hook_token';

  const [tokenState, setTokenState] = useState<TokenState>('loading');
  const [hookToken, setHookToken] = useState<string | null>(null);
  const [hookPrefix, setHookPrefix] = useState<string>('');
  const [platformTab, setPlatformTab] = useState('claude');
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);

  // Persist token to sessionStorage so it survives tab navigation.
  const saveToken = useCallback((token: string) => {
    setHookToken(token);
    setHookPrefix(token.slice(0, 8));
    try { sessionStorage.setItem(HOOK_TOKEN_KEY, token); } catch { /* quota */ }
  }, []);

  const loadToken = useCallback(async () => {
    setTokenState('loading');
    try {
      const res = await api.get<{ token: string | null; prefix: string; isSet: boolean; detectedIp: string | null }>('/hooks/token');
      if (res.token) {
        // Server returned plaintext (first creation) — persist it.
        saveToken(res.token);
      } else {
        // Server only returned prefix — check sessionStorage for cached plaintext.
        const cached = sessionStorage.getItem(HOOK_TOKEN_KEY);
        if (cached) {
          setHookToken(cached);
          setHookPrefix(cached.slice(0, 8));
        } else {
          setHookToken(null);
          setHookPrefix(res.prefix ?? '');
        }
      }
      setTokenState('loaded');
    } catch {
      setTokenState('error');
    }
  }, [saveToken]);

  useEffect(() => {
    void loadToken();
  }, [loadToken]);

  // Toggle only masks/unmasks — never regenerates.
  const handleToggleReveal = useCallback(() => {
    setTokenRevealed((v) => !v);
  }, []);

  const handleRegenerate = useCallback(async () => {
    setShowRegenConfirm(false);
    setRegenerating(true);
    try {
      const res = await api.post<{ token: string; prefix: string }>('/hooks/token/regenerate');
      saveToken(res.token);
      setTokenRevealed(false);
    } catch { /* silently fail */ } finally {
      setRegenerating(false);
    }
  }, [saveToken]);

  // Display token: show full if revealed, otherwise mask all but the prefix.
  const maskedToken = hookToken !== null
    ? `${hookToken.slice(0, 8)}${'•'.repeat(Math.max(0, hookToken.length - 8))}`
    : `${hookPrefix}${'•'.repeat(56)}`;

  const displayToken = (hookToken !== null && tokenRevealed) ? hookToken : maskedToken;

  // OpenCode MCP config values.
  const openCodeConfigDisplay = buildOpenCodeMcpConfig(API_URL, displayToken);
  const openCodeConfigCopy = hookToken !== null ? buildOpenCodeMcpConfig(API_URL, hookToken) : null;

  return (
    <>
      {showRegenConfirm && (
        <RegenerateConfirmModal
          onConfirm={() => void handleRegenerate()}
          onCancel={() => setShowRegenConfirm(false)}
          regenerating={regenerating}
        />
      )}
      <CollapsibleCard
        icon={<Plug className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />}
        title="Connect an Agent"
        description="Claude Code connects via a one-time skill setup. OpenCode connects via the MCP server."
        defaultOpen={false}
      >
        <div className="flex flex-col gap-5">
          <InnerTabs
            tabs={[
              { id: 'claude', label: 'Claude Code' },
              { id: 'opencode', label: 'OpenCode' },
            ]}
            active={platformTab}
            onChange={setPlatformTab}
          />

          {/* Claude Code tab */}
          {platformTab === 'claude' && (
            <div className="flex flex-col gap-5">
              {/* Step 1 */}
              <div className="flex flex-col gap-2.5">
                <p className="text-sm font-semibold text-[var(--color-text)]">
                  Step 1 — Install the skill
                </p>
                <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                  Copies the Conduit skill files to{' '}
                  <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">~/.claude/skills/conduit/</code>{' '}
                  and adds setup instructions to your CLAUDE.md.
                </p>
                <CopyBlock command="npx @conduit-ai/skills" />
              </div>

              {/* Step 2 */}
              <div className="flex flex-col gap-2.5 pt-3 border-t border-[var(--color-border)]">
                <p className="text-sm font-semibold text-[var(--color-text)]">
                  Step 2 — Run setup in Claude Code
                </p>
                <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                  Open Claude Code and run this slash command. It will open a browser tab to authenticate
                  with Conduit, then automatically register your instance and sync your models.
                </p>
                <CopyBlock command="/conduit-setup" />
              </div>

              {/* Info note */}
              <div className="rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-4 py-3">
                <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                  <strong className="text-[var(--color-text)]">Sessions are tracked automatically.</strong>{' '}
                  After setup, Claude Code will report sessions, messages, and token usage to Conduit
                  and check for pending prompts before each response.
                </p>
              </div>
            </div>
          )}

          {/* OpenCode tab */}
          {platformTab === 'opencode' && (
            <div className="flex flex-col gap-5">
              {/* Token loading / error */}
              {tokenState === 'loading' && (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}

              {tokenState === 'error' && (
                <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/6 px-4 py-3">
                  <AlertCircle className="h-4 w-4 text-[var(--color-danger)] shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)]">Could not load setup token</p>
                    <p className="text-sm text-[var(--color-muted)] mt-0.5">
                      Your session may have expired or the server is unreachable.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadToken()}
                    className="shrink-0 text-xs h-8"
                  >
                    Retry
                  </Button>
                </div>
              )}

              {tokenState === 'loaded' && (
                <>
                  {/* MCP config block */}
                  <div className="flex flex-col gap-2.5">
                    <p className="text-sm font-semibold text-[var(--color-text)]">
                      Step 1 — Add to your OpenCode config
                    </p>
                    <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                      Paste the snippet below into the{' '}
                      <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">"mcp"</code>{' '}
                      object in your config file. Your hook token is already filled in.
                    </p>

                    <div className="flex items-center gap-1">
                      <Tooltip text={
                        hookToken === null
                          ? 'Token not available — regenerate to reveal'
                          : tokenRevealed
                            ? 'Mask the token in the config block below'
                            : 'Reveal the full token in the config block below'
                      }>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleToggleReveal}
                          disabled={hookToken === null || regenerating}
                          className="text-xs h-9 gap-1.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                          aria-label={tokenRevealed ? 'Hide token' : 'Show token'}
                        >
                          {tokenRevealed ? (
                            <><EyeOff aria-hidden="true" className="h-3.5 w-3.5" /> Hide token</>
                          ) : (
                            <><Eye aria-hidden="true" className="h-3.5 w-3.5" /> Show token</>
                          )}
                        </Button>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowRegenConfirm(true)}
                        disabled={regenerating}
                        className="text-xs h-9 gap-1.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                        aria-label="Regenerate token"
                      >
                        {regenerating ? (
                          <><RefreshCw aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Regenerating…</>
                        ) : (
                          <><RotateCcw aria-hidden="true" className="h-3.5 w-3.5" /> Regenerate</>
                        )}
                      </Button>
                    </div>

                    <CopyBlock
                      command={openCodeConfigDisplay}
                      copyValue={openCodeConfigCopy ?? undefined}
                      copyDisabled={openCodeConfigCopy === null}
                      copyDisabledTitle="Token not yet loaded"
                      maxHeight="220px"
                    />
                  </div>

                  {/* Config file location */}
                  <div className="flex flex-col gap-3 pt-3 border-t border-[var(--color-border)]">
                    <p className="text-sm font-semibold text-[var(--color-text)]">Where to paste the config</p>
                    <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                      Open the config file and add the snippet above inside the{' '}
                      <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">"mcp"</code>{' '}
                      object.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      <code className="font-mono bg-[var(--color-surface)] px-2.5 py-1.5 rounded text-sm text-[var(--color-text)]">
                        ~/.config/opencode/opencode.json
                      </code>
                      <p className="text-sm text-[var(--color-muted)]">
                        On Windows: <code className="font-mono bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-xs">%USERPROFILE%\.config\opencode\opencode.json</code>
                      </p>
                    </div>
                  </div>

                  {/* How it works note */}
                  <div className="rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-4 py-3">
                    <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                      <strong className="text-[var(--color-text)]">Works with OpenCode.</strong>{' '}
                      The MCP server provides tools for reporting events, sending prompts, and more.
                      On first run, it automatically registers your instance and begins streaming session data.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </CollapsibleCard>
    </>
  );
}

// ── Disconnect guide ──────────────────────────────────────────────────────────

function DisconnectGuide() {
  return (
    <CollapsibleCard
      icon={<Unplug className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />}
      title="Disconnect an Agent"
      description="How to remove Conduit from Claude Code or OpenCode."
      defaultOpen={false}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <p className="text-sm font-semibold text-[var(--color-text)]">Claude Code</p>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed">
            Delete the credentials file and remove the Conduit block from your CLAUDE.md:
          </p>
          <CopyBlock command={`rm ~/.conduit`} />
          <p className="text-sm text-[var(--color-muted)] leading-relaxed">
            Then open{' '}
            <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">~/.claude/CLAUDE.md</code>
            {' '}and delete the block between{' '}
            <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">&lt;!-- conduit:start --&gt;</code>
            {' '}and{' '}
            <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">&lt;!-- conduit:end --&gt;</code>.
          </p>
        </div>
        <div className="flex flex-col gap-2.5 pt-3 border-t border-[var(--color-border)]">
          <p className="text-sm font-semibold text-[var(--color-text)]">OpenCode</p>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed">
            Remove the <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">"conduit"</code> entry from the{' '}
            <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">"mcp"</code> object in{' '}
            <code className="font-mono text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded text-[13px]">~/.config/opencode/opencode.json</code>.
          </p>
        </div>
      </div>
    </CollapsibleCard>
  );
}

// ── Connected instances ───────────────────────────────────────────────────────

function ConnectedInstances() {
  const { data, isLoading, isFetching } = useInstancesQuery();
  const queryClient = useQueryClient();
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    if (cooldown || isFetching) return;
    void queryClient.invalidateQueries({ queryKey: ['instances'] });
    setCooldown(true);
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = setTimeout(() => setCooldown(false), REFRESH_COOLDOWN_MS);
  }, [cooldown, isFetching, queryClient]);

  return (
    <CollapsibleCard
      icon={<Server className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />}
      title="Connected Instances"
      description="Agent instances connected to Conduit."
      headerAction={
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={cooldown || isFetching}
          aria-label="Refresh instances"
          className="h-8 w-8"
        >
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} aria-hidden="true" />
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {isLoading ? (
          <>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </>
        ) : !data?.instances.length ? (
          <p className="text-sm text-[var(--color-muted)] py-8 text-center">
            No instances registered yet. Follow the setup instructions above to connect your first agent.
          </p>
        ) : (
          data.instances.map((inst) => (
            <AgentCard key={inst.id} instance={inst} />
          ))
        )}
      </div>
    </CollapsibleCard>
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────

function DangerZone() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  const clearUser = useAuthStore((s) => s.clearUser);

  async function handleDelete() {
    if (confirmText !== 'DELETE') return;
    setIsDeleting(true);
    setError('');
    try {
      await api.delete('/auth/account');
      clearUser();
      window.location.href = '/app/auth';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account');
      setIsDeleting(false);
    }
  }

  return (
    <Card className="border-[var(--color-danger)]/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-[var(--color-danger)]">
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Danger Zone
        </CardTitle>
        <CardDescription>
          Permanently delete your account and all stored data. This action cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!showConfirm ? (
          <Button
            variant="ghost"
            className="text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
            onClick={() => setShowConfirm(true)}
          >
            Delete Account
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--color-text)]">
              This will permanently delete your account, all connected instances, sessions,
              metrics, and configuration data. Type <strong>DELETE</strong> to confirm.
            </p>
            <label htmlFor="delete-confirm" className="sr-only">Type DELETE to confirm account deletion</label>
            <input
              id="delete-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type DELETE to confirm"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-base)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-danger)]/50 w-full max-w-64"
              autoFocus
            />
            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>
            )}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]/80"
                onClick={() => void handleDelete()}
                disabled={confirmText !== 'DELETE' || isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Permanently Delete Account'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => { setShowConfirm(false); setConfirmText(''); setError(''); }}
                disabled={isDeleting}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Accessibility settings ────────────────────────────────────────────────

function AccessibilityToggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="flex-1 min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-[var(--color-text)] cursor-pointer">
          {label}
        </label>
        <p className="text-xs text-[var(--color-muted)] mt-0.5">{description}</p>
      </div>
      <button
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-base)]',
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  );
}

function AccessibilitySettings() {
  const {
    reduceMotion,
    enhancedFocus,
    largerTargets,
    setReduceMotion,
    setEnhancedFocus,
    setLargerTargets,
  } = useAccessibilityStore();

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2 text-base">
          <Accessibility aria-hidden="true" className="h-4 w-4 text-[var(--color-muted)]" />
          Accessibility
        </CardTitle>
        <CardDescription>
          Adjust accessibility preferences to improve your experience. These settings are saved locally.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col divide-y divide-[var(--color-border)]/50">
          <AccessibilityToggle
            id="a11y-reduce-motion"
            label="Reduce motion"
            description="Disable animations and transitions across the dashboard, regardless of your OS setting."
            checked={reduceMotion}
            onChange={setReduceMotion}
          />
          <AccessibilityToggle
            id="a11y-enhanced-focus"
            label="Enhanced focus indicators"
            description="Show thicker, higher-contrast focus outlines for keyboard navigation."
            checked={enhancedFocus}
            onChange={setEnhancedFocus}
          />
          <AccessibilityToggle
            id="a11y-larger-targets"
            label="Larger touch targets"
            description="Increase the minimum size of interactive elements for easier tapping."
            checked={largerTargets}
            onChange={setLargerTargets}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Settings() {
  const [activeTab, setActiveTab] = useState<PageTab>('general');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Setup</h1>
          <p className="text-sm text-[var(--color-muted)] mt-0.5">
            Customize your dashboard and manage agent connections.
          </p>
        </div>
        <PageTabs active={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'general' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2" className="flex items-center gap-2 text-base">
                <Palette aria-hidden="true" className="h-4 w-4 text-[var(--color-muted)]" />
                Theme
              </CardTitle>
              <CardDescription>Choose a color theme for the dashboard.</CardDescription>
            </CardHeader>
            <CardContent>
              <ThemeSwatch />
            </CardContent>
          </Card>

          <ConnectedInstances />
        </>
      )}

      {activeTab === 'accessibility' && (
        <AccessibilitySettings />
      )}

      {activeTab === 'setup' && (
        <>
          <SetupInstructions />
          <DisconnectGuide />
        </>
      )}

      {activeTab === 'account' && (
        <DangerZone />
      )}
    </div>
  );
}
