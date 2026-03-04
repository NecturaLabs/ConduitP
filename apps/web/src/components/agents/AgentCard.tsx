import { useState, useEffect, useRef } from 'react';
import { Wifi, WifiOff, AlertTriangle, ExternalLink, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { relativeTime, cn } from '@/lib/utils';
import { useDeleteInstanceMutation, useTestInstanceMutation } from '@/hooks/useInstances';
import type { Instance } from '@conduit/shared';

interface AgentCardProps {
  instance: Instance;
}

const statusConfig: Record<Instance['status'], { icon: typeof Wifi; color: string; label: string }> = {
  connected: { icon: Wifi, color: 'text-[var(--color-success)]', label: 'Connected' },
  disconnected: { icon: WifiOff, color: 'text-[var(--color-muted)]', label: 'Disconnected' },
  error: { icon: AlertTriangle, color: 'text-[var(--color-danger)]', label: 'Error' },
};

// Only allow safe URL protocols for the instance link to prevent XSS via javascript: URLs
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function AgentCard({ instance }: AgentCardProps) {
  const { icon: StatusIcon, color } = statusConfig[instance.status];
  const deleteMutation = useDeleteInstanceMutation();
  const testMutation = useTestInstanceMutation();
  const [testResult, setTestResult] = useState<{ status: string; latency: number } | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
    };
  }, []);

  async function handleTest() {
    try {
      const result = await testMutation.mutateAsync(instance.id);
      setTestResult(result);
      if (testTimerRef.current) clearTimeout(testTimerRef.current);
      testTimerRef.current = setTimeout(() => setTestResult(null), 3000);
    } catch {
      // error handled by mutation state
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className={cn('mt-0.5 shrink-0', color)}>
              <StatusIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 overflow-hidden">
              <h3 className="text-sm font-medium text-[var(--color-text)] truncate">
                {instance.name}
              </h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <Badge variant="secondary" className="text-xs shrink-0">
                  {instance.type === 'opencode' ? 'OpenCode' : 'Claude Code'}
                  {instance.version ? ` ${instance.version}` : ''}
                </Badge>
                {instance.mcpServerVersion && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    MCP {instance.mcpServerVersion}
                  </Badge>
                )}
                <span className="text-xs text-[var(--color-muted)] truncate">
                  {instance.lastSeen ? relativeTime(instance.lastSeen) : 'never seen'}
                </span>
              </div>
              {instance.url && isSafeUrl(instance.url) && (
                <a
                  href={instance.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 flex items-center gap-1 text-sm text-[var(--color-accent)] hover:underline truncate"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {instance.url}
                </a>
              )}
              {testResult && (
                <p className="mt-1 text-sm text-[var(--color-success)]">
                  {testResult.status} — {testResult.latency}ms
                </p>
              )}
              {testMutation.isError && (
                <p className="mt-1 text-sm text-[var(--color-danger)]">
                  Connection test failed
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleTest}
              disabled={testMutation.isPending}
              aria-label="Test connection"
            >
              <RefreshCw className={cn('h-4 w-4', testMutation.isPending && 'animate-spin')} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => deleteMutation.mutate(instance.id)}
              disabled={deleteMutation.isPending}
              aria-label="Remove instance"
            >
              <Trash2 className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
