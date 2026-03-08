import { useState } from "react";
import type { OrcaStatus } from "../types";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

interface Props {
  status: OrcaStatus | null;
  onConfigUpdate: (config: {
    concurrencyCap?: number;
    implementModel?: string;
    reviewModel?: string;
    fixModel?: string;
  }) => Promise<void>;
  onSync: () => Promise<void>;
}

export default function SettingsPage({ status, onConfigUpdate, onSync }: Props) {
  const [syncing, setSyncing] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  const pct =
    status.budgetLimit > 0
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
    if (e.key === "Enter") saveConcurrency();
    else if (e.key === "Escape") setEditingConcurrency(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold text-gray-100 mb-6">Settings</h1>

      <div className="max-w-lg space-y-8">
        {/* Budget */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Budget
          </h2>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Cost this window</span>
              <span className="text-gray-200 tabular-nums">
                ${status.costInWindow.toFixed(2)}
                <span className="text-gray-500"> / </span>
                ${status.budgetLimit.toFixed(2)}
              </span>
            </div>
            <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full ${barColor} rounded-full transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-gray-600">
              Window: {status.budgetWindowHours}h rolling
            </div>
          </div>
        </section>

        {/* Concurrency */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Concurrency
          </h2>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                {status.activeSessions > 0 && (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                  </span>
                )}
                <span className="text-gray-400">Active sessions</span>
              </div>
              <span className="text-gray-200 tabular-nums">
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
                    className="text-gray-200 hover:text-blue-400 cursor-pointer border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
                    title="Click to change max concurrency"
                  >
                    {status.concurrencyCap}
                  </button>
                )}
                <span className="text-gray-500 ml-1">max</span>
              </span>
            </div>
            <div className="text-xs text-gray-600 mt-2">
              Click the max value to edit
            </div>
          </div>
        </section>

        {/* Models */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Models
          </h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 divide-y divide-gray-800">
            {(["implement", "review", "fix"] as const).map((phase) => {
              const field =
                `${phase}Model` as "implementModel" | "reviewModel" | "fixModel";
              return (
                <div
                  key={phase}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <span className="text-gray-400 capitalize">{phase}</span>
                  <select
                    value={status[field]}
                    onChange={(e) => onConfigUpdate({ [field]: e.target.value })}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 cursor-pointer hover:border-gray-500 transition-colors"
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </section>

        {/* Sync */}
        <section>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Linear Sync
          </h2>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
            <p className="text-xs text-gray-500 mb-3">
              Pull latest issues and status from Linear.
            </p>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-2 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
