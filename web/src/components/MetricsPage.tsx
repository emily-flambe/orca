import { useState, useEffect, useCallback } from "react";
import type { MetricsData, RecentError, DailyStatEntry } from "../hooks/useApi";
import { fetchMetrics } from "../hooks/useApi";
import Card from "./ui/Card";
import Skeleton from "./ui/Skeleton";
import SystemMetrics from "./SystemMetrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function costTrendPct(current: number, previous: number): number | null {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CostCards({
  costLast24h,
  costLast7d,
  costPrev24h,
}: {
  costLast24h: number;
  costLast7d: number;
  costPrev24h: number;
}) {
  const trend = costTrendPct(costLast24h, costPrev24h);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Cost (24h)
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold tabular-nums text-gray-100">
            {formatDollars(costLast24h)}
          </span>
          {trend !== null && (
            <span
              className={`text-xs tabular-nums ${trend > 0 ? "text-red-400" : trend < 0 ? "text-green-400" : "text-gray-500"}`}
            >
              {trend > 0 ? "+" : ""}
              {trend}%
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600 mt-1">
          vs prev 24h: {formatDollars(costPrev24h)}
        </div>
      </Card>

      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Cost (7d)
        </div>
        <span className="text-xl font-semibold tabular-nums text-gray-100">
          {formatDollars(costLast7d)}
        </span>
        <div className="text-xs text-gray-600 mt-1">
          avg/day: {formatDollars(costLast7d / 7)}
        </div>
      </Card>

      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Success Rate (12h)
        </div>
        <span className="text-xl font-semibold tabular-nums text-gray-100">
          --
        </span>
        <div className="text-xs text-gray-600 mt-1">completed / total</div>
      </Card>
    </div>
  );
}

function InvocationStatsSection({
  data,
}: {
  data: MetricsData["invocationStats"];
}) {
  const total = data.byStatus.reduce((s, e) => s + e.count, 0);

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        Invocation Stats
      </div>

      {/* Status breakdown bar */}
      {total > 0 && (
        <div className="mb-4">
          <div className="flex h-3 rounded-full overflow-hidden bg-gray-800">
            {data.byStatus.map((entry) => {
              const pct = (entry.count / total) * 100;
              if (pct === 0) return null;
              const color =
                entry.status === "completed"
                  ? "bg-green-500"
                  : entry.status === "failed"
                    ? "bg-red-500"
                    : entry.status === "running"
                      ? "bg-blue-500"
                      : "bg-gray-600";
              return (
                <div
                  key={entry.status}
                  className={`${color} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${entry.status}: ${entry.count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-3 mt-2">
            {data.byStatus.map((entry) => {
              const color =
                entry.status === "completed"
                  ? "text-green-400"
                  : entry.status === "failed"
                    ? "text-red-400"
                    : entry.status === "running"
                      ? "text-blue-400"
                      : "text-gray-400";
              return (
                <div key={entry.status} className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      entry.status === "completed"
                        ? "bg-green-500"
                        : entry.status === "failed"
                          ? "bg-red-500"
                          : entry.status === "running"
                            ? "bg-blue-500"
                            : "bg-gray-600"
                    }`}
                  />
                  <span className={`text-xs capitalize ${color}`}>
                    {entry.status}
                  </span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    {entry.count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <div className="text-xs text-gray-500">Avg Duration</div>
          <div className="text-sm font-medium tabular-nums text-gray-200">
            {data.avgDurationSecs != null
              ? formatDuration(data.avgDurationSecs)
              : "--"}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Avg Cost</div>
          <div className="text-sm font-medium tabular-nums text-gray-200">
            {data.avgCostUsd != null ? formatDollars(data.avgCostUsd) : "--"}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Total Cost</div>
          <div className="text-sm font-medium tabular-nums text-gray-200">
            {data.totalCostUsd != null
              ? formatDollars(data.totalCostUsd)
              : "--"}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Total Invocations</div>
          <div className="text-sm font-medium tabular-nums text-gray-200">
            {total}
          </div>
        </div>
      </div>
    </Card>
  );
}

function DailyStatsChart({ stats }: { stats: DailyStatEntry[] }) {
  if (stats.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          Daily Stats (14d)
        </div>
        <div className="py-6 text-center text-sm text-gray-500">
          No daily stats yet
        </div>
      </Card>
    );
  }

  const maxCount = Math.max(1, ...stats.map((s) => s.completed + s.failed));

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        Daily Stats (14d)
      </div>
      <div className="flex items-end gap-1 h-32">
        {stats.map((day) => {
          const completedH =
            maxCount > 0 ? (day.completed / maxCount) * 100 : 0;
          const failedH = maxCount > 0 ? (day.failed / maxCount) * 100 : 0;
          const dateLabel = day.date.slice(5); // MM-DD
          return (
            <div
              key={day.date}
              className="flex-1 flex flex-col items-center gap-0"
              title={`${day.date}: ${day.completed} completed, ${day.failed} failed, $${day.costUsd.toFixed(2)}`}
            >
              <div className="w-full flex flex-col justify-end h-24">
                {day.failed > 0 && (
                  <div
                    className="w-full bg-red-500 rounded-t-sm min-h-[2px]"
                    style={{ height: `${failedH}%` }}
                  />
                )}
                {day.completed > 0 && (
                  <div
                    className={`w-full bg-green-500 min-h-[2px] ${day.failed === 0 ? "rounded-t-sm" : ""}`}
                    style={{ height: `${completedH}%` }}
                  />
                )}
                {day.completed === 0 && day.failed === 0 && (
                  <div className="w-full bg-gray-800 rounded-t-sm min-h-[2px] h-[2px]" />
                )}
              </div>
              <div className="text-[10px] text-gray-600 mt-1 tabular-nums truncate w-full text-center">
                {dateLabel}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-3">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          <span className="text-xs text-gray-400">Completed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          <span className="text-xs text-gray-400">Failed</span>
        </div>
      </div>
    </Card>
  );
}

function RecentErrorsList({ errors }: { errors: RecentError[] }) {
  if (errors.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          Recent Errors
        </div>
        <div className="py-4 text-center text-sm text-gray-600">
          No recent errors
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        Recent Errors
      </div>
      <div className="divide-y divide-gray-800 max-h-64 overflow-y-auto">
        {errors.map((err) => (
          <div key={err.id} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block h-2 w-2 rounded-full bg-red-500 shrink-0" />
              <span className="text-xs font-mono text-gray-300 tabular-nums">
                {err.linearIssueId}
              </span>
              {err.phase && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                  {err.phase}
                </span>
              )}
              <span className="flex-1" />
              <span className="text-xs text-gray-600 tabular-nums whitespace-nowrap">
                {timeAgo(err.startedAt)}
              </span>
            </div>
            {err.outputSummary && (
              <div className="text-xs text-gray-500 pl-4 line-clamp-2">
                {err.outputSummary}
              </div>
            )}
            <div className="flex gap-3 pl-4 mt-1">
              {err.costUsd != null && (
                <span className="text-xs text-gray-600 tabular-nums">
                  {formatDollars(err.costUsd)}
                </span>
              )}
              {err.status && (
                <span className="text-xs text-red-400">{err.status}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TasksByStatusSection({
  tasksByStatus,
}: {
  tasksByStatus: Record<string, number>;
}) {
  const entries = Object.entries(tasksByStatus).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((s, [, c]) => s + c, 0);

  if (entries.length === 0) return null;

  const statusColor = (status: string): string => {
    switch (status) {
      case "done":
        return "bg-green-500";
      case "failed":
        return "bg-red-500";
      case "running":
      case "dispatched":
        return "bg-blue-500";
      case "ready":
        return "bg-yellow-500";
      case "in_review":
      case "changes_requested":
        return "bg-purple-500";
      case "awaiting_ci":
      case "deploying":
        return "bg-cyan-500";
      default:
        return "bg-gray-600";
    }
  };

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        Tasks by Status
      </div>
      <div className="space-y-2">
        {entries.map(([status, count]) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={status} className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-28 capitalize truncate">
                {status.replace(/_/g, " ")}
              </span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${statusColor(status)}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 tabular-nums w-8 text-right">
                {count}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main MetricsPage
// ---------------------------------------------------------------------------

export default function MetricsPage() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMetrics()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) return <Skeleton lines={8} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* System health cards + event timeline */}
      <SystemMetrics />

      {/* Cost tracking */}
      <CostCards
        costLast24h={data.costLast24h}
        costLast7d={data.costLast7d}
        costPrev24h={data.costPrev24h}
      />

      {/* Daily stats chart */}
      <DailyStatsChart stats={data.dailyStats} />

      {/* Two-column layout for invocation stats and tasks by status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <InvocationStatsSection data={data.invocationStats} />
        <TasksByStatusSection tasksByStatus={data.tasksByStatus} />
      </div>

      {/* Recent errors */}
      <RecentErrorsList errors={data.recentErrors} />
    </div>
  );
}
