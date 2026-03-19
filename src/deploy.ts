// ---------------------------------------------------------------------------
// Deploy drain state
//
// Tracks whether the old instance is being drained before a blue/green deploy.
// deploy.sh posts to /api/deploy/drain to set this flag.
//
// Task dispatch during drain: Tasks CAN still be dispatched while draining=true.
// The drain flag does NOT prevent new Inngest task/ready events from being
// processed — it only affects shutdown behavior (worktree preservation) and
// monitoring/alerting. This is intentional: during a blue/green deploy, the
// old instance is still alive and can continue processing tasks. The deploy
// completes by switching the Cloudflare tunnel to the new instance and then
// killing the old one; any sessions interrupted mid-flight are preserved via
// worktrees and can be resumed by the new instance. Blocking dispatch during
// drain would cause unnecessary task delays on every deploy.
//
// On shutdown, if draining is active, in-progress Claude sessions have their
// worktrees preserved so the new instance can resume them.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

let draining = false;
let drainStartedAt: number | null = null;
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
  drainStartedAt = Date.now();
  log("draining flag set (external deploy mode)");
}

export function getDrainStartedAt(): number | null {
  return drainStartedAt;
}

/**
 * Reset the drain flag and timestamp. Used for auto-recovery when drain
 * is stuck with no active sessions past the timeout.
 */
export function clearDraining(): void {
  logger.warn("clearDraining() called — resetting drain flag");
  draining = false;
  drainStartedAt = null;
}
