import { useState } from 'react';
import { BarChart3, Plug, Terminal, Coins, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Select } from '@/components/ui/Select';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { InfoTip } from '@/components/ui/InfoTip';
import { MetricsChart } from '@/components/metrics/MetricsChart';
import { useMetricsDashboard, useClearMetricsMutation } from '@/hooks/useMetrics';
import { useInstancesQuery } from '@/hooks/useInstances';
import { formatNumber, formatCost, cn } from '@/lib/utils';

const periods = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];



function NoDataState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
      <BarChart3 className="h-12 w-12 text-[var(--color-muted)] opacity-40" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">No metrics data yet</p>
        <p className="text-sm text-[var(--color-muted)] mt-1 max-w-sm mx-auto">
          Metrics are collected from your connected agents.
          Once agents start sending events, you'll see session counts, tool usage, and message volume here.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 max-w-md w-full">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left">
          <div className="flex items-center gap-2 mb-1">
            <Plug className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
            <span className="text-sm font-medium text-[var(--color-text)]">OpenCode</span>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Session data is pulled live from your OpenCode instance
          </p>
        </div>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left">
          <div className="flex items-center gap-2 mb-1">
            <Terminal className="h-3.5 w-3.5 text-[var(--color-accent)]" aria-hidden="true" />
            <span className="text-sm font-medium text-[var(--color-text)]">Claude Code</span>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            Events are collected via webhook hooks
          </p>
        </div>
      </div>
      <Link
        to="/settings"
        className="text-sm text-[var(--color-accent)] font-medium hover:underline"
      >
        Go to Settings to connect an agent
      </Link>
    </div>
  );
}

export function Metrics() {
  const [period, setPeriod] = useState('7d');
  const [confirmClear, setConfirmClear] = useState(false);
  const { data, isLoading: metricsLoading } = useMetricsDashboard(period);
  const { isLoading: instancesLoading } = useInstancesQuery();
  const clearMutation = useClearMetricsMutation();

  const isLoading = metricsLoading || instancesLoading;
  const hasData = data?.summary && (
    data.summary.totalSessions > 0 ||
    data.summary.totalMessages > 0 ||
    data.summary.totalToolCalls > 0
  );

  const handleClear = () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    clearMutation.mutate(undefined, { onSettled: () => setConfirmClear(false) });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">Metrics</h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            Analyze your agent performance and usage patterns.
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <label htmlFor="metrics-period" className="sr-only">Time period</label>
          <Select
            id="metrics-period"
            value={period}
            onChange={(e) => { setPeriod(e.target.value); setConfirmClear(false); }}
            className="flex-1 sm:w-44"
          >
            {periods.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          <button
            onClick={handleClear}
            onBlur={() => setConfirmClear(false)}
            disabled={clearMutation.isPending}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border transition-colors whitespace-nowrap shrink-0',
              confirmClear
                ? 'bg-[var(--color-danger)] border-[var(--color-danger)] text-white hover:opacity-90'
                : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:border-[var(--color-danger)]',
              clearMutation.isPending && 'opacity-50 pointer-events-none',
            )}
            aria-label="Clear metrics data"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {confirmClear ? 'Confirm clear' : 'Clear'}
          </button>
        </div>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <>
          <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="min-w-[140px] shrink-0 sm:min-w-0">
                <CardContent className="p-3 sm:p-4">
                  <Skeleton className="h-4 w-20 mb-2" />
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="grid gap-4 min-w-0 md:grid-cols-2 md:gap-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i} className={i === 0 ? 'md:col-span-2' : ''}>
                <CardHeader>
                  <Skeleton className="h-5 w-32" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-64 w-full rounded-lg" />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : !hasData ? (
        <NoDataState />
      ) : data?.summary ? (
        <>
          {/* Summary row — horizontal scroll on mobile, grid on larger screens */}
          <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-6">
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Total Sessions</p>
                  <InfoTip text="Number of top-level agent sessions in the selected period (subagent sessions are excluded)" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-text)]">
                  {formatNumber(data.summary.totalSessions)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Active Now</p>
                  <InfoTip text="Sessions with activity in the last 2 minutes that haven't stopped or gone idle" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-success)]">
                  {data.summary.activeSessions}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Messages</p>
                  <InfoTip text="Total unique user and assistant messages in the selected period" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-text)]">
                  {formatNumber(data.summary.totalMessages)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Tool Calls</p>
                  <InfoTip text="Number of tools invoked by the agent (e.g. file reads, edits, terminal commands, web fetches)" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-text)]">
                  {formatNumber(data.summary.totalToolCalls)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Total Tokens</p>
                  <InfoTip text="Total input + output + reasoning tokens consumed by assistant messages in the selected period" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-text)]">
                  {formatNumber(data.summary.totalTokens)}
                </p>
              </CardContent>
            </Card>
            <Card className="min-w-[140px] shrink-0 sm:min-w-0">
              <CardContent className="p-3 sm:p-4">
                <div className="flex items-center gap-1">
                  <p className="text-sm font-medium text-[var(--color-muted)]">Est. Cost</p>
                  <InfoTip text="Estimated API cost from all assistant messages in the selected period, computed server-side from token counts using OpenRouter pricing data" />
                </div>
                <p className="mt-1 text-2xl font-bold text-[var(--color-accent)]">
                  <Coins className="inline h-5 w-5 mr-1 -mt-0.5" aria-hidden="true" />
                  {formatCost(data.summary.totalCost)}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Charts */}
          <div className="grid gap-4 min-w-0 md:grid-cols-2 md:gap-6">
            <div className="md:col-span-2 min-w-0">
              <MetricsChart
                title="Session Activity"
                description="Number of new top-level sessions started per time bucket"
                data={data.sessionActivity}
                color="var(--color-accent-solid)"
                period={period}
              />
            </div>
            <MetricsChart
              title="Tool Usage"
              description="Number of distinct tool invocations (file ops, shell commands, searches, etc.) per time bucket"
              data={data.toolUsage}
              color="var(--color-warning)"
              period={period}
            />
            <MetricsChart
              title="Message Volume"
              description="Number of unique user and assistant messages per time bucket"
              data={data.messageVolume}
              color="var(--color-success)"
              period={period}
            />
            <MetricsChart
              title="Token Usage"
              description="Total tokens (input + output + reasoning) consumed per time bucket"
              data={data.tokenUsage}
              color="var(--color-info, var(--color-accent))"
              period={period}
            />
            <MetricsChart
              title="Cost Over Time"
              description="Estimated API cost (USD) per time bucket"
              data={data.costOverTime}
              color="var(--color-warning)"
              period={period}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
