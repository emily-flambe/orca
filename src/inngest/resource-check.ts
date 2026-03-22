// ---------------------------------------------------------------------------
// Cross-platform resource checking for session dispatch throttling
//
// On Windows, os.loadavg() returns [0, 0, 0] — no CPU load average is
// available. In that case the CPU check is skipped (returns 0% load).
// Memory check uses os.freemem() which works cross-platform.
// ---------------------------------------------------------------------------

import os from "node:os";

const log = (...args: unknown[]) =>
  console.log("[orca/inngest/resource-check]", ...args);

const MEM_THRESHOLD_MB = 2048;
const CPU_THRESHOLD_PERCENT = 80;

export interface ResourceSnapshot {
  memAvailableMb: number;
  cpuLoadPercent: number;
}

/**
 * Returns a snapshot of current system resource usage.
 *
 * CPU load:
 *   - Unix: os.loadavg()[0] / os.cpus().length * 100
 *   - Windows: os.loadavg() is not implemented; cpuLoadPercent is 0 (check skipped)
 *
 * Memory: os.freemem() / 1024 / 1024 (works cross-platform)
 */
export function getResourceSnapshot(): ResourceSnapshot {
  const memAvailableMb = os.freemem() / 1024 / 1024;

  // Windows does not implement load averages — skip CPU check there.
  let cpuLoadPercent = 0;
  if (process.platform !== "win32") {
    const loadAvg1m = os.loadavg()[0];
    const cpuCount = os.cpus().length || 1;
    cpuLoadPercent = Math.max(0, (loadAvg1m / cpuCount) * 100);
  }

  return { memAvailableMb, cpuLoadPercent };
}

/**
 * Returns true if system resources are constrained and dispatch should be
 * skipped. Logs details when constrained.
 *
 * Thresholds:
 *   - Memory < 2 GB available
 *   - CPU load > 80% (Unix only; skipped on Windows)
 */
export function isResourceConstrained(snapshot: ResourceSnapshot): boolean {
  const { memAvailableMb, cpuLoadPercent } = snapshot;

  if (memAvailableMb < MEM_THRESHOLD_MB) {
    log(
      `memory constrained: ${memAvailableMb.toFixed(0)}MB available (threshold: ${MEM_THRESHOLD_MB}MB)`,
    );
    return true;
  }

  if (cpuLoadPercent > CPU_THRESHOLD_PERCENT) {
    log(
      `CPU constrained: ${cpuLoadPercent.toFixed(1)}% load (threshold: ${CPU_THRESHOLD_PERCENT}%)`,
    );
    return true;
  }

  return false;
}
