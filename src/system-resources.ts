import * as os from "node:os";

export interface ResourceSnapshot {
  availableMemoryGb: number;
  cpuLoadPercent: number | null; // null on Windows (loadavg not supported)
}

export interface ResourceThresholds {
  minMemoryGb: number;
  maxCpuPercent: number;
}

export interface ResourceCheckResult {
  ok: boolean;
  reason?: string;
  snapshot: ResourceSnapshot;
}

export function getResourceSnapshot(): ResourceSnapshot {
  const availableMemoryGb = os.freemem() / 1024 ** 3;

  let cpuLoadPercent: number | null = null;
  if (process.platform !== "win32") {
    const loadAvg1min = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    cpuLoadPercent = cpuCount > 0 ? (loadAvg1min / cpuCount) * 100 : null;
  }

  return { availableMemoryGb, cpuLoadPercent };
}

export function checkResourceConstraints(
  thresholds: ResourceThresholds,
): ResourceCheckResult {
  const snapshot = getResourceSnapshot();

  if (snapshot.availableMemoryGb < thresholds.minMemoryGb) {
    return {
      ok: false,
      reason: `insufficient memory: ${snapshot.availableMemoryGb.toFixed(2)}GB available (minimum: ${thresholds.minMemoryGb}GB)`,
      snapshot,
    };
  }

  if (
    snapshot.cpuLoadPercent !== null &&
    snapshot.cpuLoadPercent > thresholds.maxCpuPercent
  ) {
    return {
      ok: false,
      reason: `CPU load too high: ${snapshot.cpuLoadPercent.toFixed(1)}% (maximum: ${thresholds.maxCpuPercent}%)`,
      snapshot,
    };
  }

  return { ok: true, snapshot };
}
