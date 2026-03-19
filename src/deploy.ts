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

// NOTE: The drain flag does NOT block Inngest task dispatch — the task-lifecycle
// workflow does not check isDraining(). Drain only affects the health/status
// API responses and the CLI shutdown path. Ready tasks will still be picked up
// by Inngest even when draining=true.
export function isDraining(): boolean {
  return draining;
}

/**
 * Clear the drain flag. Called when the drain timeout fires with zero active
 * sessions, indicating that deploy.sh died without completing the blue/green
 * switch. Controlled by ORCA_DRAIN_TIMEOUT_MIN (default: 10 min).
 */
export function clearDraining(): void {
  logger.warn("clearDraining: resetting drain flag");
  draining = false;
  drainingStartedAt = null;
}

/**
 * Returns how many seconds the drain flag has been set, or null if not draining.
 */
export function getDrainingForSeconds(): number | null {
  if (drainingStartedAt === null) return null;
  return Math.floor((Date.now() - drainingStartedAt) / 1000);
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
