// ---------------------------------------------------------------------------
// Deploy drain state
//
// Tracks whether the current instance is draining for a blue-green deploy.
// The `draining` flag is set by POST /api/deploy/drain (via setDraining())
// which stops the scheduler from dispatching new jobs. Running sessions are
// interrupted by the shutdown handler, which preserves their worktrees so the
// new instance can resume from where they left off.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let draining = false;
let startupSha: string | null = null;

function log(msg: string): void {
  console.log(`[orca/deploy] ${msg}`);
}

/**
 * Read the current git HEAD SHA. Called once at startup for informational logging.
 */
export function initDeployState(): void {
  try {
    startupSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    log(`startup SHA: ${startupSha.slice(0, 12)}`);
  } catch {
    log("warning: could not read git HEAD SHA");
  }

  // Log last deploy timestamp from deploy-state.json for informational purposes
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
    // Not critical
  }
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Set the draining flag to stop the scheduler from dispatching new jobs.
 * Called by POST /api/deploy/drain during a blue-green deploy.
 */
export function setDraining(): void {
  if (draining) {
    log("already draining — ignoring duplicate setDraining()");
    return;
  }
  draining = true;
  log("draining flag set — scheduler will stop dispatching new jobs");
}
