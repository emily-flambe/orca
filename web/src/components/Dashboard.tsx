import { useState, useEffect, useCallback } from "react";
import { fetchDashboard } from "../hooks/useApi";
import type { DashboardData, DailyActivityPoint, ActivityEvent } from "../hooks/useApi";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Skeleton from "./ui/Skeleton";
import ActiveSessionsGrid from "./ActiveSessionsGrid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCost(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}

function trendArrow(current: number | null, previous: number | null): { symbol: string; color: string } | null {
  if (current == null || previous == null) return null;
  if (previous === 0 && current === 0) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 0.001) return { symbol: "→", color: "text-gray-400" };
  if (diff > 0) return { symbol: "↑", color: "text-green-400" };
  return { symbol: "↓", color: "text-red-400" };
}

function costTrend(current: number, previous: number): { symbol: string; color: string } | null {
  // For cost, up is bad
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return { symbol: "↑", color: "text-red-400" };
  const diff = current - previous;
  if (Math.abs(diff / previous) < 0.01) return { symbol: "→", color: "text-gray-400" };
  if (diff > 0) return { symbol: "↑", color: "text-red-400" };
  return { symbol: "↓", color: "text-green-400" };
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

function statusColor(s: string): string {
  switch (s) {
    case "completed": return "text-green-400";
    case "running": return "text-blue-400";
    case "failed": return "text-red-400";
    case "timed_out": return "text-orange-400";
    default: return "text-gray-400";
  }
}

// ---------------------------------------------------------------------------
// MetricCard
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: { symbol: string; color: string } | null;
}) {
  return (
    <Card>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="text-2xl font-mono font-semibold text-gray-100">{value}</div>
        {trend && (
          <span className={`text-sm font-semibold ${trend.color}`}>{trend.symbol}</span>
        )}
      </div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BarChart (SVG stacked bar for 14-day activity)
// ---------------------------------------------------------------------------

function RunActivityChart({ data }: { data: DailyActivityPoint[] }) {
  if (data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => d.completed + d.failed), 1);
  const width = 100; // percentage-based via viewBox
  const height = 60;
  const barW = (width / data.length) * 0.7;
  const gap = (width / data.length) * 0.3;

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">14-day Run Activity</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-20"
        preserveAspectRatio="none"
      >
        {data.map((d, i) => {
          const x = i * (barW + gap);
          const completedH = (d.completed / maxVal) * (height - 4);
          const failedH = (d.failed / maxVal) * (height - 4);
          const totalH = completedH + failedH;
          return (
            <g key={d.date}>
              {/* completed (bottom) */}
              {d.completed > 0 && (
                <rect
                  x={x}
                  y={height - completedH}
                  width={barW}
                  height={completedH}
                  fill="#22c55e"
                  opacity={0.8}
                />
              )}
              {/* failed (on top) */}
              {d.failed > 0 && (
                <rect
                  x={x}
                  y={height - totalH}
                  width={barW}
                  height={failedH}
                  fill="#ef4444"
                  opacity={0.8}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-xs text-gray-600 mt-1">
        <span>{data[0]?.date?.slice(5)}</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-green-500 rounded-sm opacity-80" />
            <span>completed</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-red-500 rounded-sm opacity-80" />
            <span>failed/timeout</span>
          </span>
        </span>
        <span>{data[data.length - 1]?.date?.slice(5)}</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CostChart (SVG line chart for 14-day cost)
// ---------------------------------------------------------------------------

function CostTrendChart({ data }: { data: DailyActivityPoint[] }) {
  if (data.length === 0) return null;

  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.001);
  const width = 100;
  const height = 60;
  const padY = 4;
  const segCount = Math.max(data.length - 1, 1);

  const points = data.map((d, i) => {
    const x = (i / segCount) * width;
    const y = height - padY - (d.costUsd / maxCost) * (height - padY * 2);
    return `${x},${y}`;
  });

  const polyline = points.join(" ");
  const areaPoints = [
    `0,${height}`,
    ...points,
    `${width},${height}`,
  ].join(" ");

  const hasAnyData = data.some((d) => d.costUsd > 0);

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">14-day Cost Trend</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-20"
        preserveAspectRatio="none"
      >
        {hasAnyData ? (
          <>
            <polygon
              points={areaPoints}
              fill="#6366f1"
              opacity={0.1}
            />
            <polyline
              points={polyline}
              fill="none"
              stroke="#6366f1"
              strokeWidth="1"
              opacity={0.9}
            />
          </>
        ) : (
          <text
            x="50"
            y="35"
            textAnchor="middle"
            fill="#374151"
            fontSize="6"
          >
            No cost data yet
          </text>
        )}
      </svg>
      <div className="flex justify-between text-xs text-gray-600 mt-1">
        <span>{data[0]?.date?.slice(5)}</span>
        <span className="text-gray-500">
          {hasAnyData ? `$0 – ${formatCost(maxCost)}` : ""}
        </span>
        <span>{data[data.length - 1]?.date?.slice(5)}</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------

function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-2">Recent Activity</div>
        <div className="py-8 text-center text-sm text-gray-500">No activity yet</div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">Recent Activity</div>
      <div className="space-y-2">
        {events.map((event) => (
          <div key={event.id} className="flex items-start gap-3 py-1.5 border-b border-gray-800/60 last:border-0">
            {/* Status dot */}
            <div className="mt-0.5 flex-shrink-0">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  event.status === "completed"
                    ? "bg-green-500"
                    : event.status === "failed"
                    ? "bg-red-500"
                    : "bg-orange-500"
                }`}
              />
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-gray-200 font-semibold">
                  {event.linearIssueId}
                </span>
                {event.phase && (
                  <span className="text-xs px-1 py-0.5 rounded bg-gray-800 text-gray-400">
                    {event.phase}
                  </span>
                )}
                <span className={`text-xs ${statusColor(event.status)}`}>
                  {event.status}
                </span>
                {event.costUsd != null && event.costUsd > 0 && (
                  <span className="text-xs text-gray-500 font-mono">
                    ${event.costUsd.toFixed(2)}
                  </span>
                )}
              </div>
              {event.outputSummary && (
                <div className="text-xs text-gray-500 truncate mt-0.5">
                  {event.outputSummary}
                </div>
              )}
            </div>
            {/* Time */}
            {event.endedAt && (
              <div className="text-xs text-gray-600 whitespace-nowrap flex-shrink-0">
                {timeAgo(event.endedAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard (main)
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchDashboard()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // Refresh dashboard data every 30 seconds
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !data) {
    return <Skeleton lines={6} className="m-6" />;
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="text-sm text-red-400 mb-3">Error loading dashboard: {error}</div>
        <Button variant="secondary" size="sm" onClick={load}>Retry</Button>
      </div>
    );
  }

  if (!data) return null;

  const successRateTrend = trendArrow(data.successRateLast7d, data.successRatePrev7d);
  const cost24hTrend = costTrend(data.costLast24h, data.costPrev24h);
  const totalCostTrend = costTrend(data.costLast7d, data.costPrev7d);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Dashboard</h2>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard
          label="Total Cost"
          value={data.invocationStats.totalCostUsd != null ? formatCost(data.invocationStats.totalCostUsd) : "—"}
          sub="all time"
          trend={totalCostTrend}
        />
        <MetricCard
          label="Active Sessions"
          value={String(data.activeSessions)}
          sub="running now"
        />
        <MetricCard
          label="Success Rate"
          value={data.successRateLast7d != null ? `${(data.successRateLast7d * 100).toFixed(0)}%` : "—"}
          sub="last 7 days"
          trend={successRateTrend}
        />
        <MetricCard
          label="24h Cost"
          value={formatCost(data.costLast24h)}
          sub="vs prior 24h"
          trend={cost24hTrend}
        />
      </div>

      {/* Active sessions */}
      <ActiveSessionsGrid />

      {/* Charts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <RunActivityChart data={data.dailyActivity} />
        <CostTrendChart data={data.dailyActivity} />
      </div>

      {/* Activity feed */}
      <ActivityFeed events={data.recentActivity} />
    </div>
  );
}
