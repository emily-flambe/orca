// ---------------------------------------------------------------------------
// Graceful deploy drain
//
// When the blue-green deploy script kills the old instance, in-progress
// Claude Code sessions get interrupted. This module manages a `draining`
// flag that stops the scheduler from dispatching new jobs, and exposes
// helpers used by the deploy API endpoint and scheduler.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let draining = false;
let lastDeployTriggeredAt: number | null = null;
let startupSha: string | null = null;

function log(msg: string): void {
  console.log(`[orca/deploy] ${msg}`);
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

  // Read last deploy timestamp from deploy-state.json for cooldown
  try {
    const stateFile = join(process.cwd(), "deploy-state.json");
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
        deployedAt?: string;
      };
      if (state.deployedAt) {
        lastDeployTriggeredAt = new Date(state.deployedAt).getTime();
        log(
          `last deploy: ${state.deployedAt} (${Math.round((Date.now() - lastDeployTriggeredAt) / 1000)}s ago)`,
        );
      }
    }
  } catch {
    // Not critical — cooldown will start from null (no restriction)
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
  log("draining flag set (external deploy mode)");
}
