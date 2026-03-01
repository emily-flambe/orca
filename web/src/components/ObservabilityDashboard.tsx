import { useState, useEffect, useCallback } from "react";
import type { ObservabilityMetrics, ObservabilityErrors, LogSearchResult } from "../types";
import { fetchObservabilityMetrics, fetchObservabilityErrors, searchLogs } from "../hooks/useApi";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Metric Cards
// ---------------------------------------------------------------------------

function MetricCards({ metrics }: { metrics: ObservabilityMetrics }) {
  const totalTasks = Object.values(metrics.tasksByStatus).reduce((a, b) => a + b, 0);
  const runningSessions = metrics.invocationsByStatus["running"] ?? 0;

  const cards = [
    { label: "Total Tasks", value: totalTasks, color: "text-gray-100" },
    { label: "Running Sessions", value: runningSessions, color: "text-blue-400" },
    { label: "Total Invocations", value: metrics.totalInvocations, color: "text-gray-100" },
    { label: "Total Cost", value: `$${metrics.totalCostAllTime.toFixed(2)}`, color: "text-green-400" },
    { label: "Avg Duration", value: formatDuration(metrics.avgSessionDuration), color: "text-gray-100" },
    { label: "Failure Rate", value: `${Math.round((metrics.invocationsByStatus["failed"] ?? 0) / Math.max(metrics.totalInvocations, 1) * 100)}%`, color: "text-red-400" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <div className="text-xs text-gray-500 mb-1">{card.label}</div>
          <div className={`text-lg font-semibold tabular-nums ${card.color}`}>{card.value}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task Status Breakdown
// ---------------------------------------------------------------------------

function TaskStatusBreakdown({ tasksByStatus }: { tasksByStatus: Record<string, number> }) {
  const statusColors: Record<string, string> = {
    running: "bg-blue-500",
    ready: "bg-cyan-500",
    done: "bg-green-500",
    failed: "bg-red-500",
    in_review: "bg-purple-500",
    dispatched: "bg-gray-500",
    changes_requested: "bg-orange-500",
    awaiting_ci: "bg-yellow-500",
    deploying: "bg-teal-500",
    backlog: "bg-gray-600",
  };

  const entries = Object.entries(tasksByStatus).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Tasks by Status</h3>
      <div className="space-y-2">
        {entries.map(([status, count]) => (
          <div key={status} className="flex items-center gap-2">
            <span className="text-xs text-gray-400 w-28 truncate">{status}</span>
            <div className="flex-1 h-4 bg-gray-800 rounded overflow-hidden">
              <div
                className={`h-full ${statusColors[status] ?? "bg-gray-500"} rounded`}
                style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-xs text-gray-300 tabular-nums w-8 text-right">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost Chart (last 30 days)
// ---------------------------------------------------------------------------

function CostChart({ costByDay }: { costByDay: { date: string; cost: number }[] }) {
  if (costByDay.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Cost (Last 30 Days)</h3>
        <div className="text-sm text-gray-500">No cost data yet</div>
      </div>
    );
  }

  const maxCost = Math.max(...costByDay.map((d) => d.cost), 0.01);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Cost (Last 30 Days)</h3>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {costByDay.map((day) => {
          const pct = (day.cost / maxCost) * 100;
          const barColor = pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";
          return (
            <div key={day.date} className="flex items-center gap-2">
              <span className="text-xs text-gray-500 w-20 shrink-0 tabular-nums">{day.date}</span>
              <div className="flex-1 h-3 bg-gray-800 rounded overflow-hidden">
                <div
                  className={`h-full ${barColor} rounded`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs text-gray-300 tabular-nums w-16 text-right">${day.cost.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error Patterns
// ---------------------------------------------------------------------------

function ErrorPatterns({ patterns }: { patterns: ObservabilityErrors["errorPatterns"] }) {
  if (patterns.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Error Patterns</h3>
        <div className="text-sm text-gray-500">No errors recorded</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Error Patterns</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-800">
            <th className="pb-2 pr-4">Pattern</th>
            <th className="pb-2 pr-4 w-16">Count</th>
            <th className="pb-2 w-40">Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {patterns.map((p, idx) => (
            <tr key={idx} className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-red-400 truncate max-w-xs" title={p.pattern}>
                {p.pattern}
              </td>
              <td className="py-2 pr-4 text-gray-300 tabular-nums">{p.count}</td>
              <td className="py-2 text-gray-500 text-xs">{formatDate(p.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent Errors
// ---------------------------------------------------------------------------

function RecentErrors({ errors }: { errors: ObservabilityErrors["recentErrors"] }) {
  if (errors.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Recent Errors</h3>
        <div className="text-sm text-gray-500">No recent errors</div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Recent Errors ({errors.length})</h3>
      <div className="max-h-64 overflow-y-auto space-y-2">
        {errors.slice(0, 20).map((err) => (
          <div key={err.id} className="p-2 bg-gray-800/50 rounded border border-gray-800">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-gray-400">{err.linearIssueId}</span>
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">inv #{err.id}</span>
              {err.phase && <span className="text-xs text-gray-500">{err.phase}</span>}
              {err.costUsd != null && (
                <span className="text-xs text-gray-500 tabular-nums">${err.costUsd.toFixed(2)}</span>
              )}
              <span className="text-xs text-gray-600 ml-auto">{formatDate(err.startedAt)}</span>
            </div>
            <div className="text-xs text-red-300 truncate" title={err.outputSummary ?? undefined}>
              {err.outputSummary ?? "No error message"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent Invocations
// ---------------------------------------------------------------------------

function RecentInvocations({ completions }: { completions: ObservabilityMetrics["recentCompletions"] }) {
  if (completions.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Recent Invocations</h3>
        <div className="text-sm text-gray-500">No invocations yet</div>
      </div>
    );
  }

  const statusBadge = (s: string) => {
    switch (s) {
      case "completed": return "bg-green-500/20 text-green-400";
      case "failed": return "bg-red-500/20 text-red-400";
      case "timed_out": return "bg-orange-500/20 text-orange-400";
      default: return "bg-gray-500/20 text-gray-400";
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Recent Invocations</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-3">Task</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Phase</th>
              <th className="pb-2 pr-3">Cost</th>
              <th className="pb-2 pr-3">Turns</th>
              <th className="pb-2">Date</th>
            </tr>
          </thead>
          <tbody>
            {completions.map((inv) => (
              <tr key={inv.id} className="border-b border-gray-800/50">
                <td className="py-1.5 pr-3 font-mono text-gray-400 text-xs">{inv.linearIssueId}</td>
                <td className="py-1.5 pr-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${statusBadge(inv.status)}`}>{inv.status}</span>
                </td>
                <td className="py-1.5 pr-3 text-gray-500 text-xs">{inv.phase ?? "\u2014"}</td>
                <td className="py-1.5 pr-3 text-gray-300 tabular-nums text-xs">{inv.costUsd != null ? `$${inv.costUsd.toFixed(2)}` : "\u2014"}</td>
                <td className="py-1.5 pr-3 text-gray-300 tabular-nums text-xs">{inv.numTurns ?? "\u2014"}</td>
                <td className="py-1.5 text-gray-500 text-xs">{formatDate(inv.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log Search
// ---------------------------------------------------------------------------

function LogSearch() {
  const [query, setQuery] = useState("");
  const [taskId, setTaskId] = useState("");
  const [results, setResults] = useState<LogSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedInvocations, setExpandedInvocations] = useState<Set<number>>(new Set());

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() && !taskId.trim()) return;

    setSearching(true);
    setError(null);
    try {
      const data = await searchLogs({
        q: query.trim() || undefined,
        taskId: taskId.trim() || undefined,
      });
      setResults(data);
      setExpandedInvocations(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [query, taskId]);

  const toggleInvocation = (id: number) => {
    setExpandedInvocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Log Search</h3>
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Search text..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-purple-500 focus:outline-none"
        />
        <input
          type="text"
          placeholder="Task ID (e.g. EMI-42)"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          className="w-40 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-purple-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={searching || (!query.trim() && !taskId.trim())}
          className="px-4 py-1.5 rounded bg-purple-600 text-purple-100 text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </form>

      {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

      {results && (
        <div>
          <div className="text-xs text-gray-500 mb-2">
            {results.totalMatches} match{results.totalMatches !== 1 ? "es" : ""} across {results.results.length} invocation{results.results.length !== 1 ? "s" : ""}
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {results.results.map((r) => (
              <div key={r.invocationId} className="border border-gray-800 rounded">
                <button
                  onClick={() => toggleInvocation(r.invocationId)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-800/50 transition-colors"
                >
                  <span className="text-xs text-gray-500">{expandedInvocations.has(r.invocationId) ? "\u25BC" : "\u25B6"}</span>
                  <span className="text-xs font-mono text-gray-400">{r.linearIssueId}</span>
                  <span className="text-xs text-gray-600">inv #{r.invocationId}</span>
                  <span className="text-xs text-gray-500 ml-auto">{r.matches.length} match{r.matches.length !== 1 ? "es" : ""}</span>
                </button>
                {expandedInvocations.has(r.invocationId) && (
                  <div className="border-t border-gray-800 p-2 space-y-1">
                    {r.matches.map((m, idx) => (
                      <div key={idx} className="text-xs bg-gray-800/50 rounded p-2">
                        <span className="text-gray-500">L{m.lineIndex} [{m.type}]</span>
                        <pre className="whitespace-pre-wrap text-gray-300 mt-1">{m.text}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {results && results.results.length === 0 && (
        <div className="text-sm text-gray-500">No matches found</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ObservabilityDashboard() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [errors, setErrors] = useState<ObservabilityErrors | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoadError(null);
    try {
      const [m, e] = await Promise.all([
        fetchObservabilityMetrics(),
        fetchObservabilityErrors(),
      ]);
      setMetrics(m);
      setErrors(e);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return <div className="p-6 text-gray-500">Loading observability data...</div>;
  }

  if (loadError) {
    return (
      <div className="p-6">
        <div className="text-red-400 text-sm mb-2">Failed to load observability data: {loadError}</div>
        <button
          onClick={loadData}
          className="px-3 py-1 rounded bg-purple-600 text-purple-100 text-sm hover:bg-purple-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 overflow-y-auto h-full">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-100">Observability</h1>
        <button
          onClick={loadData}
          className="px-3 py-1 rounded bg-purple-600 text-purple-100 text-sm hover:bg-purple-700 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Metrics */}
      {metrics && (
        <>
          <MetricCards metrics={metrics} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TaskStatusBreakdown tasksByStatus={metrics.tasksByStatus} />
            <CostChart costByDay={metrics.costByDay} />
          </div>
        </>
      )}

      {/* Errors */}
      {errors && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ErrorPatterns patterns={errors.errorPatterns} />
          <RecentErrors errors={errors.recentErrors} />
        </div>
      )}

      {/* Recent Invocations */}
      {metrics && <RecentInvocations completions={metrics.recentCompletions} />}

      {/* Log Search */}
      <LogSearch />
    </div>
  );
}
