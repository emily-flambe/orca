import { useState, useEffect } from "react";
import type { MetricsSummary, TimelineEntry, ErrorEntry } from "../types";
import { fetchMetrics, fetchMetricsTimeline, fetchMetricsErrors } from "../hooks/useApi";

interface Props {
  onSelectTask: (taskId: string) => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "\u2014";
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function costColor(usd: number): string {
  if (usd < 1) return "text-green-400";
  if (usd < 5) return "text-yellow-400";
  return "text-red-400";
}

export default function ObservabilityDashboard({ onSelectTask }: Props) {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedError, setExpandedError] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetchMetrics(),
      fetchMetricsTimeline(30),
      fetchMetricsErrors(20),
    ])
      .then(([m, t, e]) => {
        setMetrics(m);
        setTimeline(t.timeline);
        setErrors(e.errors);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  if (!metrics) {
    return <div className="p-6 text-gray-500">Failed to load metrics.</div>;
  }

  const doneCount = metrics.tasksByStatus["done"] ?? 0;
  const failedCount = metrics.tasksByStatus["failed"] ?? 0;
  const activeCount = Object.entries(metrics.tasksByStatus)
    .filter(([k]) => k !== "done" && k !== "failed" && k !== "backlog")
    .reduce((sum, [, v]) => sum + v, 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-gray-400 text-xs mb-1">Total Invocations</div>
          <div className="text-2xl font-semibold text-white tabular-nums">
            {metrics.totalInvocations}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            <span className="text-green-400 tabular-nums">{(metrics.successRate * 100).toFixed(1)}%</span> success rate
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-gray-400 text-xs mb-1">Total Cost</div>
          <div className="text-2xl font-semibold text-white tabular-nums">
            {formatCost(metrics.totalCostUsd)}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {metrics.totalInvocations > 0
              ? `${formatCost(metrics.totalCostUsd / metrics.totalInvocations)} avg/invocation`
              : "no invocations"}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-gray-400 text-xs mb-1">Avg Session Duration</div>
          <div className="text-2xl font-semibold text-white tabular-nums">
            {formatDuration(metrics.avgDurationSec)}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-gray-400 text-xs mb-1">Task Breakdown</div>
          <div className="text-2xl font-semibold text-white tabular-nums">
            {doneCount + failedCount + activeCount}
          </div>
          <div className="text-xs mt-1 flex gap-3">
            <span className="text-green-400">{doneCount} done</span>
            <span className="text-red-400">{failedCount} failed</span>
            <span className="text-blue-400">{activeCount} active</span>
          </div>
        </div>
      </div>

      {/* Timeline chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Cost & Activity (30 days)</h3>
        <TimelineChart timeline={timeline} />
      </div>

      {/* Error aggregation table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Recurring Errors</h3>
        {errors.length === 0 ? (
          <div className="text-sm text-gray-500">No errors recorded.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Error Pattern</th>
                  <th className="pb-2 pr-4">Count</th>
                  <th className="pb-2 pr-4">Last Seen</th>
                  <th className="pb-2">Affected Tasks</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((err, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 text-gray-300 max-w-md">
                      <div
                        className={`${expandedError === i ? "whitespace-pre-wrap" : "truncate"} cursor-pointer`}
                        title={expandedError === i ? undefined : err.outputSummary}
                        onClick={() => setExpandedError(expandedError === i ? null : i)}
                      >
                        {err.outputSummary}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-gray-300 tabular-nums">{err.count}</td>
                    <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">{formatDate(err.lastSeen)}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {err.taskIds.split(",").map((id) => {
                          const trimmed = id.trim();
                          return (
                            <button
                              key={trimmed}
                              onClick={() => onSelectTask(trimmed)}
                              className="text-xs font-mono text-blue-400 hover:text-blue-300 hover:underline"
                            >
                              {trimmed}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Per-task cost table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h3 className="text-sm text-gray-400 mb-3">Cost per Task</h3>
        {metrics.taskMetrics.length === 0 ? (
          <div className="text-sm text-gray-500">No task metrics available.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Task ID</th>
                  <th className="pb-2 pr-4">Invocations</th>
                  <th className="pb-2 pr-4">Completed</th>
                  <th className="pb-2 pr-4">Failed</th>
                  <th className="pb-2 pr-4">Avg Duration</th>
                  <th className="pb-2">Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {metrics.taskMetrics.map((tm) => (
                  <tr key={tm.linearIssueId} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4">
                      <button
                        onClick={() => onSelectTask(tm.linearIssueId)}
                        className="text-sm font-mono text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {tm.linearIssueId}
                      </button>
                    </td>
                    <td className="py-2 pr-4 text-gray-300 tabular-nums">{tm.totalInvocations}</td>
                    <td className="py-2 pr-4 text-green-400 tabular-nums">{tm.completedCount}</td>
                    <td className="py-2 pr-4 text-red-400 tabular-nums">{tm.failedCount}</td>
                    <td className="py-2 pr-4 text-gray-300 tabular-nums">{formatDuration(tm.avgDurationSec)}</td>
                    <td className={`py-2 tabular-nums ${costColor(tm.totalCostUsd)}`}>
                      {formatCost(tm.totalCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- SVG Timeline Chart ---- */

function TimelineChart({ timeline }: { timeline: TimelineEntry[] }) {
  if (timeline.length === 0) {
    return <div className="text-sm text-gray-500">No timeline data.</div>;
  }

  const chartWidth = 800;
  const chartHeight = 200;
  const padLeft = 50;
  const padRight = 20;
  const padTop = 10;
  const padBottom = 30;

  const innerW = chartWidth - padLeft - padRight;
  const innerH = chartHeight - padTop - padBottom;

  const maxCost = Math.max(...timeline.map((d) => d.costUsd), 0.01);
  const maxCount = Math.max(
    ...timeline.map((d) => Math.max(d.completedCount, d.failedCount)),
    1,
  );

  const barWidth = Math.max(Math.floor(innerW / timeline.length) - 2, 2);

  return (
    <svg
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      className="w-full"
      style={{ height: "200px" }}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y-axis labels */}
      <text x={padLeft - 4} y={padTop + 4} textAnchor="end" className="fill-gray-500" fontSize="10">
        {formatCostAxis(maxCost)}
      </text>
      <text x={padLeft - 4} y={padTop + innerH} textAnchor="end" className="fill-gray-500" fontSize="10">
        $0
      </text>

      {/* Y-axis line */}
      <line
        x1={padLeft}
        y1={padTop}
        x2={padLeft}
        y2={padTop + innerH}
        stroke="#374151"
        strokeWidth="1"
      />
      {/* X-axis line */}
      <line
        x1={padLeft}
        y1={padTop + innerH}
        x2={padLeft + innerW}
        y2={padTop + innerH}
        stroke="#374151"
        strokeWidth="1"
      />

      {/* Bars and markers */}
      {timeline.map((entry, i) => {
        const x = padLeft + (i / timeline.length) * innerW + 1;
        const barH = (entry.costUsd / maxCost) * innerH;
        const barY = padTop + innerH - barH;

        // Marker sizes for completed/failed counts
        const completedR = Math.max((entry.completedCount / maxCount) * 5, entry.completedCount > 0 ? 2 : 0);
        const failedR = Math.max((entry.failedCount / maxCount) * 5, entry.failedCount > 0 ? 2 : 0);

        const showLabel = i % 7 === 0 || i === timeline.length - 1;

        return (
          <g key={entry.date}>
            {/* Cost bar */}
            <rect
              x={x}
              y={barY}
              width={barWidth}
              height={Math.max(barH, 0)}
              fill="#22c55e"
              opacity="0.7"
              rx="1"
            >
              <title>{`${formatDate(entry.date)}: ${formatCostAxis(entry.costUsd)} | ${entry.completedCount} completed, ${entry.failedCount} failed`}</title>
            </rect>

            {/* Completed count marker */}
            {completedR > 0 && (
              <circle
                cx={x + barWidth / 2}
                cy={barY - completedR - 2}
                r={completedR}
                fill="#4ade80"
              />
            )}

            {/* Failed count marker */}
            {failedR > 0 && (
              <circle
                cx={x + barWidth / 2}
                cy={barY - completedR - failedR - 6}
                r={failedR}
                fill="#f87171"
              />
            )}

            {/* X-axis label */}
            {showLabel && (
              <text
                x={x + barWidth / 2}
                y={padTop + innerH + 16}
                textAnchor="middle"
                className="fill-gray-500"
                fontSize="9"
              >
                {formatDate(entry.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function formatCostAxis(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}
