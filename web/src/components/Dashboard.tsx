import { useState, useEffect, useCallback } from "react";
import { fetchMetrics } from "../hooks/useApi";
import type { MetricsData, DailyStatEntry } from "../hooks/useApi";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Skeleton from "./ui/Skeleton";
import ActiveSessionsGrid from "./ActiveSessionsGrid";
import ActivityFeed from "./ActivityFeed";

// ---------------------------------------------------------------------------
// Bar chart (stacked: completed green + failed red)
// ---------------------------------------------------------------------------
function BarChart({ data }: { data: DailyStatEntry[] }) {
  const width = 420;
  const height = 100;
  const padLeft = 24;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 20;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(...data.map((d) => d.completed + d.failed), 1);
  const barW = (chartW / data.length) * 0.75;
  const gap = chartW / data.length;

  // Y axis ticks
  const yTicks = [0, Math.ceil(maxVal / 2), maxVal];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
      {/* Y axis ticks */}
      {yTicks.map((t) => {
        const y = padTop + chartH - (t / maxVal) * chartH;
        return (
          <g key={t}>
            <line
              x1={padLeft}
              y1={y}
              x2={padLeft + chartW}
              y2={y}
              stroke="#374151"
              strokeWidth="0.5"
              strokeDasharray="3,3"
            />
            <text
              x={padLeft - 3}
              y={y + 3}
              textAnchor="end"
              fill="#6b7280"
              fontSize="8"
            >
              {t}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const x = padLeft + i * gap + (gap - barW) / 2;
        const completedH = maxVal > 0 ? (d.completed / maxVal) * chartH : 0;
        const failedH = maxVal > 0 ? (d.failed / maxVal) * chartH : 0;
        const totalH = completedH + failedH;
        const baseY = padTop + chartH;

        return (
          <g key={d.date}>
            {/* failed (bottom) */}
            {failedH > 0 && (
              <rect
                x={x}
                y={baseY - failedH}
                width={barW}
                height={failedH}
                fill="#ef4444"
                opacity="0.8"
                rx="1"
              />
            )}
            {/* completed (top) */}
            {completedH > 0 && (
              <rect
                x={x}
                y={baseY - totalH}
                width={barW}
                height={completedH}
                fill="#22c55e"
                opacity="0.8"
                rx="1"
              />
            )}
          </g>
        );
      })}

      {/* X axis labels — every 7th day */}
      {[0, Math.floor(data.length / 2), data.length - 1].map((idx) => {
        const d = data[idx];
        if (!d) return null;
        const x = padLeft + idx * gap + gap / 2;
        return (
          <text
            key={d.date}
            x={x}
            y={height - 4}
            textAnchor="middle"
            fill="#6b7280"
            fontSize="7"
          >
            {d.date.slice(5)}
          </text>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Line chart (cost over time)
// ---------------------------------------------------------------------------
function LineChart({ data }: { data: DailyStatEntry[] }) {
  const width = 420;
  const height = 100;
  const padLeft = 36;
  const padRight = 8;
  const padTop = 8;
  const padBottom = 20;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.001);

  const points = data.map((d, i) => {
    const x = padLeft + (i / (data.length - 1)) * chartW;
    const y = padTop + chartH - (d.costUsd / maxCost) * chartH;
    return { x, y, d };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  // Area fill path
  const areaD =
    pathD +
    ` L ${points[points.length - 1]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)}` +
    ` L ${points[0]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`;

  // Y axis ticks
  const yTicks = [0, maxCost / 2, maxCost];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
      <defs>
        <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Y ticks */}
      {yTicks.map((t, i) => {
        const y = padTop + chartH - (t / maxCost) * chartH;
        const label =
          t >= 1 ? `$${t.toFixed(0)}` : t > 0 ? `$${t.toFixed(2)}` : "$0";
        return (
          <g key={i}>
            <line
              x1={padLeft}
              y1={y}
              x2={padLeft + chartW}
              y2={y}
              stroke="#374151"
              strokeWidth="0.5"
              strokeDasharray="3,3"
            />
            <text
              x={padLeft - 3}
              y={y + 3}
              textAnchor="end"
              fill="#6b7280"
              fontSize="8"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* Area */}
      <path d={areaD} fill="url(#costGrad)" />

      {/* Line */}
      <path
        d={pathD}
        fill="none"
        stroke="#38bdf8"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* X labels */}
      {[0, Math.floor(data.length / 2), data.length - 1].map((idx) => {
        const p = points[idx];
        if (!p) return null;
        return (
          <text
            key={idx}
            x={p.x}
            y={height - 4}
            textAnchor="middle"
            fill="#6b7280"
            fontSize="7"
          >
            {p.d.date.slice(5)}
          </text>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------
interface DashboardProps {
  onNavigateToInvocation?: (
    linearIssueId: string,
    invocationId: number,
  ) => void;
}

export default function Dashboard({ onNavigateToInvocation }: DashboardProps) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
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
  }, [load]);

  if (loading) return <Skeleton lines={6} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { dailyStats, recentActivity } = data;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Dashboard
        </h2>
        <Button variant="secondary" size="sm" onClick={load}>
          Refresh
        </Button>
      </div>

      {/* Active sessions */}
      <ActiveSessionsGrid />

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
            14-day Run Activity
            <span className="ml-2 text-gray-600 normal-case">
              <span className="text-green-400">&#9632;</span> completed &nbsp;
              <span className="text-red-400">&#9632;</span> failed
            </span>
          </div>
          <div className="h-24">
            <BarChart data={dailyStats} />
          </div>
        </Card>
        <Card>
          <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
            14-day Cost Trend
          </div>
          <div className="h-24">
            <LineChart data={dailyStats} />
          </div>
        </Card>
      </div>

      {/* Activity feed */}
      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          Recent Activity
        </div>
        <ActivityFeed
          entries={recentActivity}
          onNavigate={onNavigateToInvocation}
        />
      </Card>
    </div>
  );
}
