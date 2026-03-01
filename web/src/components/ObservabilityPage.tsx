import { useState, useEffect, useRef, useCallback } from "react";
import type { ObservabilityMetrics, ErrorAggregation } from "../hooks/useApi";
import { fetchMetrics, fetchErrorAggregation, fetchSystemLogs } from "../hooks/useApi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Stats Card
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      <span className="text-xl font-semibold text-gray-100 tabular-nums">{value}</span>
      {sub && <span className="text-xs text-gray-500">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSS Bar Charts
// ---------------------------------------------------------------------------

function CostBarChart({ data }: { data: { date: string; cost: number }[] }) {
  if (data.length === 0) {
    return <div className="text-sm text-gray-500">No cost data</div>;
  }
  const max = Math.max(...data.map((d) => d.cost), 0.01);

  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d) => {
        const pct = (d.cost / max) * 100;
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="w-full flex flex-col justify-end h-24">
              <div
                className="w-full bg-blue-500 rounded-t"
                style={{ height: `${pct}%`, minHeight: d.cost > 0 ? "2px" : "0" }}
                title={`${d.date}: ${formatCost(d.cost)}`}
              />
            </div>
            <span className="text-[10px] text-gray-500 truncate w-full text-center" title={d.date}>
              {d.date.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function InvocationBarChart({ data }: { data: { date: string; completed: number; failed: number; timedOut: number }[] }) {
  if (data.length === 0) {
    return <div className="text-sm text-gray-500">No invocation data</div>;
  }
  const max = Math.max(...data.map((d) => d.completed + d.failed + d.timedOut), 1);

  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d) => {
        const total = d.completed + d.failed + d.timedOut;
        const completedPct = (d.completed / max) * 100;
        const failedPct = (d.failed / max) * 100;
        const timedOutPct = (d.timedOut / max) * 100;
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="w-full flex flex-col justify-end h-24">
              <div className="w-full flex flex-col-reverse" title={`${d.date}: ${total} total`}>
                {d.completed > 0 && (
                  <div className="w-full bg-green-500 rounded-t-sm" style={{ height: `${completedPct}%`, minHeight: "2px" }} />
                )}
                {d.failed > 0 && (
                  <div className="w-full bg-red-500" style={{ height: `${failedPct}%`, minHeight: "2px" }} />
                )}
                {d.timedOut > 0 && (
                  <div className="w-full bg-orange-500" style={{ height: `${timedOutPct}%`, minHeight: "2px" }} />
                )}
              </div>
            </div>
            <span className="text-[10px] text-gray-500 truncate w-full text-center" title={d.date}>
              {d.date.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

const LINE_COUNT_OPTIONS = [100, 200, 500, 1000] as const;

interface Props {
  onNavigateToTask?: (taskId: string) => void;
}

export default function ObservabilityPage({ onNavigateToTask }: Props) {
  // Metrics state
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  // Error aggregation state
  const [errors, setErrors] = useState<ErrorAggregation[]>([]);
  const [errorsError, setErrorsError] = useState<string | null>(null);

  // System logs state
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logTotalLines, setLogTotalLines] = useState(0);
  const [logSearch, setLogSearch] = useState("");
  const [logSearchInput, setLogSearchInput] = useState("");
  const [logLineCount, setLogLineCount] = useState<number>(200);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Refresh counter to trigger re-fetches of metrics/errors
  const [refreshKey, setRefreshKey] = useState(0);

  // Load metrics and errors (re-fetched when refreshKey changes)
  useEffect(() => {
    setMetricsError(null);
    setErrorsError(null);
    fetchMetrics()
      .then(setMetrics)
      .catch((err) => setMetricsError(err instanceof Error ? err.message : String(err)));

    fetchErrorAggregation()
      .then((data) => setErrors(data.errors))
      .catch((err) => setErrorsError(err instanceof Error ? err.message : String(err)));
  }, [refreshKey]);

  // Load system logs
  const loadLogs = useCallback(() => {
    fetchSystemLogs(logLineCount, logSearch)
      .then((data) => {
        setLogLines(data.lines);
        setLogTotalLines(data.totalLines);
      })
      .catch(console.error);
  }, [logLineCount, logSearch]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Auto-refresh logs
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(loadLogs, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadLogs]);

  // Auto-scroll log container when new lines arrive
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logLines]);

  const handleLogSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLogSearch(logSearchInput);
  };

  const successRate = metrics && metrics.totalInvocations > 0
    ? ((metrics.completedInvocations / metrics.totalInvocations) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="p-4 space-y-6 max-w-full">
      {/* Section 1: Metrics Overview */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Metrics Overview</h2>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-600 transition-colors"
          >
            Refresh
          </button>
        </div>
        {metricsError ? (
          <div className="text-sm text-red-400">Failed to load metrics: {metricsError}</div>
        ) : !metrics ? (
          <div className="text-sm text-gray-500">Loading metrics...</div>
        ) : (
          <div className="space-y-4">
            {/* Stats cards row */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="Total Invocations" value={String(metrics.totalInvocations)} />
              <StatCard
                label="Success Rate"
                value={`${successRate}%`}
                sub={`${metrics.completedInvocations} completed`}
              />
              <StatCard label="Avg Cost" value={formatCost(metrics.avgCostPerInvocation)} />
              <StatCard label="Avg Duration" value={formatDuration(metrics.avgDurationSec)} />
              <StatCard label="Total Cost" value={formatCost(metrics.totalCostUsd)} />
              <StatCard
                label="Avg Turns"
                value={metrics.avgTurnsPerInvocation.toFixed(1)}
              />
            </div>

            {/* Charts row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <h3 className="text-xs text-gray-500 uppercase tracking-wide mb-3">Cost Trend</h3>
                <CostBarChart data={metrics.costByDay} />
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <h3 className="text-xs text-gray-500 uppercase tracking-wide mb-3">Invocations Trend</h3>
                <InvocationBarChart data={metrics.invocationsByDay} />
                <div className="flex gap-4 mt-2 text-[10px] text-gray-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-sm inline-block" /> completed</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-500 rounded-sm inline-block" /> failed</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 bg-orange-500 rounded-sm inline-block" /> timed out</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Section 2: Error Aggregation */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Error Patterns</h2>
        {errorsError ? (
          <div className="text-sm text-red-400">Failed to load errors: {errorsError}</div>
        ) : errors.length === 0 ? (
          <div className="text-sm text-gray-500">No errors recorded</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-2">Error Pattern</th>
                  <th className="px-4 py-2">Count</th>
                  <th className="px-4 py-2">Last Occurrence</th>
                  <th className="px-4 py-2">Affected Tasks</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((err, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="px-4 py-2 text-red-400 max-w-sm truncate" title={err.summary}>
                      {err.summary}
                    </td>
                    <td className="px-4 py-2 text-gray-300 tabular-nums">{err.count}</td>
                    <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{formatDate(err.lastOccurrence)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {err.taskIds.map((id) => (
                          <button
                            key={id}
                            onClick={() => onNavigateToTask?.(id)}
                            className="text-xs text-blue-400 hover:text-blue-300 hover:underline font-mono"
                          >
                            {id}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 3: System Logs */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">System Logs</h2>
        <div className="space-y-2">
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <form onSubmit={handleLogSearchSubmit} className="flex gap-2">
              <input
                type="text"
                value={logSearchInput}
                onChange={(e) => setLogSearchInput(e.target.value)}
                placeholder="Search logs..."
                className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 w-64"
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-sm rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Search
              </button>
            </form>

            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500">Lines:</span>
              {LINE_COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setLogLineCount(n)}
                  className={`px-2 py-1 text-xs rounded ${
                    logLineCount === n
                      ? "bg-gray-700 text-gray-100"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer ml-auto">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-0"
              />
              Auto-refresh (5s)
            </label>

            {logTotalLines >= 0 && (
              <span className="text-xs text-gray-500 tabular-nums">{logTotalLines} total lines</span>
            )}
          </div>

          {/* Log output */}
          <div
            ref={logContainerRef}
            className="bg-gray-900 border border-gray-800 rounded-lg p-3 max-h-96 overflow-y-auto font-mono text-xs leading-relaxed"
          >
            {logLines.length === 0 ? (
              <span className="text-gray-500">No log lines</span>
            ) : (
              logLines.map((line, i) => {
                const lower = line.toLowerCase();
                let lineClass = "text-gray-400";
                if (lower.includes("error")) lineClass = "text-red-400";
                else if (lower.includes("warn")) lineClass = "text-yellow-400";
                return (
                  <div key={i} className={`${lineClass} whitespace-pre-wrap break-all`}>
                    {line}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
