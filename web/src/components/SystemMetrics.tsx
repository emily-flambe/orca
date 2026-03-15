import { useState, useEffect, useCallback } from "react";
import type { MetricsData, SystemEvent } from "../hooks/useApi";
import { fetchMetrics } from "../hooks/useApi";
import Card from "./ui/Card";

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
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

function eventDotColor(type: string): string {
  switch (type) {
    case "startup":
    case "task_completed":
      return "bg-green-400";
    case "error":
    case "task_failed":
      return "bg-red-400";
    case "deploy":
      return "bg-blue-400";
    case "shutdown":
    case "health_check":
      return "bg-gray-500";
    case "restart":
      return "bg-yellow-400";
    default:
      return "bg-gray-500";
  }
}

interface StatCardProps {
  label: string;
  value: string;
  color?: string;
  badge?: string;
  sub?: string;
}

function StatCard({
  label,
  value,
  color = "text-gray-100",
  badge,
  sub,
}: StatCardProps) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-xl font-semibold tabular-nums ${color}`}>
          {value}
        </span>
        {badge && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
            {badge}
          </span>
        )}
      </div>
      {sub && <div className="text-xs text-gray-600 mt-1">{sub}</div>}
    </Card>
  );
}

function EventTimeline({ events }: { events: SystemEvent[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (events.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-gray-500">
        No system events yet
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-800">
      {events.slice(0, 20).map((event) => (
        <div
          key={event.id}
          className={`flex items-start gap-3 py-2.5 px-1 ${event.metadata ? "cursor-pointer hover:bg-gray-800/60" : ""} rounded transition-colors`}
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
  );
}

export default function SystemMetrics() {
  const [data, setData] = useState<MetricsData | null>(null);

  const load = useCallback(() => {
    fetchMetrics()
      .then(setData)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (!data) return null;

  const { uptime, throughput, errors, budget, recentEvents } = data;

  const uptimeColor =
    uptime.seconds != null ? "text-green-400" : "text-red-400";
  const uptimeValue =
    uptime.seconds != null ? formatUptime(uptime.seconds) : "Down";

  const tp24 = throughput.last24h;
  const throughputColor =
    tp24.failed === 0
      ? "text-green-400"
      : tp24.failed > tp24.completed
        ? "text-red-400"
        : "text-yellow-400";

  const errorColor =
    errors.last24h === 0
      ? "text-green-400"
      : errors.last24h <= 5
        ? "text-yellow-400"
        : "text-red-400";

  const budgetPct =
    budget.limit > 0 ? (budget.costInWindow / budget.limit) * 100 : 0;
  const budgetColor =
    budgetPct < 50
      ? "text-green-400"
      : budgetPct < 80
        ? "text-yellow-400"
        : "text-red-400";
  const budgetBarColor =
    budgetPct < 50
      ? "bg-green-500"
      : budgetPct < 80
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard
          label="Uptime"
          value={uptimeValue}
          color={uptimeColor}
          badge={
            uptime.restartsToday > 0
              ? `${uptime.restartsToday} restart${uptime.restartsToday > 1 ? "s" : ""}`
              : undefined
          }
        />
        <StatCard
          label="Throughput (24h)"
          value={`${tp24.completed} / ${tp24.failed}`}
          color={throughputColor}
          sub="completed / failed"
        />
        <StatCard
          label="Errors (24h)"
          value={String(errors.last24h)}
          color={errorColor}
          sub={
            errors.lastHour > 0 ? `${errors.lastHour} in last hour` : undefined
          }
        />
        <StatCard
          label="Restarts (24h)"
          value={String(uptime.restartsToday)}
          color={
            uptime.restartsToday === 0 ? "text-green-400" : "text-yellow-400"
          }
        />
        <div>
          <Card>
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
              Budget ({budget.windowHours}h)
            </div>
            <div
              className={`text-xl font-semibold tabular-nums ${budgetColor}`}
            >
              ${budget.costInWindow.toFixed(2)}
              <span className="text-sm text-gray-500 font-normal">
                {" "}
                / ${budget.limit.toFixed(2)}
              </span>
            </div>
            <div className="mt-2 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${budgetBarColor}`}
                style={{ width: `${Math.min(budgetPct, 100)}%` }}
              />
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <div className="text-xs text-gray-500 mb-3 uppercase tracking-wide">
          System Events
        </div>
        <EventTimeline events={recentEvents ?? []} />
      </Card>
    </div>
  );
}
