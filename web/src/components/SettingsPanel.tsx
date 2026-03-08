import { useState } from "react";
import type { OrcaStatus } from "../types";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

interface Props {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
  onConfigUpdate: (config: { concurrencyCap?: number; implementModel?: string; reviewModel?: string; fixModel?: string }) => Promise<void>;
}

export default function SettingsPanel({ status, onSync, onConfigUpdate }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  const startEditConcurrency = () => {
    if (!status) return;
    setConcurrencyInput(String(status.concurrencyCap));
    setEditingConcurrency(true);
  };

  const saveConcurrency = async () => {
    if (!status) return;
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

  if (!status) {
    return (
      <div className="p-6 text-sm text-gray-500">Loading...</div>
    );
  }

  const pct = status.budgetLimit > 0
    ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
    : 0;

  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-gray-100">Settings</h2>

      {/* Budget */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-300">Budget</h3>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-3 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-sm text-gray-300 tabular-nums whitespace-nowrap">
            ${status.costInWindow.toFixed(2)}
            <span className="text-gray-500"> / </span>
            ${status.budgetLimit.toFixed(2)}
          </span>
        </div>
        <div className="text-xs text-gray-500">
          Window: {status.budgetWindowHours}h &middot; {pct.toFixed(1)}% used
        </div>
      </div>

      {/* Concurrency */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-300">Concurrency</h3>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400">Active sessions:</span>
          <span className="text-gray-200">{status.activeSessions}</span>
          {status.activeSessions > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400">Queued tasks:</span>
          <span className="text-gray-200">{status.queuedTasks}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400">Max concurrency:</span>
          {editingConcurrency ? (
            <input
              type="number"
              min="1"
              value={concurrencyInput}
              onChange={(e) => setConcurrencyInput(e.target.value)}
              onBlur={saveConcurrency}
              onKeyDown={handleConcurrencyKeyDown}
              autoFocus
              className="w-16 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-center text-gray-200 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          ) : (
            <button
              onClick={startEditConcurrency}
              className="text-gray-200 hover:text-blue-400 cursor-pointer border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
              title="Click to change"
            >
              {status.concurrencyCap}
            </button>
          )}
        </div>
      </div>

      {/* Models */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-300">Models</h3>
        <div className="space-y-3">
          {(["implement", "review", "fix"] as const).map((phase) => {
            const field = `${phase}Model` as "implementModel" | "reviewModel" | "fixModel";
            return (
              <div key={phase} className="flex items-center gap-3 text-sm">
                <span className="text-gray-400 w-20 capitalize">{phase}</span>
                <select
                  value={status[field]}
                  onChange={(e) => onConfigUpdate({ [field]: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 cursor-pointer hover:border-gray-500 transition-colors"
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sync */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Sync</h3>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-4 py-2 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {syncing ? "Syncing..." : "Sync with Linear"}
        </button>
      </div>
    </div>
  );
}
