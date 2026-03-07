import { Settings as SettingsIcon, Plug } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useInstancesQuery } from '@/hooks/useInstances';
import { ConfigEditor } from '@/components/config/ConfigEditor';

function NoInstanceState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-4 px-4">
      <SettingsIcon aria-hidden="true" className="h-12 w-12 text-[var(--color-muted)] opacity-40" />
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">No agent instance connected</p>
        <p className="text-sm text-[var(--color-muted)] mt-1 max-w-sm mx-auto">
          Connect a Claude Code or OpenCode instance to view and edit its configuration remotely.
          Config files are synced automatically on each agent startup.
        </p>
      </div>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-base)] p-4 max-w-md w-full text-left">
        <div className="flex items-center gap-2 mb-2">
          <Plug aria-hidden="true" className="h-4 w-4 text-[var(--color-accent)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">How to connect</span>
        </div>
        <ol className="text-sm text-[var(--color-muted)] flex flex-col gap-1.5 list-decimal list-inside">
          <li>
            Go to{' '}
            <Link to="/settings" className="text-[var(--color-accent)] underline underline-offset-2">
              Settings
            </Link>
          </li>
          <li>Follow the setup instructions in Settings → Setup to connect your agent</li>
          <li>Start a session — the config file syncs automatically</li>
        </ol>
      </div>
    </div>
  );
}

export function Config() {
  const { data: instanceData, isLoading: instancesLoading } = useInstancesQuery();
  const instances = instanceData?.instances ?? [];
  const hasAnyInstance = instances.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text)]">Configuration</h1>
        <p className="text-sm text-[var(--color-muted)] mt-1">
          View and edit your connected agent configuration remotely.
        </p>
      </div>

      {!instancesLoading && !hasAnyInstance ? (
        <NoInstanceState />
      ) : (
        <ConfigEditor />
      )}
    </div>
  );
}
