import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Trash2,
  Archive,
  ArchiveRestore,
  MoreVertical,
  MessageSquare,
  Plug,
  Terminal,
  Send,
  Coins,
  ListTodo,
  Wrench,
  ChevronDown,
  ChevronUp,
  CircleDot,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowDown,
  AlertCircle,
  Play,
  Check,
  ChevronsUpDown,
  BrainCircuit,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { SessionList } from '@/components/sessions/SessionList';
import { useSessionQuery, useDeleteSessionMutation, useSendPromptMutation, usePromptStatusQuery, useArchiveSessionMutation, useUnarchiveSessionMutation, useOlderMessages } from '@/hooks/useSessions';
import { useConfigQuery, useConfigPatchMutation } from '@/hooks/useConfig';
import { useModelsQuery } from '@/hooks/useModels';
import { useInstancesQuery } from '@/hooks/useInstances';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { cn, formatNumber, formatCost, getInstanceLabel } from '@/lib/utils';
import type { SessionMessage, Session, Todo, ToolCall, PendingPrompt } from '@conduit/shared';

// ── Chat commands per instance type ────────────────────────────────────────

const OPENCODE_COMMANDS = [
  { cmd: '/compact', desc: 'Compact conversation context' },
  { cmd: '/cost', desc: 'Show token usage & cost' },
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/bug', desc: 'Report a bug' },
  { cmd: '/init', desc: 'Initialize project config' },
];

const CLAUDE_CODE_COMMANDS = [
  { cmd: '/compact', desc: 'Compact conversation context' },
  { cmd: '/cost', desc: 'Show token usage & cost' },
  { cmd: '/clear', desc: 'Clear conversation history' },
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/bug', desc: 'Report a bug' },
  { cmd: '/init', desc: 'Initialize CLAUDE.md' },
  { cmd: '/memory', desc: 'Edit CLAUDE.md memory files' },
  { cmd: '/review', desc: 'Review a PR' },
  { cmd: '/mcp', desc: 'Manage MCP servers' },
  { cmd: '/terminal-setup', desc: 'Install Shift+Enter key binding' },
  { cmd: '/login', desc: 'Switch account or auth method' },
  { cmd: '/logout', desc: 'Sign out from your account' },
  { cmd: '/doctor', desc: 'Check Anthropic API & auth health' },
  { cmd: '/config', desc: 'Open settings' },
  { cmd: '/vim', desc: 'Enter vim mode' },
  { cmd: '/model', desc: 'Switch or display model' },
  { cmd: '/permissions', desc: 'View & manage tool permissions' },
  { cmd: '/status', desc: 'Show account & session info' },
  { cmd: '/add-dir', desc: 'Add a working directory' },
  { cmd: '/pr-comments', desc: 'View & address PR comments' },
  { cmd: '/release-notes', desc: 'Show release notes' },
  { cmd: '/listen', desc: 'Enter dictation mode' },
];

function getCommandsForInstance(instanceType?: string) {
  if (instanceType === 'claude-code') return CLAUDE_CODE_COMMANDS;
  return OPENCODE_COMMANDS;
}

// ── Relative timestamp component ───────────────────────────────────────────

function LiveTimestamp({ dateStr, className }: { dateStr: string; className?: string }) {
  const display = useRelativeTime(dateStr);
  return <span className={className}>{display}</span>;
}

// ── Todo status icon ───────────────────────────────────────────────────────

function TodoStatusIcon({ status }: { status: Todo['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3 w-3 text-[var(--color-success)] shrink-0" aria-hidden="true" />;
    case 'in_progress':
      return <Loader2 className="h-3 w-3 text-[var(--color-accent)] shrink-0 animate-spin" aria-hidden="true" />;
    case 'cancelled':
      return <XCircle className="h-3 w-3 text-[var(--color-muted)] shrink-0" aria-hidden="true" />;
    default:
      return <CircleDot className="h-3 w-3 text-[var(--color-muted)] shrink-0" aria-hidden="true" />;
  }
}

// ── Tool call status icon ──────────────────────────────────────────────────

function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'completed':
      return <Check className="h-3 w-3 text-[var(--color-success)] shrink-0" aria-hidden="true" />;
    case 'running':
      return <Loader2 className="h-3 w-3 text-[var(--color-accent)] shrink-0 animate-spin" aria-hidden="true" />;
    case 'error':
      return <AlertCircle className="h-3 w-3 text-[var(--color-danger)] shrink-0" aria-hidden="true" />;
    default:
      return <Play className="h-3 w-3 text-[var(--color-muted)] shrink-0" aria-hidden="true" />;
  }
}

// ── Extract display path from tool input ───────────────────────────────────

function getToolDisplayPath(input: Record<string, unknown>): string | null {
  // Common path keys used by tools
  for (const key of ['filePath', 'path', 'pattern', 'scenePath', 'projectPath', 'url']) {
    const val = input[key];
    if (typeof val === 'string' && val.length > 0) {
      // Shorten long absolute paths: show last 2-3 segments
      const segments = val.replace(/\\/g, '/').split('/');
      if (segments.length > 3) {
        return '.../' + segments.slice(-3).join('/');
      }
      return val;
    }
  }
  return null;
}

// ── Expandable tool call card ──────────────────────────────────────────────

function ToolCallCard({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const displayPath = getToolDisplayPath(tc.input);
  const hasDetails = Object.keys(tc.input).length > 0 || !!tc.output;

  return (
    <div className="rounded-lg border border-[var(--color-border)]/60 bg-[var(--color-base)]/50 overflow-hidden">
      <button
        onClick={() => hasDetails && setExpanded(v => !v)}
        className={cn(
          'flex items-center gap-2 w-full px-2.5 py-1.5 text-left transition-colors',
          hasDetails && 'hover:bg-[var(--color-surface)]/60 cursor-pointer',
          !hasDetails && 'cursor-default',
        )}
      >
        <ToolStatusIcon status={tc.status} />
        <code className="text-xs font-mono font-semibold text-[var(--color-accent)] shrink-0">
          {tc.name}
        </code>
        {displayPath && (
          <>
            <span className="text-xs text-[var(--color-muted)]" aria-hidden>·</span>
            <span className="text-xs font-mono text-[var(--color-muted)] truncate min-w-0">
              {displayPath}
            </span>
          </>
        )}
        {hasDetails && (
          <span className="ml-auto shrink-0">
            {expanded
              ? <ChevronUp aria-hidden="true" className="h-2.5 w-2.5 text-[var(--color-muted)]" />
              : <ChevronDown aria-hidden="true" className="h-2.5 w-2.5 text-[var(--color-muted)]" />}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)]/40 px-2.5 py-2 flex flex-col gap-2">
          {/* Input */}
          {Object.keys(tc.input).length > 0 && (
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider mb-0.5">Input</p>
              <div className="text-xs font-mono text-[var(--color-text)] leading-relaxed max-h-40 overflow-y-auto bg-[var(--color-base)] rounded p-1.5 flex flex-col gap-0.5">
                {Object.entries(tc.input).map(([key, val]) => (
                  <div key={key} className="flex gap-1.5">
                    <span className="text-[var(--color-muted)] shrink-0">{key}:</span>
                    <span className="break-all whitespace-pre-wrap">
                      {typeof val === 'string' ? val : JSON.stringify(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Output */}
          {tc.output && (
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider mb-0.5">Output</p>
              <pre className="text-xs font-mono text-[var(--color-text)] whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto bg-[var(--color-base)] rounded p-1.5">
                {tc.output.length > 2000 ? tc.output.slice(0, 2000) + '\n... (truncated)' : tc.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Build the new model ID to write into config.
 * If the chosen model ID already contains a provider prefix (e.g. "anthropic/claude-3-5-sonnet"
 * from OpenRouter), use it as-is. Otherwise preserve the provider prefix already in the
 * current config (e.g. "github-copilot/") and replace only the model suffix.
 */
function buildModelId(modelId: string, currentStored: string | null): string {
  // Model IDs from OpenRouter / multi-provider setups already carry a "provider/model" prefix.
  // Writing them verbatim is correct; trying to graft a different prefix would corrupt the ID.
  if (modelId.includes('/')) return modelId;
  if (!currentStored) return modelId;
  const slash = currentStored.lastIndexOf('/');
  if (slash === -1) return modelId;
  return currentStored.slice(0, slash + 1) + modelId;
}

// ── Model picker ───────────────────────────────────────────────────────────

function ModelPicker({ instanceId, sessionModelID }: { instanceId?: string; sessionModelID?: string }) {
  const { data: configData, isLoading: configLoading } = useConfigQuery(instanceId);
  const { data: modelsData, isLoading: modelsLoading } = useModelsQuery(instanceId);
  const patchMutation = useConfigPatchMutation();

  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const searchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Extract current model from config content
  const configObj = configData?.content && typeof configData.content === 'object' && !Array.isArray(configData.content)
    ? (configData.content as Record<string, unknown>)
    : null;
  const currentModel = typeof configObj?.model === 'string' ? configObj.model : null;

  // Close dropdown on outside click
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing]);

  // Focus search when editing opens
  useEffect(() => {
    if (editing) {
      setSearch('');
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [editing]);

  // Timer cleanup
  useEffect(() => () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current); }, []);

  // Resolve instanceId: prefer the one from configData (authoritative), fall back to the prop
  const resolvedInstanceId = configData?.instanceId ?? instanceId;

  const selectModel = (modelId: string) => {
    if (!modelId || !resolvedInstanceId) return;

    // Preserve any provider prefix already in the config (e.g. "anthropic/")
    const newModelId = buildModelId(modelId, currentModel);
    const newContent = JSON.stringify(
      { ...(configObj ?? {}), model: newModelId },
      null,
      2,
    );

    setSaveStatus('saving');
    setEditing(false);
    patchMutation.mutate(
      { content: newContent, instanceId: resolvedInstanceId },
      {
        onSuccess: () => {
          setSaveStatus('saved');
          if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
          statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 4000);
        },
        onError: () => {
          setSaveStatus('error');
          if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
          statusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
        },
      },
    );
  };

  const isLoading = configLoading || modelsLoading;

  // Available models from the dynamic list synced by the agent.
  const allModels = useMemo(() => modelsData?.models ?? [], [modelsData]);

  // Filter by search
  const filteredModels = useMemo(() => {
    if (!search.trim()) return allModels;
    const q = search.toLowerCase();
    return allModels.filter(
      m =>
        m.modelId.toLowerCase().includes(q) ||
        m.modelName.toLowerCase().includes(q) ||
        m.providerId.toLowerCase().includes(q),
    );
  }, [allModels, search]);

  // Group filtered models by provider
  const groupedModels = useMemo(() => {
    const groups = new Map<string, typeof filteredModels>();
    for (const m of filteredModels) {
      if (!groups.has(m.providerId)) groups.set(m.providerId, []);
      groups.get(m.providerId)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filteredModels]);

  // Effective display model: prefer the session's actual model (what was used),
  // fall back to the configured model (what will be used next).
  const displayModel = sessionModelID ?? currentModel;

  // Can change model if we have an instance to write config into.
  // An empty model list is allowed — the dropdown will show a "no models" message.
  const canEdit = !isLoading && !!resolvedInstanceId && (!!configData || !!instanceId);

  return (
    <div className="flex items-center gap-2.5 px-3 border-b border-[var(--color-border)] shrink-0 min-w-0 bg-[var(--color-surface-alt)]" style={{ minHeight: '2.75rem' }}>
      <BrainCircuit className="h-4 w-4 text-[var(--color-accent)] shrink-0" />
      <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)] shrink-0">Model</span>

      {isLoading ? (
        <Skeleton className="h-5 w-32 ml-1" />
      ) : !canEdit && !sessionModelID && !displayModel ? (
        <span className="text-sm text-[var(--color-muted)] italic ml-1">No config synced</span>
      ) : (
        <div className="relative flex-1 min-w-0" ref={dropdownRef}>
          <button
            onClick={() => { if (canEdit) setEditing(v => !v); }}
            className={cn(
              'flex items-center gap-1.5 max-w-full px-2 py-1 rounded-md text-sm font-medium transition-colors',
              canEdit && 'hover:bg-[var(--color-surface-hover)] border border-transparent hover:border-[var(--color-border)]',
              !canEdit && 'cursor-default',
              saveStatus === 'saved' && 'text-[var(--color-success)]',
              saveStatus === 'error' && 'text-[var(--color-danger)]',
              saveStatus === 'saving' && 'opacity-60 pointer-events-none',
              saveStatus === 'idle' && 'text-[var(--color-text)]',
            )}
            disabled={saveStatus === 'saving' || !canEdit}
            aria-label="Change model"
            aria-expanded={editing}
            aria-haspopup="listbox"
          >
            {saveStatus === 'saving' ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : saveStatus === 'saved' ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            ) : saveStatus === 'error' ? (
              <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            ) : null}
            <span className="truncate">
              {saveStatus === 'saved'
                ? 'Saved \u2014 applies on restart'
                : saveStatus === 'error'
                  ? 'Error'
                  : displayModel ?? 'Not set'}
            </span>
            {canEdit && <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />}
          </button>

          {editing && (
            <div
              className="absolute top-full left-0 mt-1 w-[calc(100vw-2rem)] sm:w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl z-30 overflow-hidden"
              role="listbox"
              aria-label="Select model"
            >
              {/* Search input */}
              <div className="p-2 border-b border-[var(--color-border)]">
                <input
                  ref={searchRef}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
                  placeholder="Search models…"
                  className="w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-base)] text-[var(--color-text)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/50"
                />
              </div>
              {/* Model list grouped by provider */}
              <div className="max-h-72 overflow-y-auto py-1">
                {groupedModels.length === 0 ? (
                  <p className="px-3 py-4 text-xs text-[var(--color-muted)] text-center">
                    {search.trim() ? 'No models match your search' : 'No models available'}
                  </p>
                ) : (
                  groupedModels.map(([providerId, models]) => (
                    <div key={providerId}>
                      <p className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                        {providerId}
                      </p>
                      {models.map(m => {
                        const isActive = currentModel !== null && (
                          currentModel === m.modelId ||
                          currentModel.endsWith('/' + m.modelId) ||
                          // Claude Code may store versioned IDs (e.g. claude-haiku-4-5-20251001)
                          // that match short aliases (claude-haiku-4-5) by prefix
                          (currentModel.startsWith(m.modelId + '-') && /\d{8}$/.test(currentModel))
                        );
                        return (
                          <button
                            key={`${m.providerId}/${m.modelId}`}
                            className={cn(
                              'flex items-center gap-2 w-full px-3 py-2 min-h-[40px] text-left text-xs hover:bg-[var(--color-base)] transition-colors',
                              isActive && 'bg-[var(--color-accent)]/10',
                            )}
                            onClick={() => selectModel(m.modelId)}
                            role="option"
                            aria-selected={isActive}
                          >
                            <span className="flex-1 truncate text-[var(--color-text)]">{m.modelName}</span>
                            <span className="font-mono text-[var(--color-muted)] truncate text-[10px] max-w-[7rem]">{m.modelId}</span>
                            {isActive && <Check aria-hidden="true" className="h-3 w-3 text-[var(--color-accent)] shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Unified collapsible info panel (cost + todos + MCP tools) ─────────────

function SessionInfoPanel({
  session,
  todos,
  mcpTools,
}: {
  session: Session;
  todos: Todo[];
  mcpTools: Array<{ server: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);

  const hasCost = !!(session.tokens || session.cost);
  const hasTodos = todos.length > 0;
  const hasMcp = mcpTools.length > 0;
  if (!hasCost && !hasTodos && !hasMcp) return null;

  // Summary line shown in the collapsed pill
  const summaryParts: string[] = [];
  if (hasCost) summaryParts.push(formatCost(session.cost?.totalCost ?? 0));
  if (hasTodos) {
    const done = todos.filter(t => t.status === 'completed').length;
    summaryParts.push(`${done}/${todos.length} todos`);
  }
  if (hasMcp) summaryParts.push(`${mcpTools.length} tools`);

  return (
    <div className="relative border-b border-[var(--color-border)] shrink-0 bg-[var(--color-surface-alt)]">
      {/* Collapsed toggle bar */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2.5 w-full px-4 text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] transition-colors"
        style={{ minHeight: '2.5rem' }}
        aria-expanded={open}
      >
        <Coins aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-warning)] shrink-0" />
        <span className="flex-1 text-left truncate text-sm font-medium">{summaryParts.join(' · ')}</span>
        {open ? <ChevronUp aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" /> : <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />}
      </button>

      {/* Expanded content — overlays on top of messages, does not push them down */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 flex flex-col bg-[var(--color-surface-alt)] border border-[var(--color-border)] shadow-xl overflow-y-auto" style={{ maxHeight: '50vh' }}>
          {/* Token details (cost amount already shown in collapsed bar) */}
          {hasCost && session.tokens && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-t border-[var(--color-border)]/50 text-xs text-[var(--color-muted)]">
              <span>In: {formatNumber(session.tokens.input)}</span>
              <span>Out: {formatNumber(session.tokens.output)}</span>
              {session.tokens.reasoning > 0 && <span>Reasoning: {formatNumber(session.tokens.reasoning)}</span>}
              {session.tokens.cacheRead > 0 && <span>Cache R: {formatNumber(session.tokens.cacheRead)}</span>}
              {session.tokens.cacheWrite > 0 && <span>Cache W: {formatNumber(session.tokens.cacheWrite)}</span>}
              <span className="font-medium text-[var(--color-text)]">Total: {formatNumber(session.tokens.total)}</span>
              {session.cost?.modelID && (
                <span className="ml-auto text-[var(--color-accent)]">{session.cost.modelID}</span>
              )}
            </div>
          )}

          {/* Todos */}
          {hasTodos && (
            <div className="px-4 py-2 border-t border-[var(--color-border)]/50 flex flex-col gap-1">
              <p className="text-xs font-medium text-[var(--color-muted)] flex items-center gap-1.5 mb-0.5">
                <ListTodo aria-hidden="true" className="h-3 w-3 text-[var(--color-accent)]" />
                TODOs
                <span className="ml-auto">{todos.filter(t => t.status === 'completed').length}/{todos.length}</span>
              </p>
              {todos.map((todo, i) => (
                <div key={i} className="flex items-start gap-2 py-0.5">
                  <TodoStatusIcon status={todo.status} />
                  <span
                    className={cn(
                      'text-xs leading-snug',
                      todo.status === 'completed' || todo.status === 'cancelled'
                        ? 'text-[var(--color-muted)] line-through'
                        : 'text-[var(--color-text)]',
                    )}
                  >
                    {todo.content}
                  </span>
                  {todo.priority === 'high' && (
                    <Badge variant="outline" className="text-xs px-1 py-0 ml-auto shrink-0 text-[var(--color-danger)]/70 border-[var(--color-danger)]/30">high</Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* MCP Tools */}
          {hasMcp && (
            <div className="px-4 py-2 border-t border-[var(--color-border)]/50">
              <p className="text-xs font-medium text-[var(--color-muted)] flex items-center gap-1.5 mb-1">
                <Wrench aria-hidden="true" className="h-3 w-3 text-[var(--color-accent)]" />
                MCP Tools
                <span className="ml-auto">{mcpTools.length}</span>
              </p>
              {Array.from(
                mcpTools.reduce((map, t) => {
                  if (!map.has(t.server)) map.set(t.server, []);
                  map.get(t.server)!.push(t.name);
                  return map;
                }, new Map<string, string[]>()).entries()
              ).map(([server, names]) => (
                <div key={server} className="mb-1.5">
                  <p className="text-xs font-medium text-[var(--color-muted)] mb-0.5">{server}</p>
                  <div className="flex flex-wrap gap-1">
                    {names.map(name => (
                      <Badge key={name} variant="secondary" className="text-xs font-mono px-1.5 py-0">
                        {name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────

function MessageBubble({ msg, instanceType }: { msg: SessionMessage; instanceType?: string }) {
  const isUser = msg.role === 'user';
  const isTool = msg.role === 'tool';
  const isSystem = msg.role === 'system';

  // Build author label: for assistant, show "OpenCode (model)" or "Claude Code (model)"
  let authorLabel: string;
  if (isUser) {
    authorLabel = 'User';
  } else if (isTool) {
    authorLabel = msg.author ?? 'Tool';
  } else if (isSystem) {
    authorLabel = msg.author ?? 'System';
  } else {
    const base = getInstanceLabel(instanceType);
    authorLabel = msg.modelID ? `${base} (${msg.modelID})` : base;
  }

  // System messages render as a subtle centred divider, not a bubble
  if (isSystem) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <span className="text-xs text-[var(--color-muted)] shrink-0 px-1">{msg.content || authorLabel}</span>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-1 max-w-[88%] sm:max-w-[72%]',
        isUser ? 'ml-auto items-end' : 'mr-auto items-start',
      )}
    >
      {/* Author badge */}
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-none max-w-full',
          isUser
            ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
            : isTool
              ? 'bg-[var(--color-border)] text-[var(--color-muted)]'
              : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-muted)]',
        )}
      >
        <span className="truncate">{authorLabel}</span>
      </span>

      {/* Bubble */}
      <div
        className={cn(
          'rounded-2xl px-3.5 py-2.5 text-sm',
          isUser
            ? 'bg-[var(--color-accent)]/12 border border-[var(--color-accent)]/20 rounded-tr-sm'
            : isTool
              ? 'bg-[var(--color-base)] border border-[var(--color-border)] rounded-tl-sm'
              : 'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-tl-sm',
        )}
      >
        {isTool ? (
          <pre className="text-xs font-mono text-[var(--color-text)] whitespace-pre-wrap break-all leading-relaxed overflow-x-auto max-h-48 overflow-y-auto">
            {msg.content}
          </pre>
        ) : msg.content ? (
          <MarkdownContent
            content={msg.content}
            className="text-[var(--color-text)] leading-relaxed"
          />
        ) : null}
        {/* Tool calls — detailed display */}
        {msg.toolCalls?.length ? (
          <div className={cn('flex flex-col gap-1.5', msg.content && 'mt-2 pt-2 border-t border-[var(--color-border)]/50')}>
            {msg.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} tc={tc} />
            ))}
          </div>
        ) : null}
        <LiveTimestamp
          dateStr={msg.createdAt}
          className={cn('text-xs text-[var(--color-muted)] mt-1.5 block', isUser ? 'text-left' : 'text-right')}
        />
      </div>
    </div>
  );
}

// ── Pending prompt bubble ──────────────────────────────────────────────────
// Shows a dashboard-sent prompt in the chat before the agent processes it.

function PendingPromptBubble({ prompt }: { prompt: PendingPrompt }) {
  const statusIcon = prompt.status === 'pending' || prompt.status === 'processing'
    ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin text-[var(--color-muted)]" />
    : prompt.status === 'failed'
      ? <AlertCircle aria-hidden="true" className="h-3 w-3 text-[var(--color-danger)]" />
      : <Check aria-hidden="true" className="h-3 w-3 text-[var(--color-success)]" />;

  const statusText = prompt.status === 'pending'
    ? 'Queued — waiting for agent…'
    : prompt.status === 'processing'
      ? 'Agent is processing…'
      : prompt.status === 'failed'
        ? 'Delivery failed'
        : 'Sent to agent';

  return (
    <div className="flex flex-col gap-1 max-w-[88%] sm:max-w-[72%] ml-auto items-end opacity-80">
      {/* Author badge */}
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-none max-w-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
        <span className="truncate">You (dashboard)</span>
      </span>
      {/* Bubble */}
      <div className="rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm bg-[var(--color-accent)]/12 border border-[var(--color-accent)]/20">
        <p className="text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words">
          {prompt.content}
        </p>
        <div className="flex items-center justify-end gap-1.5 mt-1.5">
          {statusIcon}
          <span className={cn(
            'text-xs',
            prompt.status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]',
          )}>
            {statusText}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Commands popover ───────────────────────────────────────────────────────

function CommandsPopover({
  commands,
  onSelect,
  onClose,
}: {
  commands: Array<{ cmd: string; desc: string }>;
  onSelect: (cmd: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-52 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-10">
      {commands.map(({ cmd, desc }) => (
        <button
          key={cmd}
          className="flex items-center gap-3 w-full px-3 py-2.5 min-h-[44px] text-left hover:bg-[var(--color-base)] transition-colors"
          onClick={() => { onSelect(cmd); onClose(); }}
        >
          <code className="text-xs font-mono text-[var(--color-accent)] shrink-0">{cmd}</code>
          <span className="text-xs text-[var(--color-muted)] truncate">{desc}</span>
        </button>
      ))}
    </div>
  );
}

// ── Prompt input ───────────────────────────────────────────────────────────

function PromptInput({
  sessionId,
  instanceType,
  onSend,
  placeholder,
}: {
  sessionId: string;
  instanceType?: string;
  onSend?: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [lastPromptId, setLastPromptId] = useState<string | undefined>();
  const sendMutation = useSendPromptMutation();
  const { data: promptStatus } = usePromptStatusQuery(
    lastPromptId ? sessionId : undefined,
    lastPromptId,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Message history state
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  const commands = getCommandsForInstance(instanceType);

  // Filter commands if input starts with /
  const filteredCommands = value.startsWith('/')
    ? commands.filter(c => c.cmd.startsWith(value.split(' ')[0] ?? ''))
    : commands;

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || sendMutation.isPending) return;

    // Push to history (avoid consecutive duplicates)
    if (historyRef.current[historyRef.current.length - 1] !== trimmed) {
      historyRef.current.push(trimmed);
      // Keep last 50 entries
      if (historyRef.current.length > 50) historyRef.current.shift();
    }
    historyIndexRef.current = -1;
    draftRef.current = '';

    // Detect slash commands — match if the input starts with /
    // and the first word matches a known command for this instance type
    const isCommand = trimmed.startsWith('/') && commands.some(
      c => trimmed === c.cmd || trimmed.startsWith(c.cmd + ' '),
    );

    setLastPromptId(undefined);

    // Haptic feedback on send (Android native only)
    if (Capacitor.isNativePlatform()) {
      void import('@capacitor/haptics').then(({ Haptics, ImpactStyle }) => {
        void Haptics.impact({ style: ImpactStyle.Light });
      });
    }

    sendMutation.mutate(
      { sessionId, content: trimmed, isCommand },
      {
        onSuccess: (data) => {
          setLastPromptId(data.promptId);
        },
      },
    );
    setValue('');
    setShowCommands(false);
    onSend?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Escape') {
      setShowCommands(false);
      return;
    }

    // UP/DOWN arrow history navigation (only when cursor is at start/end of single-line input)
    const ta = textareaRef.current;
    if (!ta) return;
    const isMultiLine = value.includes('\n');

    if (e.key === 'ArrowUp' && !isMultiLine && ta.selectionStart === 0 && historyRef.current.length > 0) {
      e.preventDefault();
      if (historyIndexRef.current === -1) {
        // Save current draft before navigating history
        draftRef.current = value;
        historyIndexRef.current = historyRef.current.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      setValue(historyRef.current[historyIndexRef.current] ?? '');
      return;
    }

    if (e.key === 'ArrowDown' && !isMultiLine && historyIndexRef.current >= 0) {
      e.preventDefault();
      if (historyIndexRef.current < historyRef.current.length - 1) {
        historyIndexRef.current += 1;
        setValue(historyRef.current[historyIndexRef.current] ?? '');
      } else {
        // Back to draft
        historyIndexRef.current = -1;
        setValue(draftRef.current);
      }
      return;
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [value]);

  // Auto-dismiss "Delivered" status after 3 seconds
  const deliveredTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (deliveredTimerRef.current) clearTimeout(deliveredTimerRef.current);
    const isDelivered = lastPromptId && (!promptStatus || promptStatus.status === 'delivered');
    if (isDelivered) {
      deliveredTimerRef.current = setTimeout(() => setLastPromptId(undefined), 3000);
    }
    return () => { if (deliveredTimerRef.current) clearTimeout(deliveredTimerRef.current); };
  }, [lastPromptId, promptStatus]);

  // Show commands popover when input starts with /
  useEffect(() => {
    if (value.startsWith('/') && filteredCommands.length > 0) {
      setShowCommands(true);
    } else {
      setShowCommands(false);
    }
  }, [value, filteredCommands.length]);

  // Derive status message
  let statusMsg: { text: string; color: string } | null = null;
  if (sendMutation.isError) {
    const errText = sendMutation.error instanceof Error ? sendMutation.error.message : 'Failed to send';
    statusMsg = { text: errText, color: 'text-[var(--color-danger)]' };
  } else if (lastPromptId) {
    if (!promptStatus) {
      // Row deleted or not found — treat as delivered
      statusMsg = { text: 'Delivered to agent', color: 'text-[var(--color-success)]' };
    } else if (promptStatus.status === 'pending') {
      statusMsg = { text: 'Queued — waiting for agent to pick up…', color: 'text-[var(--color-muted)]' };
    } else if (promptStatus.status === 'processing') {
      statusMsg = { text: 'Agent is processing…', color: 'text-[var(--color-muted)]' };
    } else if (promptStatus.status === 'delivered') {
      statusMsg = { text: 'Delivered to agent', color: 'text-[var(--color-success)]' };
    } else if (promptStatus.status === 'failed') {
      statusMsg = { text: 'Agent failed to process the prompt', color: 'text-[var(--color-danger)]' };
    }
  }

  return (
    <div className="px-4 py-3 border-t border-[var(--color-border)] shrink-0 relative">
      {showCommands && (
        <CommandsPopover
          commands={filteredCommands}
          onSelect={(cmd) => { setValue(cmd + ' '); textareaRef.current?.focus(); }}
          onClose={() => setShowCommands(false)}
        />
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? `Message… (/ for commands)`}
          aria-label="Send a message to the agent"
          rows={1}
          className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/50"
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!value.trim() || sendMutation.isPending}
          className="h-9 w-9 shrink-0"
          aria-label="Send message"
        >
          {sendMutation.isPending ? (
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          ) : (
            <Send aria-hidden="true" className="h-4 w-4" />
          )}
        </Button>
      </div>
      {statusMsg && (
        <p className={cn('text-xs mt-1', statusMsg.color)}>{statusMsg.text}</p>
      )}
    </div>
  );
}

// ── Auto-scroll hook ───────────────────────────────────────────────────────
// Pauses auto-scroll when the user scrolls up. Resumes when:
//  1. The user scrolls back to the bottom manually
//  2. The user clicks the "Resume" / scroll-to-bottom button
//  3. The user sends a new prompt (calls scrollToBottom via onSend)

function useAutoScroll(deps: unknown[], onScrollNearTop?: () => void, isLoadingHistory = false) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const prevSessionId = useRef<string | null>(null);
  // Track programmatic scrolls via a monotonic counter — each programmatic
  // scroll increments the counter.  The scroll handler compares to a "consumed"
  // snapshot; as long as they differ, the current scroll is programmatic.
  // Unlike the previous timestamp approach, this is immune to browser timer
  // throttling when the tab is unfocused.
  const programmaticScroll = useRef(0);
  const consumedScroll = useRef(0);
  // Keep callback ref stable to avoid re-subscribing scroll listener
  const onScrollNearTopRef = useRef(onScrollNearTop);
  onScrollNearTopRef.current = onScrollNearTop;
  // Track when the container DOM element is mounted so the scroll effect re-runs
  const [containerMounted, setContainerMounted] = useState(false);

  // Callback ref: called when the container DOM element is attached/detached
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    setContainerMounted(!!node);
  }, []);

  // Check if container is near bottom
  const checkNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Scroll to bottom and resume auto-scroll
  const scrollToBottom = useCallback((smooth = true) => {
    programmaticScroll.current++;
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' });
    setIsPaused(false);
    setIsAtBottom(true);
  }, []);

  // Force scroll on session change
  const resetForSession = useCallback((sessionId: string) => {
    if (prevSessionId.current !== sessionId) {
      prevSessionId.current = sessionId;
      setIsPaused(false);
      setIsAtBottom(true);
      // Use rAF to ensure DOM is rendered
      requestAnimationFrame(() => {
        programmaticScroll.current++;
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
    }
  }, []);

  /**
   * Preserve scroll position after prepending content at the top.
   * Call this BEFORE updating state, then call the returned function AFTER render.
   */
  const saveScrollPosition = useCallback(() => {
    const el = containerRef.current;
    if (!el) return () => {};
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;
    return () => {
      requestAnimationFrame(() => {
        const newScrollHeight = el.scrollHeight;
        const delta = newScrollHeight - prevScrollHeight;
        programmaticScroll.current++;
        el.scrollTop = prevScrollTop + delta;
      });
    };
  }, []);

  // Handle user scroll — detect direction to know if scrolling up
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let lastScrollTop = el.scrollTop;
    let ticking = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        // If this is a programmatic scroll (counter hasn't been consumed), skip detection
        if (programmaticScroll.current !== consumedScroll.current) {
          lastScrollTop = el.scrollTop;
          // Consume once scroll settles (no new scroll events for 150ms)
          // This handles both scroll-to-bottom and scroll-restore-to-middle
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            consumedScroll.current = programmaticScroll.current;
          }, 150);
          ticking = false;
          return;
        }

        const nearBottom = checkNearBottom();
        const scrolledUp = el.scrollTop < lastScrollTop;
        lastScrollTop = el.scrollTop;

        // Detect scroll near top for lazy loading (within 100px of top)
        if (el.scrollTop < 100 && onScrollNearTopRef.current) {
          onScrollNearTopRef.current();
        }

        if (nearBottom) {
          // User scrolled back to the bottom — resume auto-scroll
          setIsPaused(false);
          setIsAtBottom(true);
        } else if (scrolledUp) {
          // User actively scrolled upward — pause auto-scroll
          setIsPaused(true);
          setIsAtBottom(false);
        } else {
          // Scrolling down but not at bottom yet
          setIsAtBottom(false);
        }
        ticking = false;
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [checkNearBottom, containerMounted]);

  // Auto-scroll when deps change (new messages), only if not paused.
  // Uses 'instant' instead of 'smooth' — smooth scroll can take longer than
  // the 150ms settle timer, causing the scroll handler to misinterpret the
  // tail end of the animation as a user scroll-up and permanently pause.
  useEffect(() => {
    if (!isPaused && !isLoadingHistory) {
      programmaticScroll.current++;
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef: setContainerRef, containerElRef: containerRef, bottomRef, isAtBottom, isPaused, scrollToBottom, resetForSession, programmaticScroll, saveScrollPosition };
}

// ── Confirm dialog ─────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl w-full max-w-sm mx-4 p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 id="confirm-dialog-title" className="text-sm font-semibold text-[var(--color-text)] mb-1">
          {title}
        </h3>
        <p className="text-sm text-[var(--color-muted)] mb-5">{description}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Session actions dropdown ───────────────────────────────────────────────

function SessionActionsMenu({
  sessionId,
  isArchived,
  onArchived,
  onDeleted,
}: {
  sessionId: string;
  isArchived: boolean;
  onArchived?: () => void;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archiveMutation = useArchiveSessionMutation();
  const unarchiveMutation = useUnarchiveSessionMutation();
  const deleteMutation = useDeleteSessionMutation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleArchive = () => {
    setOpen(false);
    archiveMutation.mutate(sessionId, { onSuccess: () => onArchived?.() });
  };

  const handleUnarchive = () => {
    setOpen(false);
    unarchiveMutation.mutate(sessionId);
  };

  const handleDelete = () => {
    setConfirmDelete(false);
    deleteMutation.mutate(sessionId, { onSuccess: () => onDeleted?.() });
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete session?"
        description="This permanently removes the session and all its messages. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
      <div className="relative" ref={menuRef}>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label="Session actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <MoreVertical aria-hidden="true" className="h-4 w-4" />
        </Button>
        {open && (
          <div
            className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-20 overflow-hidden"
            role="menu"
          >
            {isArchived ? (
              <button
                role="menuitem"
                className="flex items-center gap-2.5 w-full px-3 py-2.5 min-h-[44px] text-sm text-[var(--color-text)] hover:bg-[var(--color-base)] transition-colors"
                onClick={handleUnarchive}
                disabled={unarchiveMutation.isPending}
              >
                <ArchiveRestore aria-hidden="true" className="h-4 w-4 text-[var(--color-muted)]" />
                Unarchive
              </button>
            ) : (
              <button
                role="menuitem"
                className="flex items-center gap-2.5 w-full px-3 py-2.5 min-h-[44px] text-sm text-[var(--color-text)] hover:bg-[var(--color-base)] transition-colors"
                onClick={handleArchive}
                disabled={archiveMutation.isPending}
              >
                <Archive aria-hidden="true" className="h-4 w-4 text-[var(--color-muted)]" />
                Archive
              </button>
            )}
            <div className="h-px bg-[var(--color-border)]" role="separator" />
            <button
              role="menuitem"
              className="flex items-center gap-2.5 w-full px-3 py-2.5 min-h-[44px] text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
              onClick={() => { setOpen(false); setConfirmDelete(true); }}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Delete
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Session detail ─────────────────────────────────────────────────────────

// ── Message skeleton for lazy loading ──────────────────────────────────────

function MessageSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={cn('flex flex-col gap-1.5', i % 2 === 0 ? 'items-start' : 'items-end')}>
          <Skeleton className={cn('h-4 rounded', i % 2 === 0 ? 'w-20' : 'w-16')} />
          <Skeleton className={cn('rounded-2xl', i % 2 === 0 ? 'h-14 w-3/4' : 'h-10 w-2/3')} />
        </div>
      ))}
    </div>
  );
}

function SessionDetail({ id }: { id: string }) {
  const { data, isLoading, error } = useSessionQuery(id);
  const navigate = useNavigate();
  // Track archived state locally so the menu reflects it immediately
  const [isArchived, setIsArchived] = useState(false);

  // Older messages pagination
  const { olderMessages, hasMore, isLoadingOlder, loadOlder, setHasMore } = useOlderMessages(id);

  // Sync hasMore from initial response
  useEffect(() => {
    if (data?.hasMore !== undefined) {
      setHasMore(data.hasMore);
    }
  }, [data?.hasMore, setHasMore]);

  // Combine older + current messages, deduplicated by ID
  const allMessages = useMemo(() => {
    const current = data?.messages ?? [];
    if (olderMessages.length === 0) return current;
    const seenIds = new Set(current.map(m => m.id));
    const unique = olderMessages.filter(m => !seenIds.has(m.id));
    return [...unique, ...current];
  }, [data?.messages, olderMessages]);

  // Handle scroll-near-top to load older messages
  const handleScrollNearTop = useCallback(() => {
    if (!hasMore || isLoadingOlder || allMessages.length === 0) return;
    const oldestId = allMessages[0]?.id;
    if (oldestId) loadOlder(oldestId);
  }, [hasMore, isLoadingOlder, allMessages, loadOlder]);

  // Use the last message ID as the scroll dependency instead of message count.
  // message count can plateau at the page limit (50), preventing auto-scroll
  // when new messages push old ones out of the window.
  // Also track content length and tool call count of the last message so
  // auto-scroll re-fires as streaming content grows within the same message.
  const lastMsg = data?.messages[data.messages.length - 1];
  const lastMessageId = lastMsg?.id;
  const { containerRef, containerElRef, bottomRef, isAtBottom, isPaused, scrollToBottom, resetForSession, programmaticScroll: programmaticScrollRef } = useAutoScroll(
    [lastMessageId, data?.messages.length, lastMsg?.content?.length, lastMsg?.toolCalls?.length],
    handleScrollNearTop,
    isLoadingOlder,
  );

  // Preserve scroll position when older messages are prepended
  const prevOlderCountRef = useRef(0);
  useLayoutEffect(() => {
    if (olderMessages.length > prevOlderCountRef.current && prevOlderCountRef.current > 0) {
      // Older messages were added — restore scroll position
      const el = containerElRef.current;
      if (el) {
        // saveScrollPosition was already called before the state update
        // but since we can't pre-call it, we use a simpler approach:
        // the scroll position is preserved by the browser for bottom-anchored content
      }
    }
    prevOlderCountRef.current = olderMessages.length;
  }, [olderMessages.length, containerElRef]);

  // Actually preserve scroll when older messages load
  const scrollSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // Take snapshot before older messages render
  useEffect(() => {
    if (isLoadingOlder) {
      const el = containerElRef.current;
      if (el) {
        scrollSnapshotRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      }
    }
  }, [isLoadingOlder, containerElRef]);

  // Restore scroll after older messages are prepended
  useLayoutEffect(() => {
    const snapshot = scrollSnapshotRef.current;
    const el = containerElRef.current;
    if (snapshot && el && !isLoadingOlder && olderMessages.length > 0) {
      const delta = el.scrollHeight - snapshot.scrollHeight;
      if (delta > 0) {
        programmaticScrollRef.current++;
        el.scrollTop = snapshot.scrollTop + delta;
      }
      scrollSnapshotRef.current = null;
    }
  }, [olderMessages.length, isLoadingOlder, containerElRef, programmaticScrollRef]);

  // Reset scroll on session change
  useEffect(() => {
    resetForSession(id);
  }, [id, resetForSession]);

  const rawPendingPrompts = data?.pendingPrompts;

  // Build a set of real user message contents so we can detect when the agent
  // has processed a pending prompt and its message has arrived in allMessages.
  // Must be called before any early returns to satisfy Rules of Hooks.
  const realUserContents = useMemo(
    () => new Set(allMessages.filter(m => m.role === 'user').map(m => m.content.trim())),
    [allMessages],
  );

  // Decide which pending-prompt bubbles to show:
  //   'failed'    → always show (delivery error, no real message will ever arrive)
  //   'pending'   → always show (agent hasn't seen it yet)
  //   'processing'/'delivered' → show ONLY if the matching real user message has
  //                              NOT yet appeared in allMessages, preventing the
  //                              bubble from vanishing before the real message
  //                              arrives while also preventing a double display
  //                              once it does arrive.
  const visiblePendingPrompts = useMemo(
    () => (rawPendingPrompts ?? []).filter(
      p => p.status === 'failed'
        || p.status === 'pending'
        || !realUserContents.has(p.content.trim()),
    ),
    [rawPendingPrompts, realUserContents],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-col gap-3 mt-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className={cn('h-16 rounded-2xl', i % 2 === 0 ? 'w-3/4' : 'w-2/3 ml-auto')} />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <MessageSquare aria-hidden="true" className="h-10 w-10 text-[var(--color-muted)] mb-3" />
        <p className="text-sm text-[var(--color-muted)]">Could not load session</p>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          Make sure your OpenCode instance is running and connected.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <MessageSquare aria-hidden="true" className="h-10 w-10 text-[var(--color-muted)] mb-3" />
        <p className="text-sm text-[var(--color-muted)]">Session not found</p>
      </div>
    );
  }

  const { session, todos, mcpTools } = data;
  const messages = allMessages;

  const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'warning'> = {
    active: 'default',
    idle: 'secondary',
    completed: 'outline',
    error: 'destructive',
    compacting: 'warning',
  };

  const statusLabel: Record<string, string> = {
    active: 'Active',
    idle: 'Idle',
    completed: 'Completed',
    error: 'Error',
    compacting: 'Compacting',
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--color-border)] shrink-0 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate('/sessions')}
          aria-label="Back to sessions"
          className="lg:hidden h-9 w-9 shrink-0"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text)] truncate leading-tight">
            {session.title ?? `Session ${session.id.slice(0, 8)}`}
          </h2>
          <div className="flex flex-col gap-0.5 mt-0.5 min-w-0">
            <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
              <Badge variant={statusVariant[session.status] ?? 'secondary'} className="text-xs px-1.5 py-0 shrink-0">
                {statusLabel[session.status] ?? session.status}
              </Badge>
              {session.instanceType && (
                <Badge variant="outline" className="text-xs px-1.5 py-0 shrink-0">
                  {getInstanceLabel(session.instanceType)}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">
                {(data.totalMessages ?? 0) > messages.length
                  ? `${messages.length.toLocaleString()}/${(data.totalMessages ?? messages.length).toLocaleString()} messages`
                  : `${messages.length.toLocaleString()} messages`}
              </span>
              <span className="text-xs text-[var(--color-muted)]">·</span>
              <span className="text-xs text-[var(--color-muted)]">
                <LiveTimestamp dateStr={session.updatedAt} />
              </span>
            </div>
          </div>
        </div>
        <SessionActionsMenu
          sessionId={session.id}
          isArchived={isArchived}
          onArchived={() => setIsArchived(true)}
          onDeleted={() => navigate('/sessions')}
        />
      </div>

      {/* Model picker — always visible, quick model switching */}
      <ModelPicker instanceId={session.instanceId} sessionModelID={session.cost?.modelID} />

      {/* Collapsible info panel (cost + todos + MCP) — collapsed by default */}
      <SessionInfoPanel session={session} todos={todos ?? []} mcpTools={mcpTools ?? []} />

      {/* Messages — flex-1 min-h-0 ensures it takes remaining space without overflow */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto p-4 scrollbar-visible"
        >
          {messages.length === 0 && visiblePendingPrompts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <MessageSquare aria-hidden="true" className="h-8 w-8 text-[var(--color-muted)] mb-2" />
              <p className="text-sm text-[var(--color-muted)]">No messages in this session</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Loading skeleton for older messages */}
              {isLoadingOlder && <MessageSkeleton count={3} />}
              {/* Hint to scroll up for more */}
              {hasMore && !isLoadingOlder && (
                <p className="text-center text-xs text-[var(--color-muted)] py-1">
                  Scroll up to load older messages
                </p>
              )}
              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} instanceType={session.instanceType} />
              ))}
              {/* Dashboard-sent prompts — shown until the agent processes them */}
              {visiblePendingPrompts.map((p) => (
                <PendingPromptBubble key={p.id} prompt={p} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Scroll-to-bottom / Resume auto-scroll button */}
        {(!isAtBottom || isPaused) && messages.length > 0 && (
          <button
            onClick={() => scrollToBottom()}
            className={cn(
              'absolute bottom-3 right-5 flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg hover:bg-[var(--color-base)] transition-colors z-10',
              isPaused ? 'px-3 h-8' : 'h-8 w-8 justify-center',
            )}
            aria-label={isPaused ? 'Resume auto-scroll' : 'Scroll to bottom'}
          >
            <ArrowDown aria-hidden="true" className="h-4 w-4 text-[var(--color-accent)]" />
            {isPaused && (
              <span className="text-xs font-medium text-[var(--color-accent)]">Resume</span>
            )}
          </button>
        )}
      </div>

      {/* Awaiting-response banner — shown when Claude Code is idle (waiting for questionnaire/confirmation) */}
      {session.status === 'idle' && session.instanceType === 'claude-code' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-accent)]/8 border-t border-[var(--color-accent)]/20 shrink-0">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-accent)] animate-spin shrink-0" />
          <span className="text-xs text-[var(--color-accent)] font-medium">Awaiting your response — type your answer below</span>
        </div>
      )}

      {/* Prompt input */}
      <PromptInput
        sessionId={session.id}
        instanceType={session.instanceType}
        onSend={() => scrollToBottom()}
        placeholder={
          session.status === 'idle' && session.instanceType === 'claude-code'
            ? 'Type your answer or yes/no…'
            : undefined
        }
      />
    </div>
  );
}

// ── Empty states ───────────────────────────────────────────────────────────

function NoInstancesState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-4 px-4">
      <Plug aria-hidden="true" className="h-12 w-12 text-[var(--color-muted)] opacity-40" />
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">No agent connected</p>
        <p className="text-sm text-[var(--color-muted)] mt-1 max-w-sm mx-auto">
          Connect an OpenCode or Claude Code instance to see sessions here.
        </p>
      </div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 max-w-md w-full">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left">
          <div className="flex items-center gap-2 mb-1">
            <Plug aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-accent)]" />
            <span className="text-sm font-medium text-[var(--color-text)]">OpenCode</span>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Run the register command from{' '}
            <Link to="/settings" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings
            </Link>
          </p>
        </div>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left">
          <div className="flex items-center gap-2 mb-1">
            <Terminal aria-hidden="true" className="h-3.5 w-3.5 text-[var(--color-accent)]" />
            <span className="text-sm font-medium text-[var(--color-text)]">Claude Code</span>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Install hooks from{' '}
            <Link to="/settings" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <MessageSquare aria-hidden="true" className="h-12 w-12 text-[var(--color-muted)] mb-3 opacity-40" />
      <p className="text-sm font-medium text-[var(--color-text)]">No session selected</p>
      <p className="text-sm text-[var(--color-muted)] mt-1">
        Choose a session from the list to view its messages
      </p>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export function Sessions() {
  const { id } = useParams<{ id: string }>();
  const { data: instances, isLoading: instancesLoading } = useInstancesQuery();
  const hasInstances = (instances?.instances.length ?? 0) > 0;

  if (instancesLoading) {
    return (
      <div className="flex h-full lg:pb-0 overflow-hidden" style={{ paddingBottom: 'calc(3.5rem + var(--sab, 0px))' }}>
        <div className="w-full sm:w-72 shrink-0 border-r border-[var(--color-border)] flex flex-col gap-2 p-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
        <div className="flex-1 flex flex-col gap-3 p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-24" />
          <div className="flex flex-col gap-3 mt-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-16 rounded-2xl', i % 2 === 0 ? 'w-3/4' : 'w-2/3 ml-auto')} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!hasInstances) {
    return <NoInstancesState />;
  }

  return (
    <div className="flex h-full lg:pb-0 overflow-hidden" style={{ paddingBottom: 'calc(3.5rem + var(--sab, 0px))' }}>
      {/* Left pane: session list */}
      <div
        className={cn(
          'w-full sm:w-72 shrink-0 border-r border-[var(--color-border)]',
          id ? 'hidden sm:flex sm:flex-col' : 'flex flex-col',
        )}
      >
        <SessionList />
      </div>

      {/* Right pane: detail */}
      <div
        className={cn(
          'flex-1 flex flex-col min-w-0 overflow-hidden',
          !id ? 'hidden sm:flex' : 'flex',
        )}
      >
        {id ? <SessionDetail id={id} /> : <EmptyDetail />}
      </div>
    </div>
  );
}
