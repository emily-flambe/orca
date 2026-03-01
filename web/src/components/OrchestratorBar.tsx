import { useState } from "react";
import type { OrcaStatus } from "../types";

interface Props {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
}

export default function OrchestratorBar({ status, onSync }: Props) {
  const [syncing, setSyncing] = useState(false);

  if (!status) {
    return (
      <div className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  const pct = status.budgetLimit > 0
    ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
    : 0;

  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-6 text-sm shrink-0">
      {/* Budget gauge */}
      <div className="flex items-center gap-2 min-w-48">
        <span className="text-gray-400">Budget</span>
        <div className="w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${barColor} rounded-full transition-all`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-gray-300 tabular-nums">
          ${status.costInWindow.toFixed(2)} / ${status.budgetLimit.toFixed(2)}
        </span>
      </div>

      {/* Active sessions */}
      <div className="flex items-center gap-2">
        {status.activeSessions > 0 && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
        )}
        <span className="text-gray-300">
          {status.activeSessions} active
        </span>
      </div>

      {/* Queued tasks */}
      <div className="flex items-center gap-2">
        <span className="text-gray-400">Queued</span>
        <span className="text-gray-300">{status.queuedTasks}</span>
      </div>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="ml-auto px-3 py-1 rounded bg-purple-600 text-purple-100 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {syncing ? "Syncing..." : "Sync"}
      </button>
    </div>
  );
}
