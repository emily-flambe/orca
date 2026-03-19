// ---------------------------------------------------------------------------
// Deploy drain state
//
// Tracks whether the old instance is being drained before a blue/green deploy.
// deploy.sh posts to /api/deploy/drain to set this flag, which stops the
// scheduler from dispatching new jobs. On shutdown, if draining is active,
// in-progress Claude sessions have their worktrees preserved so the new
// instance can resume them.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

let draining = false;
let drainingStartedAt: number | null = null;
let consecutiveDrainZeroSnapshots = 0;
let startupSha: string | null = null;

const logger = createLogger("deploy");

function log(msg: string): void {
  logger.info(msg);
}

/**
 * Read the current git HEAD SHA. Called once at startup to enable SHA dedup.
 */
export function initDeployState(): void {
  // Read startup SHA from git
  try {
    startupSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    log(`startup SHA: ${startupSha.slice(0, 12)}`);
  } catch {
    log("warning: could not read git HEAD SHA for deploy dedup");
  }

  // Read last deploy timestamp from deploy-state.json for informational logging
  try {
    const stateFile = join(process.cwd(), "deploy-state.json");
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
        deployedAt?: string;
      };
      if (state.deployedAt) {
        const lastDeployMs = new Date(state.deployedAt).getTime();
        log(
          `last deploy: ${state.deployedAt} (${Math.round((Date.now() - lastDeployMs) / 1000)}s ago)`,
        );
      }
    }
  } catch {
    // Not critical — informational only
  }
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Set the draining flag without spawning deploy.sh.
 * Used by the blue-green deploy API endpoint.
 */
export function setDraining(): void {
  if (draining) {
    log("already draining — ignoring duplicate setDraining()");
    return;
  }
  draining = true;
  drainingStartedAt = Date.now();
  log("draining flag set (external deploy mode)");
}

export function getDrainingStartedAt(): number | null {
  return drainingStartedAt;
}

export function clearDraining(): void {
  draining = false;
  drainingStartedAt = null;
  consecutiveDrainZeroSnapshots = 0;
  log("drain flag cleared");
}

export function checkAndAutoClearDrain(
  activeSessions: number,
  timeoutMin: number,
): boolean {
  if (!draining || activeSessions !== 0) return false;
  if (drainingStartedAt === null) return false;
  const elapsed = Date.now() - drainingStartedAt;
  if (elapsed > timeoutMin * 60000) {
    logger.warn(
      `drain auto-clearing: draining for ${Math.round(elapsed / 60000)} min with 0 active sessions (timeout: ${timeoutMin} min)`,
    );
    clearDraining();
    return true;
  }
  return false;
}

export function recordDrainZeroSnapshot(): number {
  consecutiveDrainZeroSnapshots++;
  return consecutiveDrainZeroSnapshots;
}

export function resetDrainZeroSnapshots(): void {
  consecutiveDrainZeroSnapshots = 0;
}

export function getDrainZeroSnapshots(): number {
  return consecutiveDrainZeroSnapshots;
}
