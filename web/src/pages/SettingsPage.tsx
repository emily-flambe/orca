import { useState } from "react";
import type { OrcaStatus } from "../types";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

interface SettingsPageProps {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
  onConfigUpdate: (config: { concurrencyCap?: number; implementModel?: string; reviewModel?: string; fixModel?: string }) => Promise<void>;
}

export default function SettingsPage({ status, onSync, onConfigUpdate }: SettingsPageProps) {
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
    const val = parseInt(concurrencyInput, 10);
    if (status && !Number.isNaN(val) && val >= 1 && val !== status.concurrencyCap) {
      await onConfigUpdate({ concurrencyCap: val });
    }
    setEditingConcurrency(false);
  };

  const handleConcurrencyKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") saveConcurrency();
    else if (e.key === "Escape") setEditingConcurrency(false);
  };

  const pct =
    status && status.budgetLimit > 0
      ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
      : 0;

  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  if (!status) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-6 py-8 space-y-8">
      <h1 className="text-lg font-semibold text-gray-100">Settings</h1>

      {/* Budget */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Budget</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-400">Spend this window</span>
            <span className="text-gray-200 tabular-nums">
              ${status.costInWindow.toFixed(2)}
              <span className="text-gray-600"> / </span>
              ${status.budgetLimit.toFixed(2)}
            </span>
          </div>
          <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-600">Window: {status.budgetWindowHours}h</p>
        </div>
      </section>

      {/* Concurrency */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Concurrency</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-200">Active sessions</p>
              <p className="text-xs text-gray-500 mt-0.5">{status.activeSessions} currently running</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-300">
              <span>Max:</span>
              {editingConcurrency ? (
                <input
                  type="number"
                  min="1"
                  value={concurrencyInput}
                  onChange={(e) => setConcurrencyInput(e.target.value)}
                  onBlur={saveConcurrency}
                  onKeyDown={handleConcurrencyKeyDown}
                  autoFocus
                  className="w-14 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-center text-gray-200 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              ) : (
                <button
                  onClick={startEditConcurrency}
                  className="text-gray-200 hover:text-blue-400 border-b border-dashed border-gray-600 hover:border-blue-400 transition-colors"
                  title="Click to edit"
                >
                  {status.concurrencyCap}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Models */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Models</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
          {(["implement", "review", "fix"] as const).map((phase) => {
            const field = `${phase}Model` as "implementModel" | "reviewModel" | "fixModel";
            return (
              <div key={phase} className="flex items-center justify-between">
                <label className="text-sm text-gray-300 capitalize">{phase}</label>
                <select
                  value={status[field]}
                  onChange={(e) => onConfigUpdate({ [field]: e.target.value }).catch(console.error)}
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
      </section>

      {/* Sync */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Sync</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-400">Pull latest tasks from Linear</p>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-4 py-1.5 rounded bg-purple-600 text-purple-100 text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
