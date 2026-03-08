import { useState, useEffect } from "react";
import { fetchDashboard } from "../hooks/useApi";
import type { DashboardData, DailyRunStat, DailyCostStat } from "../hooks/useApi";
import type { OrcaStatus } from "../types";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Skeleton from "./ui/Skeleton";
import ActiveSessionsGrid from "./ActiveSessionsGrid";
import ActivityFeed from "./ActivityFeed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trendIcon(current: number, previous: number): { icon: string; color: string } {
  if (previous === 0 && current === 0) return { icon: "—", color: "text-gray-500" };
  if (previous === 0) return { icon: "↑", color: "text-green-400" };
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 1) return { icon: "→", color: "text-gray-400" };
  if (pct > 0) return { icon: `↑${Math.abs(pct).toFixed(0)}%`, color: "text-green-400" };
  return { icon: `↓${Math.abs(pct).toFixed(0)}%`, color: "text-red-400" };
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard({
  label, value, sub, trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: { icon: string; color: string };
}) {
  return (
    <Card>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="flex items-end gap-2">
        <div className="text-2xl font-mono font-semibold text-gray-100">{value}</div>
        {trend && (
          <span className={`text-xs font-mono mb-0.5 ${trend.color}`}>{trend.icon}</span>
        )}
      </div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bar chart (14-day runs: succeeded/failed stacked)
// ---------------------------------------------------------------------------

function fillDays(data: DailyRunStat[], days: number): DailyRunStat[] {
  const result: DailyRunStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const found = data.find((r) => r.date === dateStr);
    result.push(found ?? { date: dateStr, succeeded: 0, failed: 0 });
  }
  return result;
}

function fillCostDays(data: DailyCostStat[], days: number): DailyCostStat[] {
  const result: DailyCostStat[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const found = data.find((r) => r.date === dateStr);
    result.push(found ?? { date: dateStr, costUsd: 0 });
  }
  return result;
}

function RunBarChart({ data }: { data: DailyRunStat[] }) {
  const days = fillDays(data, 14);
  const maxVal = Math.max(...days.map((d) => d.succeeded + d.failed), 1);

  const WIDTH = 100;
  const HEIGHT = 60;
  const barW = WIDTH / days.length;
  const pad = 1;

  const labelDay = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00Z");
    return d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1);
  };

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height: 80 }}
      >
        {days.map((day, i) => {
          const total = day.succeeded + day.failed;
          const totalH = (total / maxVal) * (HEIGHT - 4);
          const succH = total > 0 ? (day.succeeded / total) * totalH : 0;
          const failH = totalH - succH;
          const x = i * barW + pad / 2;
          const w = barW - pad;

          return (
            <g key={day.date}>
              {/* failed (bottom) */}
              {failH > 0 && (
                <rect
                  x={x}
                  y={HEIGHT - totalH}
                  width={w}
                  height={failH}
                  fill="#ef4444"
                  opacity={0.7}
                />
              )}
              {/* succeeded (top of stack) */}
              {succH > 0 && (
                <rect
                  x={x}
                  y={HEIGHT - succH}
                  width={w}
                  height={succH}
                  fill="#22c55e"
                  opacity={0.7}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* X-axis labels */}
      <div className="flex justify-between mt-1">
        {days.map((day, i) => (
          <span
            key={i}
            className="text-gray-600 text-center flex-1"
            style={{ fontSize: 9 }}
          >
            {labelDay(day.date)}
          </span>
        ))}
      </div>
      {/* Legend */}
      <div className="flex gap-3 mt-2">
        <span className="flex items-center gap-1 text-xs text-gray-400">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 opacity-70" /> succeeded
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-400">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500 opacity-70" /> failed
        </span>
      </div>
    </div>
  );
}

function CostLineChart({ data }: { data: DailyCostStat[] }) {
  const days = fillCostDays(data, 14);
  const maxVal = Math.max(...days.map((d) => d.costUsd), 0.0001);

  const WIDTH = 100;
  const HEIGHT = 60;
  const stepX = WIDTH / (days.length - 1);

  const pts = days.map((d, i) => ({
    x: i * stepX,
    y: HEIGHT - (d.costUsd / maxVal) * (HEIGHT - 4) - 2,
    cost: d.costUsd,
  }));

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");

  // area fill: close path along bottom
  const area =
    `${pts[0]!.x},${HEIGHT} ` +
    pts.map((p) => `${p.x},${p.y}`).join(" ") +
    ` ${pts[pts.length - 1]!.x},${HEIGHT}`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height: 80 }}
      >
        <defs>
          <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* area */}
        <polygon points={area} fill="url(#costGrad)" />
        {/* line */}
        <polyline
          points={polyline}
          fill="none"
          stroke="#06b6d4"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* dots at non-zero values */}
        {pts.map((p, i) =>
          days[i]!.costUsd > 0 ? (
            <circle key={i} cx={p.x} cy={p.y} r="1.5" fill="#06b6d4" vectorEffect="non-scaling-stroke" />
          ) : null
        )}
      </svg>
      <div className="flex justify-between mt-1">
        {days.map((day, i) => (
          <span
            key={i}
            className="text-gray-600 text-center flex-1"
            style={{ fontSize: 9 }}
          >
            {new Date(day.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard component
// ---------------------------------------------------------------------------

interface Props {
  status: OrcaStatus | null;
}

export default function Dashboard({ status }: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchDashboard()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const activeSessions = status?.activeSessions ?? data?.activeSessions ?? 0;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Dashboard</h2>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded p-3">{error}</div>
      )}

      {/* Metric cards */}
      {loading && !data ? (
        <Skeleton lines={4} />
      ) : data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Total Cost"
            value={`$${data.totalCostUsd.toFixed(2)}`}
            sub="all time"
            trend={trendIcon(data.cost14d, data.prevCost14d)}
          />
          <MetricCard
            label="Active Sessions"
            value={String(activeSessions)}
            sub={status ? `${status.queuedTasks} queued` : undefined}
          />
          <MetricCard
            label="Success Rate"
            value={data.successRate != null ? `${data.successRate.toFixed(1)}%` : "—"}
            sub="all time"
          />
          <MetricCard
            label="24h Cost"
            value={`$${data.cost24h.toFixed(2)}`}
            sub="last 24 hours"
            trend={trendIcon(data.cost24h, data.prevCost24h)}
          />
        </div>
      ) : null}

      {/* Active sessions */}
      <ActiveSessionsGrid />

      {/* Charts */}
      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <div className="text-xs text-gray-500 mb-3">Run Activity (14 days)</div>
            <RunBarChart data={data.dailyRuns} />
          </Card>
          <Card>
            <div className="text-xs text-gray-500 mb-3">Cost Trend (14 days)</div>
            <CostLineChart data={data.dailyCosts} />
          </Card>
        </div>
      )}

      {/* Activity feed */}
      {data && (
        <Card>
          <div className="text-xs text-gray-500 mb-3">Recent Activity</div>
          <ActivityFeed items={data.recentActivity} />
        </Card>
      )}
    </div>
  );
}
