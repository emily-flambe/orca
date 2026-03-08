import { useState, useEffect } from "react";
import { fetchMetrics } from "../hooks/useApi";
import type { MetricsData, RecentError } from "../hooks/useApi";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Skeleton from "./ui/Skeleton";
import EmptyState from "./ui/EmptyState";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusColor(s: string): string {
  switch (s) {
    case "done":
    case "completed":
      return "text-green-400";
    case "running":
    case "dispatched":
      return "text-blue-400";
    case "ready":
      return "text-cyan-400";
    case "failed":
    case "timed_out":
      return "text-red-400";
    case "in_review":
    case "changes_requested":
      return "text-yellow-400";
    default:
      return "text-gray-400";
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-mono font-semibold text-gray-100">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </Card>
  );
}

function TaskStatusGrid({ byStatus }: { byStatus: Record<string, number> }) {
  const STATUS_ORDER = [
    "running", "dispatched", "in_review", "changes_requested",
    "ready", "awaiting_ci", "deploying",
    "done", "failed", "backlog",
  ];

  const entries = STATUS_ORDER
    .filter((s) => byStatus[s] != null && byStatus[s]! > 0)
    .map((s) => ({ status: s, count: byStatus[s]! }));

  // Add any unknown statuses
  for (const [s, c] of Object.entries(byStatus)) {
    if (!STATUS_ORDER.includes(s) && c > 0) {
      entries.push({ status: s, count: c });
    }
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">Tasks by Status</div>
      <div className="flex flex-wrap gap-2">
        {entries.map(({ status, count }) => (
          <div key={status} className="flex items-center gap-1.5 bg-gray-800 rounded px-2 py-1">
            <span className={`text-sm font-mono font-semibold ${statusColor(status)}`}>{count}</span>
            <span className="text-xs text-gray-400">{status}</span>
          </div>
        ))}
        {entries.length === 0 && (
          <EmptyState message="No tasks" />
        )}
      </div>
    </Card>
  );
}

function InvocationStatusRow({ byStatus }: { byStatus: { status: string; count: number }[] }) {
  const total = byStatus.reduce((s, r) => s + r.count, 0);
  const completed = byStatus.find((r) => r.status === "completed")?.count ?? 0;
  const failed = byStatus.find((r) => r.status === "failed")?.count ?? 0;
  const timedOut = byStatus.find((r) => r.status === "timed_out")?.count ?? 0;
  const running = byStatus.find((r) => r.status === "running")?.count ?? 0;

  const successRate = total > 0 && running < total
    ? ((completed / (total - running)) * 100).toFixed(1)
    : null;

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">Invocations ({total} total)</div>
      <div className="flex gap-4 flex-wrap">
        <div className="text-center">
          <div className="text-xl font-mono font-semibold text-green-400">{completed}</div>
          <div className="text-xs text-gray-500">completed</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-mono font-semibold text-red-400">{failed}</div>
          <div className="text-xs text-gray-500">failed</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-mono font-semibold text-orange-400">{timedOut}</div>
          <div className="text-xs text-gray-500">timed out</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-mono font-semibold text-blue-400">{running}</div>
          <div className="text-xs text-gray-500">running</div>
        </div>
        {successRate != null && (
          <div className="text-center ml-auto">
            <div className="text-xl font-mono font-semibold text-gray-100">{successRate}%</div>
            <div className="text-xs text-gray-500">success rate</div>
          </div>
        )}
      </div>
    </Card>
  );
}

function RecentErrors({ errors }: { errors: RecentError[] }) {
  if (errors.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 mb-2">Recent Errors</div>
        <EmptyState message="No recent errors" />
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 mb-3">Recent Errors (last {errors.length})</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Task</th>
              <th className="pb-2 pr-4">Phase</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">When</th>
              <th className="pb-2">Summary</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={e.id} className="border-b border-gray-800/50">
                <td className="py-1.5 pr-4 font-mono text-xs text-gray-300">{e.linearIssueId}</td>
                <td className="py-1.5 pr-4 text-xs text-gray-400">{e.phase ?? "—"}</td>
                <td className={`py-1.5 pr-4 text-xs ${statusColor(e.status)}`}>{e.status}</td>
                <td className="py-1.5 pr-4 text-xs text-gray-400 whitespace-nowrap">{formatDate(e.startedAt)}</td>
                <td className="py-1.5 text-xs text-gray-400 truncate max-w-xs">{e.outputSummary ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Metrics() {
  const [data, setData] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchMetrics()
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

  if (loading) {
    return <Skeleton lines={4} className="m-6" />;
  }

  if (error) {
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  }

  if (!data) return null;

  const { invocationStats } = data;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">Metrics</h2>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total Cost (all time)"
          value={invocationStats.totalCostUsd != null ? `$${invocationStats.totalCostUsd.toFixed(2)}` : "—"}
        />
        <StatCard
          label="Cost (last 24h)"
          value={`$${data.costLast24h.toFixed(2)}`}
        />
        <StatCard
          label="Cost (last 7d)"
          value={`$${data.costLast7d.toFixed(2)}`}
        />
        <StatCard
          label="Avg Cost / Invocation"
          value={invocationStats.avgCostUsd != null ? `$${invocationStats.avgCostUsd.toFixed(2)}` : "—"}
          sub="completed only"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label="Avg Session Duration"
          value={formatDuration(invocationStats.avgDurationSecs)}
          sub="completed invocations"
        />
      </div>

      {/* Task status grid */}
      <TaskStatusGrid byStatus={data.tasksByStatus} />

      {/* Invocation summary */}
      <InvocationStatusRow byStatus={invocationStats.byStatus} />

      {/* Recent errors */}
      <RecentErrors errors={data.recentErrors} />
    </div>
  );
}
