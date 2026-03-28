import { useState } from "react";
import type {
  MetricsData,
  SystemEvent,
  RecentError,
  DailyStatEntry,
} from "../hooks/useApi";
import { fetchMetrics, fetchStatus } from "../hooks/useApi";
import type { OrcaStatus } from "../types";
import Card from "./ui/Card";
import Skeleton from "./ui/Skeleton";
import { timeAgo, formatUptime, formatDateTime } from "../utils/time.js";
import { useFetchWithPolling } from "../hooks/useFetchWithPolling.js";
import { eventDotColor } from "../utils/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function trendPct(current: number, previous: number): number | null {
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

// ---------------------------------------------------------------------------
// Health Banner
// ---------------------------------------------------------------------------

type HealthLevel = "green" | "yellow" | "red";

function getHealthLevel(
  metrics: MetricsData,
  status: OrcaStatus | null,
): HealthLevel {
  if (metrics.uptime.seconds == null || metrics.uptime.seconds === 0)
    return "red";
  if (metrics.errors.lastHour > 0 || (status?.draining ?? false))
    return "yellow";
  return "green";
}

const healthStyles: Record<
  HealthLevel,
  { bg: string; border: string; text: string; label: string }
> = {
  green: {
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    text: "text-green-400",
    label: "Healthy",
  },
  yellow: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    text: "text-yellow-400",
    label: "Degraded",
  },
  red: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    text: "text-red-400",
    label: "Down",
  },
};

function HealthBanner({
  metrics,
  status,
}: {
  metrics: MetricsData;
  status: OrcaStatus | null;
}) {
  const level = getHealthLevel(metrics, status);
  const style = healthStyles[level];
  const { uptime } = metrics;

  return (
    <div
      className={`${style.bg} border ${style.border} rounded-lg px-4 py-2.5 flex items-center gap-4 flex-wrap`}
    >
      <span className={`text-sm font-semibold ${style.text}`}>
        {style.label}
      </span>
      <span className="text-xs text-gray-400">
        Uptime:{" "}
        <span className="tabular-nums text-gray-200">
          {uptime.seconds != null ? formatUptime(uptime.seconds) : "--"}
        </span>
      </span>
      {uptime.since && (
        <span className="text-xs text-gray-400">
          Since:{" "}
          <span className="tabular-nums text-gray-200">
            {formatDateTime(uptime.since)}
          </span>
        </span>
      )}
      <span className="text-xs text-gray-400">
        Sessions:{" "}
        <span className="tabular-nums text-gray-200">
          {status?.activeSessions ?? 0}
        </span>
      </span>
      {status?.draining && (
        <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
          Draining
          {status.drainingForSeconds != null &&
            ` — ${Math.round(status.drainingForSeconds / 60)}m`}{" "}
          ({status.drainSessionCount} sessions)
        </span>
      )}
      {uptime.restartsToday > 0 && (
        <span className="text-xs text-yellow-400 tabular-nums">
          {uptime.restartsToday} restart
          {uptime.restartsToday > 1 ? "s" : ""} today
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key Numbers Row
// ---------------------------------------------------------------------------

function KeyNumbers({ metrics }: { metrics: MetricsData }) {
  const successRate = metrics.successRate12h;
  const successColor =
    successRate == null
      ? "text-gray-500"
      : successRate > 80
        ? "text-green-400"
        : successRate > 50
          ? "text-yellow-400"
          : "text-red-400";

  const tokenTrend = trendPct(metrics.tokensLast24h, metrics.tokensPrev24h);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {/* Success Rate */}
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Success Rate
        </div>
        <span className={`text-xl font-semibold tabular-nums ${successColor}`}>
          {successRate != null ? `${Math.round(successRate)}%` : "--"}
        </span>
        <div className="text-xs text-gray-600 mt-1">12h window</div>
      </Card>

      {/* Tokens (24h) */}
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Tokens (24h)
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold tabular-nums text-gray-100">
            {formatCompactNumber(metrics.tokensLast24h)}
          </span>
          {tokenTrend !== null && (
            <span
              className={`text-xs tabular-nums ${tokenTrend > 0 ? "text-red-400" : tokenTrend < 0 ? "text-green-400" : "text-gray-500"}`}
            >
              {tokenTrend > 0 ? "\u2191" : "\u2193"}
              {Math.abs(tokenTrend)}%
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600 mt-1">
          vs prev: {formatCompactNumber(metrics.tokensPrev24h)}
        </div>
      </Card>

      {/* Queue */}
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Queue
        </div>
        <div className="text-sm font-medium tabular-nums text-gray-100">
          <span className="text-yellow-400">{metrics.queue.ready}</span>
          {" ready / "}
          <span className="text-blue-400">{metrics.queue.running}</span>
          {" running / "}
          <span className="text-purple-400">{metrics.queue.inReview}</span>
          {" review"}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily Activity Chart
// ---------------------------------------------------------------------------

function DailyActivityChart({ stats }: { stats: DailyStatEntry[] }) {
  if (stats.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          Daily Activity (14d)
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
        Daily Activity (14d)
      </div>
      <div className="flex items-end gap-1 h-36">
        {stats.map((day) => {
          const completedH =
            maxCount > 0 ? (day.completed / maxCount) * 100 : 0;
          const failedH = maxCount > 0 ? (day.failed / maxCount) * 100 : 0;
          const dateLabel = day.date.slice(5); // MM-DD
          return (
            <div
              key={day.date}
              className="flex-1 flex flex-col items-center"
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
              <div className="text-[9px] text-gray-500 tabular-nums mt-0.5">
                {formatDollars(day.costUsd)}
              </div>
              <div className="text-[10px] text-gray-600 tabular-nums truncate w-full text-center">
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
        <span className="text-xs text-gray-600">Cost shown below each bar</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// System Configuration
// ---------------------------------------------------------------------------

function SystemConfiguration({
  status,
  metrics,
}: {
  status: OrcaStatus | null;
  metrics: MetricsData;
}) {
  if (!status) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          System Configuration
        </div>
        <div className="py-4 text-center text-sm text-gray-500">
          Status unavailable
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        System Configuration
      </div>
      <div className="space-y-3">
        {/* Concurrency */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Concurrency</span>
          <span className="text-sm tabular-nums text-gray-200">
            {status.activeSessions} / {status.concurrencyCap} slots
          </span>
        </div>

        {/* Models */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Models</span>
          <div className="flex gap-2">
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
              model: {status.model}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
              review: {status.reviewModel}
            </span>
          </div>
        </div>

        {/* Token budget */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">
            Tokens in window ({metrics.budget.windowHours}h)
          </span>
          <span className="text-sm tabular-nums text-gray-200">
            {formatCompactNumber(status.tokensInWindow)}
            {status.tokenBudgetLimit > 0 && (
              <span className="text-gray-500">
                {" "}
                / {formatCompactNumber(status.tokenBudgetLimit)}
              </span>
            )}
          </span>
        </div>

        {/* Drain status */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Drain</span>
          <span
            className={`text-sm ${status.draining ? "text-yellow-400" : "text-gray-500"}`}
          >
            {status.draining
              ? `Active (${status.drainSessionCount} sessions)`
              : "Off"}
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Task Pipeline
// ---------------------------------------------------------------------------

const PIPELINE_ORDER = [
  "backlog",
  "ready",
  "running",
  "in_review",
  "changes_requested",
  "awaiting_ci",
  "deploying",
  "done",
  "failed",
] as const;

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  backlog: { bg: "bg-gray-600", text: "text-gray-400" },
  ready: { bg: "bg-yellow-500", text: "text-yellow-400" },
  running: { bg: "bg-blue-500", text: "text-blue-400" },
  in_review: { bg: "bg-purple-500", text: "text-purple-400" },
  changes_requested: { bg: "bg-purple-500", text: "text-purple-400" },
  awaiting_ci: { bg: "bg-cyan-500", text: "text-cyan-400" },
  deploying: { bg: "bg-cyan-500", text: "text-cyan-400" },
  done: { bg: "bg-green-500", text: "text-green-400" },
  failed: { bg: "bg-red-500", text: "text-red-400" },
};

function TaskPipeline({
  tasksByStatus,
}: {
  tasksByStatus: Record<string, number>;
}) {
  const entries = PIPELINE_ORDER.filter((s) => (tasksByStatus[s] ?? 0) > 0).map(
    (s) => ({ status: s, count: tasksByStatus[s] ?? 0 }),
  );
  const total = entries.reduce((s, e) => s + e.count, 0);

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        Task Pipeline
      </div>
      {total === 0 ? (
        <div className="py-4 text-center text-sm text-gray-500">No tasks</div>
      ) : (
        <>
          {/* Stacked bar */}
          <div className="flex h-5 rounded-full overflow-hidden bg-gray-800 mb-3">
            {entries.map((e) => {
              const pct = (e.count / total) * 100;
              const colors = STATUS_COLORS[e.status] ?? STATUS_COLORS.backlog;
              return (
                <div
                  key={e.status}
                  className={`${colors.bg} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${e.status.replace(/_/g, " ")}: ${e.count}`}
                />
              );
            })}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {entries.map((e) => {
              const colors = STATUS_COLORS[e.status] ?? STATUS_COLORS.backlog;
              return (
                <div key={e.status} className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${colors.bg}`}
                  />
                  <span className={`text-xs capitalize ${colors.text}`}>
                    {e.status.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-gray-500 tabular-nums">
                    {e.count}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent Errors
// ---------------------------------------------------------------------------

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
    <Card padding={false}>
      <div className="text-xs text-gray-500 mb-1 uppercase tracking-wide px-4 pt-4">
        Recent Errors
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="text-left font-medium px-4 py-2">Issue</th>
              <th className="text-left font-medium px-4 py-2">Phase</th>
              <th className="text-left font-medium px-4 py-2">Time</th>
              <th className="text-left font-medium px-4 py-2">Status</th>
              <th className="text-left font-medium px-4 py-2">Output</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((err) => (
              <tr
                key={err.id}
                className="border-b border-gray-800/50 bg-red-500/5 hover:bg-red-500/10 transition-colors"
              >
                <td className="px-4 py-2 font-mono tabular-nums text-gray-300 whitespace-nowrap">
                  {err.linearIssueId}
                </td>
                <td className="px-4 py-2 text-gray-400">{err.phase ?? "--"}</td>
                <td className="px-4 py-2 text-gray-500 tabular-nums whitespace-nowrap">
                  {timeAgo(err.startedAt)}
                </td>
                <td className="px-4 py-2">
                  <span className="text-red-400">{err.status}</span>
                </td>
                <td className="px-4 py-2 text-gray-500 max-w-xs truncate">
                  {err.outputSummary ?? "--"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// System Events Timeline
// ---------------------------------------------------------------------------

function SystemEventsTimeline({ events }: { events: SystemEvent[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const display = events.slice(0, 20);

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
        System Events
      </div>
      {display.length === 0 ? (
        <div className="py-4 text-center text-sm text-gray-500">
          No system events yet
        </div>
      ) : (
        <div className="divide-y divide-gray-800 max-h-80 overflow-y-auto">
          {display.map((event) => (
            <div
              key={event.id}
              className={`flex items-start gap-3 py-2 px-1 ${event.metadata ? "cursor-pointer hover:bg-gray-800/60" : ""} rounded transition-colors`}
              onClick={() =>
                event.metadata &&
                setExpandedId(expandedId === event.id ? null : event.id)
              }
            >
              <span
                className={`inline-block h-2 w-2 rounded-full shrink-0 mt-1.5 ${eventDotColor(event.type)}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                    {event.type}
                  </span>
                  <span className="text-sm text-gray-300 truncate">
                    {event.message}
                  </span>
                  <span className="flex-1" />
                  <span className="text-xs text-gray-600 tabular-nums whitespace-nowrap">
                    {timeAgo(event.createdAt)}
                  </span>
                </div>
                {expandedId === event.id && event.metadata && (
                  <pre className="mt-1 text-xs text-gray-500 bg-gray-800/50 rounded p-2 overflow-x-auto">
                    {JSON.stringify(event.metadata, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main MetricsPage
// ---------------------------------------------------------------------------

const fetchMetricsAndStatus = () =>
  Promise.all([fetchMetrics(), fetchStatus()]).then(
    ([m, s]) => ({ metrics: m, status: s }) as const,
  );

export default function MetricsPage() {
  const { data, loading, error } = useFetchWithPolling({
    fetcher: fetchMetricsAndStatus,
    intervalMs: 30_000,
  });

  if (loading) return <Skeleton lines={8} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { metrics, status } = data;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* 1. Health Banner */}
      <HealthBanner metrics={metrics} status={status} />

      {/* 2. Key Numbers Row */}
      <KeyNumbers metrics={metrics} />

      {/* 3. Daily Activity Chart */}
      <DailyActivityChart stats={metrics.dailyStats} />

      {/* 4. Two-column: System Config + Task Pipeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SystemConfiguration status={status} metrics={metrics} />
        <TaskPipeline tasksByStatus={metrics.tasksByStatus} />
      </div>

      {/* 5. Recent Errors */}
      <RecentErrorsList errors={metrics.recentErrors} />

      {/* 6. System Events Timeline */}
      <SystemEventsTimeline events={metrics.recentEvents ?? []} />
    </div>
  );
}
