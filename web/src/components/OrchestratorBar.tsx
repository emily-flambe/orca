import { useState } from "react";
import type { OrcaStatus } from "../types";
import CreateTicketModal from "./CreateTicketModal";

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;

interface Props {
  status: OrcaStatus | null;
  onSync: () => Promise<void>;
  onConfigUpdate: (config: {
    concurrencyCap?: number;
    implementModel?: string;
    reviewModel?: string;
    fixModel?: string;
  }) => Promise<void>;
  onNewTicket: (identifier: string) => void;
}

export default function OrchestratorBar({
  status,
  onSync,
  onConfigUpdate,
  onNewTicket,
}: Props) {
  const [syncing, setSyncing] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState("");
  const [showModal, setShowModal] = useState(false);

  if (!status) {
    return (
      <div className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) {
      const k = n / 1_000;
      const kStr = k.toFixed(1);
      if (parseFloat(kStr) >= 1000) return `${(n / 1_000_000).toFixed(1)}M`;
      return `${kStr}K`;
    }
    return String(n);
  }

  const pct =
    status.tokenBudgetLimit > 0
      ? Math.min((status.tokensInWindow / status.tokenBudgetLimit) * 100, 100)
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
    <>
      <div className="min-h-12 bg-gray-900 border-b border-gray-800 flex flex-wrap items-center px-4 gap-x-4 md:gap-x-6 gap-y-2 py-2 text-sm shrink-0">
        {/* Budget gauge */}
        <div className="flex items-center gap-2">
          <span className="text-gray-400 hidden sm:inline">Budget</span>
          <div className="w-20 md:w-24 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-gray-300 tabular-nums text-xs sm:text-sm">
            {formatTokens(status.tokensInWindow)}
            <span className="text-gray-500"> / </span>
            {formatTokens(status.tokenBudgetLimit)}
            <span className="text-gray-500 text-xs"> tok</span>
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
            )}{" "}
            active
          </span>
        </div>

        {/* Queued tasks - hidden on small screens */}
        <div className="hidden sm:flex items-center gap-2">
          <span className="text-gray-400">Queued</span>
          <span className="text-gray-300">{status.queuedTasks}</span>
        </div>

        {/* Model selectors - hidden on mobile */}
        <div className="hidden md:flex items-center gap-3">
          {(["implement", "review", "fix"] as const).map((phase) => {
            const field = `${phase}Model` as
              | "implementModel"
              | "reviewModel"
              | "fixModel";
            return (
              <label key={phase} className="flex items-center gap-1">
                <span className="text-gray-500 text-xs">{phase}</span>
                <select
                  value={status[field]}
                  onChange={(e) => onConfigUpdate({ [field]: e.target.value })}
                  className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-300 cursor-pointer hover:border-gray-500 transition-colors"
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 rounded bg-gray-700 text-gray-200 hover:bg-gray-600 transition-colors text-sm"
          >
            + New ticket
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-3 py-1.5 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>
      {status.draining && (
        <div className="bg-amber-900/40 border-b border-amber-700/50 px-4 py-1.5 text-xs text-amber-300 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
          <span>
            Draining — waiting for {status.drainSessionCount} session
            {status.drainSessionCount !== 1 ? "s" : ""} to finish before deploy
          </span>
        </div>
      )}
      {showModal && (
        <CreateTicketModal
          onClose={() => setShowModal(false)}
          onCreated={(identifier) => {
            setShowModal(false);
            onNewTicket(identifier);
          }}
        />
      )}
    </>
  );
}
