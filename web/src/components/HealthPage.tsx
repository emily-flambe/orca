import type { SystemHealthData } from "../hooks/useApi.js";
import { fetchSystemHealth } from "../hooks/useApi.js";
import { useFetchWithPolling } from "../hooks/useFetchWithPolling.js";
import Card from "./ui/Card.js";
import Skeleton from "./ui/Skeleton.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usageColor(pct: number): string {
  if (pct >= 90) return "text-red-400";
  if (pct >= 70) return "text-yellow-400";
  return "text-green-400";
}

function usageBarColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-yellow-500";
  return "bg-green-500";
}

function UsageBar({ pct }: { pct: number }) {
  return (
    <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mt-1">
      <div
        className={`h-full rounded-full transition-all ${usageBarColor(pct)}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${ok ? "bg-green-500" : "bg-red-500"}`}
    />
  );
}

function formatUptime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// CPU Card
// ---------------------------------------------------------------------------

function CpuCard({ cpu }: { cpu: SystemHealthData["cpu"] }) {
  const load1 = cpu.loadAvg[0] ?? 0;
  const load5 = cpu.loadAvg[1] ?? 0;
  const load15 = cpu.loadAvg[2] ?? 0;
  // Normalize load avg to percent relative to CPU count
  const loadPct = Math.round((load1 / cpu.cpuCount) * 100);

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        CPU
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Load Average (1m)</span>
          <span
            className={`text-sm tabular-nums font-semibold ${usageColor(loadPct)}`}
          >
            {load1.toFixed(2)}
          </span>
        </div>
        <UsageBar pct={loadPct} />
        <div className="flex items-center justify-between text-xs text-gray-500 tabular-nums">
          <span>5m: {load5.toFixed(2)}</span>
          <span>15m: {load15.toFixed(2)}</span>
          <span>
            {cpu.cpuCount} cores · {cpu.platform}
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Memory Card
// ---------------------------------------------------------------------------

function MemoryCard({ memory }: { memory: SystemHealthData["memory"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Memory
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Used</span>
          <span
            className={`text-sm tabular-nums font-semibold ${usageColor(memory.usedPercent)}`}
          >
            {memory.usedMb.toLocaleString()} MB
            <span className="text-gray-500 font-normal">
              {" "}
              / {memory.totalMb.toLocaleString()} MB
            </span>
          </span>
        </div>
        <UsageBar pct={memory.usedPercent} />
        <div className="flex items-center justify-between text-xs text-gray-500 tabular-nums">
          <span>Free: {memory.freeMb.toLocaleString()} MB</span>
          <span className={usageColor(memory.usedPercent)}>
            {memory.usedPercent}% used
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Disk Card
// ---------------------------------------------------------------------------

function DiskCard({ disk }: { disk: SystemHealthData["disk"] }) {
  if (!disk.available) {
    return (
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          Disk
        </div>
        <div className="text-sm text-gray-500">Unavailable</div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Disk
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Used</span>
          <span
            className={`text-sm tabular-nums font-semibold ${usageColor(disk.usedPercent)}`}
          >
            {disk.usedGb} GB
            <span className="text-gray-500 font-normal">
              {" "}
              / {disk.totalGb} GB
            </span>
          </span>
        </div>
        <UsageBar pct={disk.usedPercent} />
        <div className="flex items-center justify-between text-xs text-gray-500 tabular-nums">
          <span>Free: {disk.freeGb} GB</span>
          <span className={usageColor(disk.usedPercent)}>
            {disk.usedPercent}% used
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Inngest Card
// ---------------------------------------------------------------------------

function InngestCard({ inngest }: { inngest: SystemHealthData["inngest"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Inngest
      </div>
      <div className="flex items-center gap-2">
        <StatusDot ok={inngest.healthy} />
        <span
          className={`text-sm font-semibold ${inngest.healthy ? "text-green-400" : "text-red-400"}`}
        >
          {inngest.healthy ? "Healthy" : "Unreachable"}
        </span>
      </div>
      <div className="mt-2 text-xs text-gray-500 truncate">{inngest.url}</div>
      {inngest.error && (
        <div className="mt-1 text-xs text-red-400 truncate">
          {inngest.error}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sessions Card
// ---------------------------------------------------------------------------

function SessionsCard({
  sessions,
}: {
  sessions: SystemHealthData["sessions"];
}) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Sessions
      </div>
      <div className="flex items-center gap-6">
        <div>
          <div className="text-xl font-semibold tabular-nums text-blue-400">
            {sessions.active}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Active now</div>
        </div>
        <div>
          <div className="text-xl font-semibold tabular-nums text-gray-200">
            {sessions.totalToday}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Today total</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PM2 Card
// ---------------------------------------------------------------------------

function Pm2Card({ pm2 }: { pm2: SystemHealthData["pm2"] }) {
  if (!pm2.available) {
    return (
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          PM2 Processes
        </div>
        <div className="text-sm text-gray-500">PM2 not available</div>
      </Card>
    );
  }

  if (pm2.processes.length === 0) {
    return (
      <Card>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
          PM2 Processes
        </div>
        <div className="text-sm text-gray-500">No processes</div>
      </Card>
    );
  }

  return (
    <Card padding={false}>
      <div className="text-xs text-gray-500 uppercase tracking-wide px-4 pt-4 mb-1">
        PM2 Processes
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="text-left font-medium px-4 py-2">Name</th>
              <th className="text-left font-medium px-4 py-2">Status</th>
              <th className="text-right font-medium px-4 py-2">CPU %</th>
              <th className="text-right font-medium px-4 py-2">Mem (MB)</th>
              <th className="text-right font-medium px-4 py-2">Uptime</th>
              <th className="text-right font-medium px-4 py-2">Restarts</th>
            </tr>
          </thead>
          <tbody>
            {pm2.processes.map((proc, i) => {
              const isOnline = proc.status === "online";
              return (
                <tr
                  key={i}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="px-4 py-2 text-gray-300 font-mono">
                    {proc.name}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`flex items-center gap-1.5 ${isOnline ? "text-green-400" : "text-red-400"}`}
                    >
                      <StatusDot ok={isOnline} />
                      {proc.status}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums ${usageColor(proc.cpu)}`}
                  >
                    {proc.cpu.toFixed(1)}%
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-300">
                    {proc.memory}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-400">
                    {proc.uptime > 0 ? formatUptime(proc.uptime) : "--"}
                  </td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums ${proc.restarts > 5 ? "text-yellow-400" : "text-gray-400"}`}
                  >
                    {proc.restarts}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main HealthPage
// ---------------------------------------------------------------------------

export default function HealthPage() {
  const { data, loading, error } = useFetchWithPolling({
    fetcher: fetchSystemHealth,
    intervalMs: 5_000,
  });

  if (loading) return <Skeleton lines={8} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const lastUpdated = new Date(data.timestamp).toLocaleTimeString();

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          System Health
        </h2>
        <span className="text-xs text-gray-500">
          Last updated:{" "}
          <span className="tabular-nums text-gray-400">{lastUpdated}</span>
        </span>
      </div>

      {/* Top row: CPU, Memory, Disk, Inngest */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <CpuCard cpu={data.cpu} />
        <MemoryCard memory={data.memory} />
        <DiskCard disk={data.disk} />
        <InngestCard inngest={data.inngest} />
      </div>

      {/* Sessions */}
      <SessionsCard sessions={data.sessions} />

      {/* PM2 processes */}
      <Pm2Card pm2={data.pm2} />
    </div>
  );
}
