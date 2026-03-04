import {
  Activity,
  MessageSquare,
  Hash,
  Coins,
  Zap,
  Clock,
  Wifi,
  ArrowRight,
  Terminal,
  WifiOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { SessionCard } from '@/components/sessions/SessionCard';
import { useMetricsSummary } from '@/hooks/useMetrics';
import { useSessionsQuery } from '@/hooks/useSessions';
import { useInstancesQuery } from '@/hooks/useInstances';
import { formatNumber, formatCost, cn } from '@/lib/utils';
import { InfoTip } from '@/components/ui/InfoTip';

interface SummaryCardProps {
  label: string;
  description?: string;
  value: number | undefined;
  icon: React.ElementType;
  iconColor: string;
  isLoading: boolean;
  formatter?: (n: number) => string;
}

function SummaryCard({ label, description, value, icon: Icon, iconColor, isLoading, formatter = formatNumber }: SummaryCardProps) {
  return (
    <Card>
        <CardContent className="p-3 sm:p-4">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-7 w-14" />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <p className="text-sm font-medium text-[var(--color-muted)]">{label}</p>
                {description && <InfoTip text={description} />}
              </div>
              <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} aria-hidden="true" />
            </div>
            <p className="text-2xl font-bold tracking-tight text-[var(--color-text)]">
              {value !== undefined ? formatter(value) : '—'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { data: metrics, isLoading: metricsLoading } = useMetricsSummary();
  const { data: sessions, isLoading: sessionsLoading } = useSessionsQuery({ limit: 5 });
  const { data: instances, isLoading: instancesLoading } = useInstancesQuery();

  const hasInstances = (instances?.instances.length ?? 0) > 0;

  const summaryCards = [
    { label: 'Total Sessions', description: 'Number of top-level agent sessions (subagent sessions are excluded)', value: metrics?.totalSessions,  icon: Hash,         iconColor: 'text-[var(--color-accent)]',   formatter: formatNumber },
    { label: 'Active Now',     description: 'Sessions with activity in the last 2 minutes that haven\'t stopped or gone idle', value: metrics?.activeSessions, icon: Activity,      iconColor: 'text-[var(--color-success)]',  formatter: formatNumber },
    { label: 'Total Tokens',   description: 'Total input and output tokens consumed across all sessions', value: metrics?.totalTokens,   icon: Zap,           iconColor: 'text-[var(--color-warning)]',  formatter: formatNumber },
    { label: 'Est. Cost',      description: 'Estimated total cost based on token usage across all sessions', value: metrics?.totalCost,     icon: Coins,         iconColor: 'text-[var(--color-accent)]',   formatter: formatCost },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Dashboard</h1>
          <p className="text-sm text-[var(--color-muted)] mt-0.5">
            Overview of your AI agent activity
          </p>
        </div>
      </div>

      {/* Setup nudge — only show when we know there are no instances (not while loading) */}
      {!instancesLoading && !hasInstances && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/6 px-4 py-3">
          <div className="flex items-start sm:items-center gap-3 min-w-0">
            <Terminal className="h-4 w-4 text-[var(--color-accent)] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
            <p className="text-sm text-[var(--color-text)]">
              No agents connected yet.{' '}
              <span className="text-[var(--color-muted)]">Run a one-liner to register your first instance.</span>
            </p>
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-1 text-sm font-semibold text-[var(--color-accent)] hover:underline underline-offset-2 shrink-0"
          >
            Get started <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      )}

      {/* Metrics summary — 2 cols on mobile, 4 on sm+ */}
      <section aria-label="Metrics summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {summaryCards.map((card) => (
          <SummaryCard key={card.label} {...card} isLoading={metricsLoading} />
        ))}
      </section>
      {/* Main two-panel content */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Recent sessions */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Clock className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
                Recent Sessions
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {sessionsLoading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              ) : !sessions?.sessions.length ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <MessageSquare className="h-8 w-8 text-[var(--color-muted)] mb-2 opacity-40" aria-hidden="true" />
                  <p className="text-sm text-[var(--color-muted)]">
                    No sessions yet. Connect an agent to get started.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {sessions.sessions.map((session, index) => (
                    <SessionCard key={session.id} session={session} index={index} />
                  ))}
                  <Link
                    to="/sessions"
                    className="mt-1 flex items-center justify-center gap-1 py-3 min-h-[48px] text-sm font-medium text-[var(--color-accent)] hover:underline underline-offset-2"
                  >
                    View all sessions <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Instance status */}
        <div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <Wifi className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
                Instances
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {instancesLoading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-lg" />
                  ))}
                </div>
              ) : !instances?.instances.length ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <WifiOff className="h-8 w-8 text-[var(--color-muted)] mb-2 opacity-40" aria-hidden="true" />
                  <p className="text-sm text-[var(--color-muted)]">No instances connected</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {instances.instances.map((inst) => (
                    <div
                      key={inst.id}
                      className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] p-3 min-h-[48px]"
                    >
                      <div
                        className={cn(
                          'h-2 w-2 rounded-full shrink-0',
                          inst.status === 'connected'
                            ? 'bg-[var(--color-success)]'
                            : inst.status === 'error'
                              ? 'bg-[var(--color-danger)]'
                              : 'bg-[var(--color-muted)]',
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--color-text)] truncate">
                          {inst.name}
                        </p>
                        <p className="text-xs text-[var(--color-muted)] truncate">
                          {inst.type === 'opencode' ? 'OpenCode' : 'Claude Code'}
                          {inst.version && (
                            <span className="text-[var(--color-accent)]"> {inst.version}</span>
                          )}
                          {inst.mcpServerVersion && (
                            <span> · MCP {inst.mcpServerVersion}</span>
                          )}
                        </p>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-xs font-medium px-1.5 py-0.5 rounded-full',
                          inst.status === 'connected'
                            ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                            : inst.status === 'error'
                              ? 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]'
                              : 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]',
                        )}
                      >
                        {inst.status}
                      </span>
                    </div>
                  ))}
                  <Link
                    to="/settings"
                    className="mt-1 flex items-center justify-center gap-1 py-3 min-h-[48px] text-sm font-medium text-[var(--color-accent)] hover:underline underline-offset-2"
                  >
                    Manage instances <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
