import { useState, useEffect, useRef, useCallback } from "react";
import type { Metrics, GlobalLogs } from "../types";
import { fetchMetrics, fetchGlobalLogs } from "../hooks/useApi";

function statusBadge(s: string): string {
  switch (s) {
    case "done": case "completed": return "bg-green-500/20 text-green-400";
    case "running": return "bg-blue-500/20 text-blue-400";
    case "ready": return "bg-cyan-500/20 text-cyan-400";
    case "failed": return "bg-red-500/20 text-red-400";
    case "dispatched": return "bg-gray-500/20 text-gray-400";
    case "timed_out": return "bg-orange-500/20 text-orange-400";
    default: return "bg-gray-500/20 text-gray-400";
  }
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface StatCardProps {
  label: string;
  value: string | number;
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-1">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-mono font-semibold text-gray-100">{value}</div>
    </div>
  );
}

export default function MetricsView() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [logs, setLogs] = useState<GlobalLogs | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [tailMode, setTailMode] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const loadMetrics = useCallback(() => {
    fetchMetrics()
      .then(setMetrics)
      .catch((err) => setMetricsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const loadLogs = useCallback(() => {
    fetchGlobalLogs(200)
      .then(setLogs)
      .catch(() => { /* silently ignore */ });
  }, []);

  useEffect(() => {
    loadMetrics();
    loadLogs();
  }, [loadMetrics, loadLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      loadMetrics();
      loadLogs();
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadMetrics, loadLogs]);

  useEffect(() => {
    if (tailMode && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, tailMode]);

  if (metricsError) {
    return <div className="p-6 text-red-400 text-sm">Failed to load metrics: {metricsError}</div>;
  }

  if (!metrics) {
    return <div className="p-6 text-gray-500 text-sm">Loading metrics...</div>;
  }

  return (
    <div className="p-6 space-y-8 max-w-full">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Invocations" value={metrics.invocationStats.total} />
        <StatCard label="Completed" value={metrics.invocationStats.completed} />
        <StatCard label="Failed" value={metrics.invocationStats.failed} />
        <StatCard label="Total Cost" value={`$${metrics.costStats.totalUsd.toFixed(2)}`} />
      </div>

      {/* Recent Invocations table */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">Recent Invocations</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          {metrics.recentInvocations.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No invocations yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pt-3 px-4">Task</th>
                  <th className="pb-2 pt-3 px-4">Date</th>
                  <th className="pb-2 pt-3 px-4">Duration</th>
                  <th className="pb-2 pt-3 px-4">Status</th>
                  <th className="pb-2 pt-3 px-4">Cost</th>
                  <th className="pb-2 pt-3 px-4">Turns</th>
                  <th className="pb-2 pt-3 px-4">Phase</th>
                  <th className="pb-2 pt-3 px-4">Summary</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentInvocations.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="py-2 px-4 font-mono text-gray-300 whitespace-nowrap">{inv.linearIssueId}</td>
                    <td className="py-2 px-4 text-gray-400 whitespace-nowrap">{formatDate(inv.startedAt)}</td>
                    <td className="py-2 px-4 text-gray-400 whitespace-nowrap tabular-nums">{formatDuration(inv.startedAt, inv.endedAt)}</td>
                    <td className="py-2 px-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(inv.status)}`}>{inv.status}</span>
                    </td>
                    <td className="py-2 px-4 text-gray-400 tabular-nums">{inv.costUsd != null ? `$${inv.costUsd.toFixed(2)}` : "\u2014"}</td>
                    <td className="py-2 px-4 text-gray-400 tabular-nums">{inv.numTurns ?? "\u2014"}</td>
                    <td className="py-2 px-4 text-gray-500 text-xs">{inv.phase ?? "\u2014"}</td>
                    <td className="py-2 px-4 text-gray-500 truncate max-w-xs">{inv.outputSummary ?? "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Error Summary */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">Error Summary</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          {metrics.errorSummary.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No failures recorded.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pt-3 px-4">Reason</th>
                  <th className="pb-2 pt-3 px-4 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {metrics.errorSummary.map((row, idx) => (
                  <tr key={idx} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="py-2 px-4 text-gray-300">{row.outputSummary}</td>
                    <td className="py-2 px-4 text-gray-400 tabular-nums text-right">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Global Log Viewer */}
      <div>
        <div className="flex items-center gap-4 mb-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Global Log</h2>
          {logs && (
            <span className="text-xs text-gray-600">{logs.lines.length} line{logs.lines.length !== 1 ? "s" : ""}</span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={tailMode} onChange={(e) => setTailMode(e.target.checked)} className="accent-purple-500" />
              Tail
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-purple-500" />
              Auto-refresh (5s)
            </label>
          </div>
        </div>
        <div
          ref={logContainerRef}
          className="bg-gray-900 border border-gray-800 rounded-lg p-3 h-80 overflow-y-auto font-mono text-xs text-gray-400 leading-relaxed"
        >
          {!logs ? (
            <span className="text-gray-600">Loading...</span>
          ) : logs.lines.length === 0 ? (
            <span className="text-gray-600">No log output ({logs.logPath})</span>
          ) : (
            logs.lines.map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-all">{line}</div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
