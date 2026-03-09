// ---------------------------------------------------------------------------
// Graceful deploy drain
//
// When a push to main arrives via the GitHub webhook, we want to redeploy
// without orphaning in-progress Claude sessions. This module:
//   1. Sets a `draining` flag that stops the scheduler from dispatching new jobs
//   2. Polls until all active sessions finish
//   3. Spawns scripts/deploy.sh in a detached child and exits
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OrcaDb } from "./db/index.js";
import { countActiveSessions } from "./db/queries.js";

const POLL_INTERVAL_MS = 10_000;

let draining = false;

function log(msg: string): void {
  console.log(`[orca/deploy] ${msg}`);
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

export function triggerGracefulDeploy(db: OrcaDb): void {
  if (draining) {
    log("deploy already pending — ignoring duplicate trigger");
    return;
  }
  draining = true;
  log("deploy pending — draining active sessions before restart");

  const poll = () => {
    const active = countActiveSessions(db);
    if (active > 0) {
      log(
        `draining: ${active} session(s) still running — checking again in ${POLL_INTERVAL_MS / 1000}s`,
      );
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    log("all sessions complete — launching scripts/deploy.sh");
    const scriptPath = join(process.cwd(), "scripts", "deploy.sh");
    const child = spawn("bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Give the child a moment to start before we exit
    setTimeout(() => process.exit(0), 500);
  };

  // First check after one interval so any in-flight dispatch completes
  setTimeout(poll, POLL_INTERVAL_MS);
}
