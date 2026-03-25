import { useState, useEffect, useCallback } from "react";
import Card from "./ui/Card.js";
import Skeleton from "./ui/Skeleton.js";
import { fetchSystemHealth, type SystemHealthData } from "../hooks/useApi.js";

type HealthData = SystemHealthData;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}

function ProgressBar({
  pct,
  color = "bg-blue-500",
}: {
  pct: number;
  color?: string;
}) {
  const capped = Math.min(100, Math.max(0, pct));
  return (
    <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all`}
        style={{ width: `${capped}%` }}
      />
    </div>
  );
}

function barColor(pct: number): string {
  if (pct < 60) return "bg-green-500";
  if (pct < 80) return "bg-yellow-500";
  return "bg-red-500";
}

function textColor(pct: number): string {
  if (pct >= 80) return "text-red-400";
  if (pct >= 60) return "text-yellow-400";
  return "text-green-400";
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function CpuSection({ cpu }: { cpu: HealthData["cpu"] }) {
  const isWindows = cpu.platform === "win32";

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        CPU
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Cores</span>
          <span className="text-sm tabular-nums text-gray-200">
            {cpu.cpuCount}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Platform</span>
          <span className="text-sm tabular-nums text-gray-200">
            {cpu.platform}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">
            Load Avg (1m / 5m / 15m)
          </span>
          <span className="text-sm tabular-nums text-gray-200">
            {isWindows ? (
              <span className="text-gray-500">N/A (Windows)</span>
            ) : (
              cpu.loadAvg.map((v) => v.toFixed(2)).join(" / ")
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

function MemorySection({ memory }: { memory: HealthData["memory"] }) {
  const pct = memory.usedPercent;

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Memory
      </div>
      <div className="space-y-2">
        <ProgressBar pct={pct} color={barColor(pct)} />
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>
            Used:{" "}
            <span className="text-gray-200 tabular-nums">
              {memory.usedMb} MB
            </span>
            {" / "}
            <span className="text-gray-200 tabular-nums">
              {memory.totalMb} MB
            </span>
          </span>
          <span className={`tabular-nums font-medium ${textColor(pct)}`}>
            {pct}%
          </span>
        </div>
        <div className="text-xs text-gray-500">Free: {memory.freeMb} MB</div>
      </div>
    </Card>
  );
}

function InngestSection({ inngest }: { inngest: HealthData["inngest"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Inngest
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${inngest.healthy ? "bg-green-500" : "bg-red-500"}`}
        />
        <span
          className={`text-sm font-medium ${inngest.healthy ? "text-green-400" : "text-red-400"}`}
        >
          {inngest.healthy ? "Healthy" : "Unhealthy"}
        </span>
        <span className="ml-auto text-xs text-gray-500 truncate">
          {inngest.url}
        </span>
      </div>
      {inngest.error && (
        <div className="mt-2 text-xs text-red-400 truncate">
          {inngest.error}
        </div>
      )}
    </Card>
  );
}

function DiskSection({ disk }: { disk: HealthData["disk"] }) {
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

  const pct = disk.usedPercent;

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Disk
      </div>
      <div className="space-y-2">
        <ProgressBar pct={pct} color={barColor(pct)} />
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>
            Used:{" "}
            <span className="text-gray-200 tabular-nums">{disk.usedGb} GB</span>
            {" / "}
            <span className="text-gray-200 tabular-nums">
              {disk.totalGb} GB
            </span>
          </span>
          <span className={`tabular-nums font-medium ${textColor(pct)}`}>
            {pct}%
          </span>
        </div>
        <div className="text-xs text-gray-500">Free: {disk.freeGb} GB</div>
      </div>
    </Card>
  );
}

function Pm2Section({ pm2 }: { pm2: HealthData["pm2"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        PM2
      </div>
      {!pm2.available ? (
        <div className="text-sm text-gray-500">Not available</div>
      ) : pm2.processes.length === 0 ? (
        <div className="text-sm text-gray-500">No processes</div>
      ) : (
        <div className="divide-y divide-gray-800">
          {pm2.processes.map((p) => (
            <div key={p.name} className="py-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-200 font-medium">
                  {p.name}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${p.status === "online" ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}
                >
                  {p.status}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-400 tabular-nums">
                <span>CPU: {p.cpu}%</span>
                <span>Mem: {p.memory} MB</span>
                <span>Restarts: {p.restarts}</span>
                <span>Up: {formatUptime(p.uptime)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SessionsSection({ sessions }: { sessions: HealthData["sessions"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Sessions
      </div>
      <div className="flex items-center gap-6">
        <div className="text-center">
          <div className="text-2xl tabular-nums font-semibold text-gray-200">
            {sessions.active}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Active</div>
        </div>
        <div className="text-center">
          <div className="text-2xl tabular-nums font-semibold text-gray-200">
            {sessions.totalToday}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Today</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main HealthPage
// ---------------------------------------------------------------------------

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(0);

  const load = useCallback(() => {
    fetchSystemHealth()
      .then((d) => {
        setData(d);
        setLastUpdated(new Date());
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  // Tick to update "X seconds ago" display
  useEffect(() => {
    const tick = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  void nowTick;

  if (loading) return <Skeleton lines={8} className="m-6" />;
  if (error)
    return <div className="p-6 text-sm text-red-400">Error: {error}</div>;
  if (!data) return null;

  const secondsAgo = lastUpdated
    ? Math.floor((Date.now() - lastUpdated.getTime()) / 1000)
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            System Health
          </h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-300 tabular-nums">
            {data.sessions.active} active session
            {data.sessions.active !== 1 ? "s" : ""}
          </span>
        </div>
        {secondsAgo !== null && (
          <span className="text-xs text-gray-500 tabular-nums">
            Last updated: {secondsAgo}s ago
          </span>
        )}
      </div>

      {/* Two-column grid for CPU + Memory */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CpuSection cpu={data.cpu} />
        <MemorySection memory={data.memory} />
      </div>

      {/* Two-column grid for Inngest + Sessions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InngestSection inngest={data.inngest} />
        <SessionsSection sessions={data.sessions} />
      </div>

      {/* Disk */}
      <DiskSection disk={data.disk} />

      {/* PM2 */}
      <Pm2Section pm2={data.pm2} />
    </div>
  );
}
