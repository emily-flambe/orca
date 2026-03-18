import { useState, useEffect, useCallback } from "react";
import type { InngestWorkflow } from "../types";
import { fetchInngestWorkflows } from "../hooks/useApi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "running";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: "bg-green-900/40 text-green-400 border-green-700/40",
  FAILED: "bg-red-900/40 text-red-400 border-red-700/40",
  RUNNING: "bg-blue-900/40 text-blue-400 border-blue-700/40",
  QUEUED: "bg-gray-800 text-gray-400 border-gray-700",
  CANCELLED: "bg-yellow-900/40 text-yellow-400 border-yellow-700/40",
};

function statusBadge(status: string) {
  const cls =
    STATUS_COLORS[status] ?? "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

function triggerLabel(trigger: { type: string; value: string }) {
  if (trigger.type === "cron" || trigger.type === "CRON") {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded-full border bg-purple-900/40 text-purple-400 border-purple-700/40">
        cron: {trigger.value}
      </span>
    );
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded-full border bg-blue-900/40 text-blue-400 border-blue-700/40">
      event: {trigger.value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function InngestPage() {
  const [workflows, setWorkflows] = useState<InngestWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchInngestWorkflows()
      .then((wfs) => {
        setWorkflows(wfs);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
        Inngest Workflows
      </h2>

      {workflows.length === 0 && (
        <div className="text-sm text-gray-500 italic">
          No workflows found. Is the Inngest dev server running?
        </div>
      )}

      {workflows.map((wf) => (
        <div
          key={wf.id}
          className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-gray-200 truncate">
                {wf.name}
              </span>
              <span className="text-xs text-gray-500 font-mono">{wf.slug}</span>
            </div>
          </div>

          {/* Triggers */}
          <div className="flex flex-wrap items-center gap-2">
            {wf.triggers.map((t, i) => (
              <span key={i}>{triggerLabel(t)}</span>
            ))}
          </div>

          {/* Stats badges */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span className="bg-gray-800 px-1.5 py-0.5 rounded">
              {wf.stats.total} runs (24h)
            </span>
            {wf.stats.completed > 0 && (
              <span className="bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded">
                {wf.stats.completed} completed
              </span>
            )}
            {wf.stats.failed > 0 && (
              <span className="bg-red-900/40 text-red-400 px-1.5 py-0.5 rounded">
                {wf.stats.failed} failed
              </span>
            )}
          </div>

          {/* Expandable recent runs */}
          {wf.recentRuns.length > 0 && (
            <button
              onClick={() => setExpandedId(expandedId === wf.id ? null : wf.id)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {expandedId === wf.id
                ? "Hide recent runs"
                : `Recent runs (${wf.recentRuns.length})`}
            </button>
          )}

          {expandedId === wf.id && (
            <div className="space-y-1">
              {wf.recentRuns.map((run) => (
                <div
                  key={run.id}
                  className="bg-gray-800/50 rounded px-2 py-1.5"
                >
                  <div className="flex items-center gap-2 text-xs">
                    {statusBadge(run.status)}
                    <span className="text-gray-400">
                      {formatTimestamp(run.startedAt)}
                    </span>
                    <span className="text-gray-500">
                      {formatDuration(run.startedAt, run.endedAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
