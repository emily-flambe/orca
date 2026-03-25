import { useState, useEffect, useCallback } from "react";
import Card from "./ui/Card.js";
import Skeleton from "./ui/Skeleton.js";
import { timeAgo } from "../utils/time.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthData {
  cpu: {
    loadAvg: number[];
    cpuCount: number;
  };
  memory: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    usedPct: number;
  };
  process: {
    uptimeSec: number;
    heapUsedMb: number;
    heapTotalMb: number;
    rssMb: number;
  };
  inngest: {
    reachable: boolean;
    queueDepth?: number;
  };
  disk?: {
    path: string;
    totalGb: number;
    freeGb: number;
    usedGb: number;
    usedPct: number;
  };
  recentDeploys: Array<{
    id: number;
    type: string;
    message: string;
    createdAt: string;
    metadata: unknown;
  }>;
  activeSessions: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
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

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function CpuSection({ cpu }: { cpu: HealthData["cpu"] }) {
  const isWindows = cpu.loadAvg.every((v) => v === 0);

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        CPU
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">CPU Cores</span>
          <span className="text-sm tabular-nums text-gray-200">
            {cpu.cpuCount}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Load Avg (1m / 5m / 15m)</span>
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
  const pct = memory.usedPct;

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
              {memory.usedMb.toFixed(0)} MB
            </span>
            {" / "}
            <span className="text-gray-200 tabular-nums">
              {memory.totalMb.toFixed(0)} MB
            </span>
          </span>
          <span
            className={`tabular-nums font-medium ${pct >= 80 ? "text-red-400" : pct >= 60 ? "text-yellow-400" : "text-green-400"}`}
          >
            {pct.toFixed(1)}%
          </span>
        </div>
        <div className="text-xs text-gray-500">
          Free: {memory.freeMb.toFixed(0)} MB
        </div>
      </div>
    </Card>
  );
}

function ProcessSection({ proc }: { proc: HealthData["process"] }) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Process
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Uptime</span>
          <span className="text-sm tabular-nums text-gray-200">
            {formatUptime(proc.uptimeSec)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Heap Used / Total</span>
          <span className="text-sm tabular-nums text-gray-200">
            {proc.heapUsedMb.toFixed(1)} MB / {proc.heapTotalMb.toFixed(1)} MB
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">RSS</span>
          <span className="text-sm tabular-nums text-gray-200">
            {proc.rssMb.toFixed(1)} MB
          </span>
        </div>
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
          className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${inngest.reachable ? "bg-green-500" : "bg-red-500"}`}
        />
        <span
          className={`text-sm font-medium ${inngest.reachable ? "text-green-400" : "text-red-400"}`}
        >
          {inngest.reachable ? "Reachable" : "Unreachable"}
        </span>
        {inngest.queueDepth !== undefined && (
          <span className="ml-auto text-xs text-gray-400 tabular-nums">
            Queue depth: {inngest.queueDepth}
          </span>
        )}
      </div>
    </Card>
  );
}

function DiskSection({ disk }: { disk: NonNullable<HealthData["disk"]> }) {
  const pct = disk.usedPct;

  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Disk
      </div>
      <div className="space-y-2">
        <div className="text-xs text-gray-500 truncate">{disk.path}</div>
        <ProgressBar pct={pct} color={barColor(pct)} />
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>
            Used:{" "}
            <span className="text-gray-200 tabular-nums">
              {disk.usedGb.toFixed(1)} GB
            </span>
            {" / "}
            <span className="text-gray-200 tabular-nums">
              {disk.totalGb.toFixed(1)} GB
            </span>
          </span>
          <span
            className={`tabular-nums font-medium ${pct >= 80 ? "text-red-400" : pct >= 60 ? "text-yellow-400" : "text-green-400"}`}
          >
            {pct.toFixed(1)}%
          </span>
        </div>
        <div className="text-xs text-gray-500">
          Free: {disk.freeGb.toFixed(1)} GB
        </div>
      </div>
    </Card>
  );
}

function RecentDeploysSection({
  deploys,
}: {
  deploys: HealthData["recentDeploys"];
}) {
  return (
    <Card>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-3">
        Recent Deploys
      </div>
      {deploys.length === 0 ? (
        <div className="py-4 text-center text-sm text-gray-500">
          No deploy events
        </div>
      ) : (
        <div className="divide-y divide-gray-800">
          {deploys.map((d) => (
            <div key={d.id} className="py-2 flex items-start gap-3">
              <span className="inline-block h-2 w-2 rounded-full bg-cyan-500 shrink-0 mt-1.5" />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-300 truncate block">
                  {d.message}
                </span>
                <span className="text-xs text-gray-600 tabular-nums">
                  {timeAgo(d.createdAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main HealthPage
// ---------------------------------------------------------------------------

async function fetchHealth(): Promise<HealthData> {
  const res = await fetch("/api/system-health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<HealthData>;
}

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(0);

  const load = useCallback(() => {
    fetchHealth()
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

  // Suppress unused variable warning — nowTick is consumed by the render below
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
            {data.activeSessions} active session
            {data.activeSessions !== 1 ? "s" : ""}
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

      {/* Two-column grid for Process + Inngest */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ProcessSection proc={data.process} />
        <InngestSection inngest={data.inngest} />
      </div>

      {/* Disk — only if present */}
      {data.disk && <DiskSection disk={data.disk} />}

      {/* Recent Deploys */}
      <RecentDeploysSection deploys={data.recentDeploys} />
    </div>
  );
}
