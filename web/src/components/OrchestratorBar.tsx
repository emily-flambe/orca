import { useState } from "react";
import type { OrcaStatus } from "../types";

interface Props {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
  onConfigUpdate: (config: { concurrencyCap: number }) => Promise<void>;
}

export default function OrchestratorBar({ status, onSync, onConfigUpdate }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");

  if (!status) {
    return (
      <div className="min-h-12 bg-gray-900 border-b border-gray-800 flex items-center px-2 md:px-4 text-sm text-gray-500">
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

  const startEditConcurrency = () => {
    setConcurrencyInput(String(status.concurrencyCap));
    setEditingConcurrency(true);
  };

  const saveConcurrency = async () => {
    const val = parseInt(concurrencyInput, 10);
    if (!Number.isNaN(val) && val >= 1 && val !== status.concurrencyCap) {
      await onConfigUpdate({ concurrencyCap: val });
    }
    setEditingConcurrency(false);
  };

  const handleConcurrencyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      saveConcurrency();
    } else if (e.key === "Escape") {
      setEditingConcurrency(false);
    }
  };

  return (
    <div className="min-h-12 bg-gray-900 border-b border-gray-800 flex flex-wrap items-center px-2 md:px-4 gap-2 md:gap-6 py-1 text-sm shrink-0">
      {/* Budget gauge */}
      <div className="flex items-center gap-2">
        <span className="text-gray-400 hidden sm:inline">Budget</span>
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
          {status.activeSessions}
          <span className="text-gray-500"> / </span>
          {editingConcurrency ? (
            <input
              type="number"
              min="1"
              value={concurrencyInput}
              onChange={(e) => setConcurrencyInput(e.target.value)}
              onBlur={saveConcurrency}
              onKeyDown={handleConcurrencyKeyDown}
              autoFocus
              className="w-10 bg-gray-800 border border-gray-600 rounded px-1 text-center text-gray-200 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          ) : (
            <button
              onClick={startEditConcurrency}
              className="text-gray-300 hover:text-blue-400 cursor-pointer border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
              title="Click to change max concurrency"
            >
              {status.concurrencyCap}
            </button>
          )}
          <span className="hidden sm:inline"> active</span>
        </span>
      </div>

      {/* Queued tasks */}
      <div className="flex items-center gap-1 sm:gap-2">
        <span className="text-gray-400 hidden sm:inline">Queued</span>
        <span className="text-gray-400 sm:hidden">Q</span>
        <span className="text-gray-300">{status.queuedTasks}</span>
      </div>

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="ml-auto px-2 md:px-3 py-1 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {syncing ? "Syncing..." : "Sync"}
      </button>
    </div>
  );
}
