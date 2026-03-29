import { useCallback } from "react";
import { useFetchWithPolling } from "../hooks/useFetchWithPolling.js";
import Skeleton from "./ui/Skeleton.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthData {
  status: "healthy" | "degraded" | "draining";
  uptime: number | null;
  draining: boolean;
  drainingForSeconds: number | null;
  activeSessions: number;
  drainingForSeconds?: number | null;
  checks: {
    db: "ok" | "error";
    inngest: "ok" | "unreachable";
  };
}

interface DiskInfo {
  available: string;
  used: string;
  total: string;
  usedPercent: number;
}

interface ProcessInfo {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number | null;
}

interface SystemData {
  cpu: {
    loadAvg: number[];
    count: number;
    model: string;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  };
  disk: DiskInfo | null;
  pm2: ProcessInfo[] | null;
  platform: string;
  arch: string;
  nodeVersion: string;
  hostname: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "0m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function percentColor(pct: number): string {
  if (!Number.isFinite(pct) || pct < 70) return "text-green-400";
  if (pct < 85) return "text-yellow-400";
  return "text-red-400";
}

function pm2StatusColor(status: string): string {
  if (status === "online") return "text-green-400";
  if (status === "stopped") return "text-gray-400";
  return "text-red-400";
}

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

const statusStyles = {
  healthy: {
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    text: "text-green-400",
    label: "Healthy",
  },
  draining: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    text: "text-yellow-400",
    label: "Draining",
  },
  degraded: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    text: "text-red-400",
    label: "Degraded",
  },
};

// ---------------------------------------------------------------------------
// Combined fetcher
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const fetchHealthAndSystem = () =>
  Promise.all([
    fetchJson<HealthData>("/api/health"),
    fetchJson<SystemData>("/api/health/system"),
  ]).then(([health, system]) => ({ health, system }) as const);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HealthPage() {
  const fetcher = useCallback(fetchHealthAndSystem, []);

  const { data, loading, error } = useFetchWithPolling<{
    health: HealthData;
    system: SystemData;
  }>({
    fetcher,
    intervalMs: 10_000,
  });

  if (loading) return <Skeleton lines={10} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const { health, system } = data;
  const statusStyle = statusStyles[health.status] ?? statusStyles.degraded;
  const loadAvgAvailable = system.platform !== "win32";

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Overall status banner */}
      <div
        className={`${statusStyle.bg} border ${statusStyle.border} rounded-lg p-4 flex items-center gap-4`}
      >
        <span className={`text-2xl font-bold ${statusStyle.text}`}>
          {statusStyle.label}
          {health.status === "draining" &&
            health.drainingForSeconds != null && (
              <span className="text-lg font-normal ml-2">
                ({Math.round(health.drainingForSeconds / 60)}m)
              </span>
            )}
        </span>
        {health.uptime != null && (
          <span className="text-sm text-gray-400">
            Uptime:{" "}
            <span className="text-gray-200">{formatUptime(health.uptime)}</span>
          </span>
        )}
        <span className="text-sm text-gray-400">
          Active sessions:{" "}
          <span className="text-gray-200">{health.activeSessions}</span>
        </span>
        {health.draining && health.drainingForSeconds != null && (
          <span className="text-sm text-yellow-400">
            Draining for{" "}
            <span className="font-medium">
              {formatUptime(health.drainingForSeconds)}
            </span>
          </span>
        )}
      </div>

      {/* Checks: DB + Inngest */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Service Checks
        </div>
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Database</span>
            <span
              className={`text-sm font-medium ${health.checks.db === "ok" ? "text-green-400" : "text-red-400"}`}
            >
              {health.checks.db === "ok" ? "OK" : "Error"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Inngest</span>
            <span
              className={`text-sm font-medium ${health.checks.inngest === "ok" ? "text-green-400" : "text-yellow-400"}`}
            >
              {health.checks.inngest === "ok" ? "OK" : "Unreachable"}
            </span>
          </div>
        </div>
      </div>

      {/* CPU */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          CPU
        </div>
        <div className="text-xs text-gray-500 mb-2 truncate">
          {system.cpu.model}
        </div>
        <div className="flex gap-6">
          <div>
            <div className="text-xs text-gray-500">Cores</div>
            <div className="text-sm text-gray-200 tabular-nums">
              {system.cpu.count}
            </div>
          </div>
          {loadAvgAvailable ? (
            (["1m", "5m", "15m"] as const).map((label, i) => (
              <div key={label}>
                <div className="text-xs text-gray-500">Load {label}</div>
                <div className="text-sm text-gray-200 tabular-nums">
                  {(system.cpu.loadAvg[i] ?? 0).toFixed(2)}
                </div>
              </div>
            ))
          ) : (
            <div>
              <div className="text-xs text-gray-500">Load avg</div>
              <div className="text-sm text-gray-500">N/A on Windows</div>
            </div>
          )}
        </div>
      </div>

      {/* Memory */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Memory
        </div>
        <div className="flex items-center gap-4 mb-3">
          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                system.memory.usedPercent < 70
                  ? "bg-green-500"
                  : system.memory.usedPercent < 85
                    ? "bg-yellow-500"
                    : "bg-red-500"
              }`}
              style={{ width: `${system.memory.usedPercent}%` }}
            />
          </div>
          <span
            className={`text-sm font-medium tabular-nums ${percentColor(system.memory.usedPercent)}`}
          >
            {system.memory.usedPercent}%
          </span>
        </div>
        <div className="flex gap-6 text-xs text-gray-400">
          <span>
            Used:{" "}
            <span className="text-gray-200">
              {formatBytes(system.memory.usedBytes)}
            </span>
          </span>
          <span>
            Free:{" "}
            <span className="text-gray-200">
              {formatBytes(system.memory.freeBytes)}
            </span>
          </span>
          <span>
            Total:{" "}
            <span className="text-gray-200">
              {formatBytes(system.memory.totalBytes)}
            </span>
          </span>
        </div>
      </div>

      {/* Disk */}
      {system.disk && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
            Disk
          </div>
          <div className="flex items-center gap-4 mb-3">
            <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  system.disk.usedPercent < 70
                    ? "bg-green-500"
                    : system.disk.usedPercent < 85
                      ? "bg-yellow-500"
                      : "bg-red-500"
                }`}
                style={{ width: `${system.disk.usedPercent}%` }}
              />
            </div>
            <span
              className={`text-sm font-medium tabular-nums ${percentColor(system.disk.usedPercent)}`}
            >
              {system.disk.usedPercent}%
            </span>
          </div>
          <div className="flex gap-6 text-xs text-gray-400">
            <span>
              Used: <span className="text-gray-200">{system.disk.used}</span>
            </span>
            <span>
              Available:{" "}
              <span className="text-gray-200">{system.disk.available}</span>
            </span>
            <span>
              Total: <span className="text-gray-200">{system.disk.total}</span>
            </span>
          </div>
        </div>
      )}

      {/* System info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          System
        </div>
        <div className="flex gap-6 text-xs text-gray-400 flex-wrap">
          <span>
            Platform: <span className="text-gray-200">{system.platform}</span>
          </span>
          <span>
            Arch: <span className="text-gray-200">{system.arch}</span>
          </span>
          <span>
            Node: <span className="text-gray-200">{system.nodeVersion}</span>
          </span>
          <span>
            Hostname: <span className="text-gray-200">{system.hostname}</span>
          </span>
        </div>
      </div>

      {/* PM2 */}
      {system.pm2 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
            PM2 Processes
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="text-left pb-2 font-medium">Name</th>
                <th className="text-left pb-2 font-medium">PID</th>
                <th className="text-left pb-2 font-medium">Status</th>
                <th className="text-right pb-2 font-medium">CPU%</th>
                <th className="text-right pb-2 font-medium">Memory</th>
                <th className="text-right pb-2 font-medium">Uptime</th>
              </tr>
            </thead>
            <tbody>
              {system.pm2.map((proc, i) => (
                <tr
                  key={i}
                  className="border-b border-gray-800/50 last:border-0"
                >
                  <td className="py-2 text-gray-200 font-mono text-xs">
                    {proc.name}
                  </td>
                  <td className="py-2 text-gray-400 tabular-nums text-xs">
                    {proc.pid}
                  </td>
                  <td
                    className={`py-2 text-xs font-medium ${pm2StatusColor(proc.status)}`}
                  >
                    {proc.status}
                  </td>
                  <td className="py-2 text-right text-gray-300 tabular-nums text-xs">
                    {proc.cpu.toFixed(1)}%
                  </td>
                  <td className="py-2 text-right text-gray-300 tabular-nums text-xs">
                    {formatBytes(proc.memory)}
                  </td>
                  <td className="py-2 text-right text-gray-400 tabular-nums text-xs">
                    {proc.uptime != null ? formatUptime(proc.uptime) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            PM2 Processes
          </div>
          <div className="text-sm text-gray-500">PM2 not available</div>
        </div>
      )}
    </div>
  );
}
