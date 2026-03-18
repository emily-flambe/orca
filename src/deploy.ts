// ---------------------------------------------------------------------------
// Deploy drain state
//
// Tracks whether the old instance is being drained before a blue/green deploy.
// deploy.sh posts to /api/deploy/drain to set this flag. This is INFORMATIONAL —
// it does NOT block task dispatch. New tasks can still be dispatched during drain
// because this flag lives on the old instance only; the new instance starts fresh
// with no drain flag and re-emits task/ready for all pending tasks on startup.
// The flag is used for monitoring (drain duration tracking, stuck-drain alerts)
// and for graceful shutdown: when draining is active, in-progress Claude sessions
// have their worktrees preserved so the new instance can resume them.
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

export function getDrainingForSeconds(): number | null {
  if (drainingStartedAt === null) return null;
  return Math.floor((Date.now() - drainingStartedAt) / 1000);
}

export function clearDraining(): void {
  if (!draining) return;
  draining = false;
  drainingStartedAt = null;
  log("drain auto-cleared: timed out with zero active sessions");
}
