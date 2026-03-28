// ---------------------------------------------------------------------------
// Deploy drain state
//
// Tracks whether the old instance is being drained before a blue/green deploy.
// deploy.sh posts to /api/deploy/drain to set this flag, which stops the
// scheduler from dispatching new jobs. On shutdown, if draining is active,
// in-progress Claude sessions have their worktrees preserved so the new
// instance can resume them.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

let draining = false;
let drainingStartedAt: number | null = null;

const logger = createLogger("deploy");

function log(msg: string): void {
  logger.info(msg);
}

/**
 * Read deploy state from deploy-state.json. Called once at startup.
 */
export function initDeployState(): void {
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

/**
 * Clear the draining flag, re-enabling task dispatch.
 * Used by the /api/deploy/unpause endpoint to recover from
 * failed deploys that left the instance stuck in draining mode.
 */
export function clearDraining(): void {
  if (!draining) {
    log("not draining — ignoring clearDraining()");
    return;
  }
  draining = false;
  drainingStartedAt = null;
  log("draining flag cleared (unpause)");
}

/**
 * Returns how many seconds draining has been active, or null if not draining.
 */
export function getDrainingForSeconds(): number | null {
  if (!draining || drainingStartedAt === null) return null;
  return Math.floor((Date.now() - drainingStartedAt) / 1000);
}

/**
 * Auto-clears the drain flag if stuck: draining with 0 active sessions
 * for longer than timeoutMin minutes. Returns true if the flag was cleared.
 */
export function autoClearDrainIfStuck(
  activeSessions: number,
  timeoutMin: number,
): boolean {
  if (!draining) return false;
  if (activeSessions !== 0) return false;
  const seconds = getDrainingForSeconds();
  if (seconds === null || seconds <= timeoutMin * 60) return false;
  clearDraining();
  return true;
}
