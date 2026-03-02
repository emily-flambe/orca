import { useState, useEffect, useCallback, useRef } from "react";
import type { OrcaMetrics, SystemLogs } from "../types";
import { fetchMetrics, fetchSystemLogs } from "../hooks/useApi";

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-mono text-gray-100 mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple bar chart (no external deps)
// ---------------------------------------------------------------------------

function BarChart({
  data,
  barKey,
  secondaryKey,
  label,
}: {
  data: Array<Record<string, unknown>>;
  barKey: string;
  secondaryKey?: string;
  label: string;
}) {
  if (data.length === 0) {
    return <div className="text-sm text-gray-500">No data yet</div>;
  }

  const maxVal = Math.max(
    ...data.map((d) => {
      const primary = Number(d[barKey]) || 0;
      const secondary = secondaryKey ? Number(d[secondaryKey]) || 0 : 0;
      return primary + secondary;
    }),
    1,
  );

  // Show at most 30 bars
  const visible = data.slice(-30);

  return (
    <div>
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className="flex items-end gap-px h-24">
        {visible.map((d, i) => {
          const primary = Number(d[barKey]) || 0;
          const secondary = secondaryKey ? Number(d[secondaryKey]) || 0 : 0;
          const totalPct = ((primary + secondary) / maxVal) * 100;
          const primaryPct = (primary / maxVal) * 100;
          const dateStr = String(d.date ?? "");
          const tooltip = secondaryKey
            ? `${dateStr}: ${barKey}=${primary}, ${secondaryKey}=${secondary}`
            : `${dateStr}: ${primary.toFixed(2)}`;

          return (
            <div
              key={i}
              className="flex-1 flex flex-col justify-end min-w-[4px] group relative"
              title={tooltip}
            >
              {secondaryKey ? (
                <>
                  <div
                    className="bg-red-500/60 rounded-t-sm"
                    style={{ height: `${totalPct - primaryPct}%` }}
                  />
                  <div
                    className="bg-green-500/60"
                    style={{ height: `${primaryPct}%` }}
                  />
                </>
              ) : (
                <div
                  className="bg-blue-500/60 rounded-t-sm"
                  style={{ height: `${totalPct}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      {visible.length > 0 && (
        <div className="flex justify-between text-[10px] text-gray-600 mt-1">
          <span>{String(visible[0].date ?? "").slice(5)}</span>
          <span>{String(visible[visible.length - 1].date ?? "").slice(5)}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task status breakdown
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-500",
  dispatched: "bg-gray-500",
  ready: "bg-cyan-500",
  in_review: "bg-purple-500",
  awaiting_ci: "bg-yellow-500",
  deploying: "bg-teal-500",
  changes_requested: "bg-orange-500",
  done: "bg-green-500",
  failed: "bg-red-500",
  backlog: "bg-gray-600",
};

function TaskStatusBreakdown({ tasksByStatus }: { tasksByStatus: Record<string, number> }) {
  const total = Object.values(tasksByStatus).reduce((a, b) => a + b, 0);
  if (total === 0) return <div className="text-sm text-gray-500">No tasks</div>;

  return (
    <div className="space-y-1.5">
      {Object.entries(tasksByStatus)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => (
          <div key={status} className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[status] ?? "bg-gray-500"}`} />
            <span className="text-gray-400 w-28">{status}</span>
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full ${STATUS_COLORS[status] ?? "bg-gray-500"} rounded-full`}
                style={{ width: `${(count / total) * 100}%` }}
              />
            </div>
            <span className="text-gray-300 tabular-nums w-6 text-right">{count}</span>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System log viewer
// ---------------------------------------------------------------------------

const LOG_LEVELS = ["all", "scheduler", "runner", "linear", "webhook", "cleanup", "cli"] as const;

function SystemLogViewer() {
  const [logs, setLogs] = useState<SystemLogs>({ lines: [], totalLines: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<string>("all");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [maxLines, setMaxLines] = useState(200);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetchSystemLogs({
      lines: maxLines,
      search: search || undefined,
      level: level === "all" ? undefined : level,
    })
      .then(setLogs)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [search, level, maxLines]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  // Auto-scroll to bottom on new data
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.lines]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 w-48 placeholder-gray-600"
        />
        <div className="flex gap-1">
          {LOG_LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className={`px-2 py-1 text-xs rounded ${
                level === l ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          value={maxLines}
          onChange={(e) => setMaxLines(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
        >
          <option value={100}>100 lines</option>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="rounded"
          />
          Auto-refresh
        </label>
        <button
          onClick={load}
          className="px-2 py-1 text-xs rounded bg-gray-700 text-gray-300 hover:text-gray-100"
        >
          Refresh
        </button>
        <span className="text-xs text-gray-600 ml-auto">
          {logs.lines.length} / {logs.totalLines} lines
        </span>
      </div>

      {loading && logs.lines.length === 0 ? (
        <div className="text-sm text-gray-500 p-4">Loading system logs...</div>
      ) : logs.lines.length === 0 ? (
        <div className="text-sm text-gray-500 p-4">No log entries found</div>
      ) : (
        <div
          ref={containerRef}
          className="bg-gray-900 border border-gray-800 rounded-lg p-3 max-h-[32rem] overflow-y-auto font-mono text-xs leading-relaxed"
        >
          {logs.lines.map((line, i) => {
            // Colorize log level tags
            let lineClass = "text-gray-300";
            if (line.includes("[orca/runner]")) lineClass = "text-blue-300";
            else if (line.includes("[orca/scheduler]")) lineClass = "text-cyan-300";
            else if (line.includes("[orca/linear]")) lineClass = "text-purple-300";
            else if (line.includes("[orca/webhook]")) lineClass = "text-yellow-300";
            else if (line.includes("[orca/cleanup]")) lineClass = "text-orange-300";
            else if (line.includes("[orca/cli]")) lineClass = "text-green-300";
            else if (line.toLowerCase().includes("error") || line.toLowerCase().includes("fail")) {
              lineClass = "text-red-300";
            }

            return (
              <div key={i} className={`${lineClass} hover:bg-gray-800/50`}>
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error aggregation table
// ---------------------------------------------------------------------------

function ErrorTable({
  errors,
}: {
  errors: Array<{ taskId: string; summary: string; count: number; lastSeen: string }>;
}) {
  if (errors.length === 0) {
    return <div className="text-sm text-gray-500">No errors recorded</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-800">
            <th className="pb-2 pr-4">Error</th>
            <th className="pb-2 pr-4">Count</th>
            <th className="pb-2 pr-4">Last Task</th>
            <th className="pb-2">Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {errors.slice(0, 20).map((err, i) => (
            <tr key={i} className="border-b border-gray-800/50">
              <td className="py-2 pr-4 text-red-400 max-w-xs truncate" title={err.summary}>
                {err.summary}
              </td>
              <td className="py-2 pr-4 text-gray-300 tabular-nums">{err.count}</td>
              <td className="py-2 pr-4 text-gray-400 font-mono text-xs">{err.taskId}</td>
              <td className="py-2 text-gray-500 text-xs whitespace-nowrap">
                {new Date(err.lastSeen).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type Tab = "metrics" | "logs" | "errors";

export default function ObservabilityPage() {
  const [tab, setTab] = useState<Tab>("metrics");
  const [metrics, setMetrics] = useState<OrcaMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMetrics()
      .then(setMetrics)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const refreshMetrics = useCallback(() => {
    fetchMetrics().then(setMetrics).catch(console.error);
  }, []);

  if (loading) {
    return <div className="p-6 text-gray-500">Loading metrics...</div>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "metrics", label: "Metrics" },
    { key: "logs", label: "System Logs" },
    { key: "errors", label: "Errors" },
  ];

  function formatDuration(secs: number): string {
    if (secs < 60) return `${Math.round(secs)}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = Math.round(secs % 60);
    return `${mins}m ${remSecs}s`;
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b border-gray-800 pb-px">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t.key
                ? "border-blue-500 text-gray-100"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={refreshMetrics}
          className="ml-auto px-3 py-1 text-xs rounded bg-gray-700 text-gray-300 hover:text-gray-100"
        >
          Refresh
        </button>
      </div>

      {/* Metrics tab */}
      {tab === "metrics" && metrics && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              label="Total Cost"
              value={`$${metrics.totalCost.toFixed(2)}`}
              sub={`avg $${metrics.avgCostPerSession.toFixed(2)}/session`}
            />
            <MetricCard
              label="Sessions"
              value={String(metrics.totalInvocations)}
              sub={`${metrics.completedInvocations} completed`}
            />
            <MetricCard
              label="Success Rate"
              value={
                metrics.totalInvocations > 0
                  ? `${Math.round((metrics.completedInvocations / metrics.totalInvocations) * 100)}%`
                  : "N/A"
              }
              sub={`${metrics.failedInvocations} failed, ${metrics.timedOutInvocations} timed out`}
            />
            <MetricCard
              label="Avg Duration"
              value={formatDuration(metrics.avgSessionDurationSec)}
              sub="completed sessions"
            />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <BarChart
                data={metrics.costTimeSeries}
                barKey="cost"
                label="Daily Cost ($)"
              />
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <BarChart
                data={metrics.throughput}
                barKey="completed"
                secondaryKey="failed"
                label="Daily Throughput (green=completed, red=failed)"
              />
            </div>
          </div>

          {/* Task status breakdown */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">Task Status Breakdown</div>
            <TaskStatusBreakdown tasksByStatus={metrics.tasksByStatus} />
          </div>
        </div>
      )}

      {/* System Logs tab */}
      {tab === "logs" && <SystemLogViewer />}

      {/* Errors tab */}
      {tab === "errors" && metrics && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
            Recent Errors ({metrics.recentErrors.length} distinct)
          </div>
          <ErrorTable errors={metrics.recentErrors} />
        </div>
      )}
    </div>
  );
}
