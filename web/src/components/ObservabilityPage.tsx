import { useState, useEffect, useRef, useCallback } from "react";
import type {
  LogsResponse,
  MetricsResponse,
  DailyMetric,
  TaskCost,
  ErrorsResponse,
  ErrorPattern,
  RecentError,
} from "../types";
import { fetchLogs, fetchMetrics, fetchErrors } from "../hooks/useApi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatDurationMinutes(ms: number): string {
  const mins = ms / 60_000;
  if (mins < 1) return `${(ms / 1000).toFixed(1)}s`;
  return `${mins.toFixed(1)}m`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatShortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

type Tab = "logs" | "metrics" | "errors";

const TABS: { key: Tab; label: string }[] = [
  { key: "logs", label: "System Logs" },
  { key: "metrics", label: "Metrics" },
  { key: "errors", label: "Errors" },
];

// ---------------------------------------------------------------------------
// System Logs Tab
// ---------------------------------------------------------------------------

function LogsTab() {
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadLogs = useCallback(() => {
    fetchLogs(undefined, debouncedSearch || undefined)
      .then((data) => {
        setLogs(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [debouncedSearch]);

  // Load on mount and when search changes
  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(loadLogs, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadLogs]);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  function colorLine(line: string): string {
    const lower = line.toLowerCase();
    if (lower.includes("error")) return "text-red-400";
    if (lower.includes("warning") || lower.includes("warn")) return "text-yellow-400";
    return "text-gray-300";
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600"
        />
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            autoRefresh
              ? "bg-green-500/20 text-green-400 border border-green-500/30"
              : "bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200"
          }`}
        >
          {autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
        </button>
        <button
          onClick={loadLogs}
          className="px-3 py-1.5 rounded text-xs bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Line count */}
      {logs && (
        <div className="text-xs text-gray-500">
          {debouncedSearch
            ? `${logs.lines.length} lines shown / ${logs.matchedLines} matched / ${logs.totalLines} total`
            : `${logs.lines.length} lines shown / ${logs.totalLines} total`}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400">Error loading logs: {error}</div>
      )}

      {/* Log output */}
      <div
        ref={logContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-lg p-4 max-h-[calc(100vh-18rem)] overflow-y-auto"
      >
        {logs && logs.lines.length > 0 ? (
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {logs.lines.map((line, i) => (
              <div key={i} className={colorLine(line)}>
                {line}
              </div>
            ))}
          </pre>
        ) : logs && logs.lines.length === 0 ? (
          <div className="text-sm text-gray-500">No log lines{debouncedSearch ? " matching search" : ""}</div>
        ) : !error ? (
          <div className="text-sm text-gray-500">Loading...</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics Tab
// ---------------------------------------------------------------------------

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-gray-100 tabular-nums">{value}</div>
    </div>
  );
}

function DailyChart({ daily }: { daily: DailyMetric[] }) {
  const data = [...daily]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  if (data.length === 0) {
    return <div className="text-sm text-gray-500">No daily data available</div>;
  }

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-4">Daily Invocations (last 14 days)</h3>
      <div className="flex items-end gap-1.5" style={{ height: "160px" }}>
        {data.map((d) => {
          const totalHeight = (d.count / maxCount) * 100;
          const completedPct = d.count > 0 ? (d.completed / d.count) * 100 : 0;
          const failedPct = d.count > 0 ? (d.failed / d.count) * 100 : 0;
          const timedOutPct = d.count > 0 ? (d.timedOut / d.count) * 100 : 0;
          const runningPct = d.count > 0 ? (d.running / d.count) * 100 : 0;

          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center gap-1"
              title={`${d.date}: ${d.count} total (${d.completed} ok, ${d.failed} failed, ${d.timedOut} timed out, ${d.running} running)`}
            >
              <div
                className="w-full flex flex-col justify-end rounded-t overflow-hidden"
                style={{ height: `${totalHeight}%`, minHeight: d.count > 0 ? "4px" : "0" }}
              >
                {runningPct > 0 && (
                  <div className="w-full bg-blue-500" style={{ height: `${runningPct}%` }} />
                )}
                {timedOutPct > 0 && (
                  <div className="w-full bg-orange-500" style={{ height: `${timedOutPct}%` }} />
                )}
                {failedPct > 0 && (
                  <div className="w-full bg-red-500" style={{ height: `${failedPct}%` }} />
                )}
                {completedPct > 0 && (
                  <div className="w-full bg-green-500" style={{ height: `${completedPct}%` }} />
                )}
              </div>
              <span className="text-[10px] text-gray-500 whitespace-nowrap">
                {formatShortDate(d.date)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex gap-4 mt-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-green-500 inline-block" /> Completed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-red-500 inline-block" /> Failed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-orange-500 inline-block" /> Timed Out
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded bg-blue-500 inline-block" /> Running
        </span>
      </div>
    </div>
  );
}

function TopTasksTable({ tasks }: { tasks: TaskCost[] }) {
  if (tasks.length === 0) {
    return <div className="text-sm text-gray-500">No task cost data available</div>;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Top 10 Most Expensive Tasks</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Task ID</th>
              <th className="pb-2 pr-4">Total Cost</th>
              <th className="pb-2 pr-4"># Invocations</th>
              <th className="pb-2 pr-4">Avg Cost</th>
            </tr>
          </thead>
          <tbody>
            {tasks.slice(0, 10).map((t) => (
              <tr key={t.taskId} className="border-b border-gray-800/50">
                <td className="py-2 pr-4 font-mono text-gray-300">{t.taskId}</td>
                <td className="py-2 pr-4 text-gray-300 tabular-nums">{formatCost(t.totalCost)}</td>
                <td className="py-2 pr-4 text-gray-300 tabular-nums">{t.invocationCount}</td>
                <td className="py-2 pr-4 text-gray-300 tabular-nums">
                  {t.invocationCount > 0 ? formatCost(t.totalCost / t.invocationCount) : "\u2014"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricsTab() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMetrics()
      .then((data) => {
        setMetrics(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (error) {
    return <div className="text-sm text-red-400">Error loading metrics: {error}</div>;
  }

  if (!metrics) {
    return <div className="text-sm text-gray-500">Loading metrics...</div>;
  }

  const { summary } = metrics;
  const successRate =
    summary.finished > 0
      ? ((summary.completed / summary.finished) * 100).toFixed(1)
      : "\u2014";

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Total Invocations" value={String(summary.total)} />
        <SummaryCard label="Success Rate" value={successRate === "\u2014" ? "\u2014" : `${successRate}%`} />
        <SummaryCard label="Avg Cost" value={formatCost(summary.avgCost)} />
        <SummaryCard label="Avg Duration" value={formatDurationMinutes(summary.avgDurationMs)} />
        <SummaryCard label="Avg Turns" value={summary.avgTurns.toFixed(1)} />
        <SummaryCard label="Total Cost" value={formatCost(summary.totalCost)} />
      </div>

      {/* Daily chart */}
      <DailyChart daily={metrics.daily} />

      {/* Top tasks */}
      <TopTasksTable tasks={metrics.topTasks} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Errors Tab
// ---------------------------------------------------------------------------

function statusBadge(status: string): string {
  switch (status) {
    case "failed": return "bg-red-500/20 text-red-400";
    case "timed_out": return "bg-orange-500/20 text-orange-400";
    default: return "bg-gray-500/20 text-gray-400";
  }
}

function ErrorPatternsTable({ patterns }: { patterns: ErrorPattern[] }) {
  if (patterns.length === 0) {
    return <div className="text-sm text-gray-500">No error patterns detected</div>;
  }

  const sorted = [...patterns].sort((a, b) => b.count - a.count);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Error Patterns</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Pattern</th>
              <th className="pb-2 pr-4">Count</th>
              <th className="pb-2 pr-4">Last Seen</th>
              <th className="pb-2 pr-4">Affected Tasks</th>
              <th className="pb-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p, i) => (
              <tr key={i} className="border-b border-gray-800/50">
                <td className="py-2 pr-4 text-gray-300 max-w-xs truncate" title={p.pattern}>
                  {p.pattern}
                </td>
                <td className="py-2 pr-4 text-gray-300 tabular-nums">{p.count}</td>
                <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">{formatDate(p.lastSeen)}</td>
                <td className="py-2 pr-4 text-gray-400">
                  <span className="font-mono text-xs">
                    {p.affectedTasks.slice(0, 3).join(", ")}
                    {p.affectedTasks.length > 3 && ` +${p.affectedTasks.length - 3}`}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(p.status)}`}>
                    {p.status === "timed_out" ? "timed out" : p.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecentErrorsTable({ errors }: { errors: RecentError[] }) {
  if (errors.length === 0) {
    return <div className="text-sm text-gray-500">No recent errors</div>;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-3">Recent Errors</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">ID</th>
              <th className="pb-2 pr-4">Task</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Phase</th>
              <th className="pb-2 pr-4">Started</th>
              <th className="pb-2 pr-4">Duration</th>
              <th className="pb-2 pr-4">Cost</th>
              <th className="pb-2 pr-4">Summary</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => {
              const duration =
                e.startedAt && e.endedAt
                  ? formatDuration(new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime())
                  : "\u2014";

              return (
                <tr key={e.id} className="border-b border-gray-800/50">
                  <td className="py-2 pr-4 text-gray-400 tabular-nums">{e.id}</td>
                  <td className="py-2 pr-4 font-mono text-gray-300">{e.taskId}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(e.status)}`}>
                      {e.status === "timed_out" ? "timed out" : e.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-400">{e.phase ?? "\u2014"}</td>
                  <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">{formatDate(e.startedAt)}</td>
                  <td className="py-2 pr-4 text-gray-300 tabular-nums whitespace-nowrap">{duration}</td>
                  <td className="py-2 pr-4 text-gray-300 tabular-nums">{e.costUsd != null ? formatCost(e.costUsd) : "\u2014"}</td>
                  <td className="py-2 pr-4 text-gray-400 max-w-xs truncate" title={e.outputSummary ?? ""}>
                    {e.outputSummary ?? "\u2014"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorsTab() {
  const [data, setData] = useState<ErrorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchErrors()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (error) {
    return <div className="text-sm text-red-400">Error loading errors: {error}</div>;
  }

  if (!data) {
    return <div className="text-sm text-gray-500">Loading errors...</div>;
  }

  return (
    <div className="space-y-6">
      <ErrorPatternsTable patterns={data.patterns} />
      <RecentErrorsTable errors={data.recentErrors} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ObservabilityPage() {
  const [activeTab, setActiveTab] = useState<Tab>("logs");

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="p-3 border-b border-gray-800 flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              activeTab === tab.key
                ? "bg-gray-700 text-gray-100"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "logs" && <LogsTab />}
        {activeTab === "metrics" && <MetricsTab />}
        {activeTab === "errors" && <ErrorsTab />}
      </div>
    </div>
  );
}
