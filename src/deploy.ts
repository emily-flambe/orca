// ---------------------------------------------------------------------------
// Graceful deploy drain
//
// When a push to main arrives via the GitHub webhook, we want to redeploy
// without orphaning in-progress Claude sessions. This module:
//   1. Checks cooldown and SHA dedup to avoid redundant deploys
//   2. Sets a `draining` flag that stops the scheduler from dispatching new jobs
//   3. Polls until all active sessions finish
//   4. Spawns scripts/deploy.sh in a detached child (does NOT exit — deploy.sh
//      handles killing the old instance after the new one is healthy)
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { OrcaDb } from "./db/index.js";
import { countActiveSessions } from "./db/queries.js";

const POLL_INTERVAL_MS = 10_000;
const DEPLOY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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

export interface DeployOptions {
  /** The commit SHA from the push event (used for dedup). */
  pushSha?: string;
}

export function triggerGracefulDeploy(
  db: OrcaDb,
  options?: DeployOptions,
): void {
  if (draining) {
    log("deploy already pending — ignoring duplicate trigger");
    return;
  }

  // --- SHA dedup: skip if we're already running the pushed commit ---
  if (options?.pushSha && startupSha && options.pushSha === startupSha) {
    log(
      `skipping deploy — already running pushed SHA ${options.pushSha.slice(0, 12)}`,
    );
    return;
  }

  // --- Cooldown: skip if last deploy was too recent ---
  if (lastDeployTriggeredAt) {
    const elapsed = Date.now() - lastDeployTriggeredAt;
    if (elapsed < DEPLOY_COOLDOWN_MS) {
      const remainingSec = Math.ceil((DEPLOY_COOLDOWN_MS - elapsed) / 1000);
      log(
        `skipping deploy — cooldown active (${remainingSec}s remaining, last deploy ${Math.round(elapsed / 1000)}s ago)`,
      );
      return;
    }
  }

  draining = true;
  lastDeployTriggeredAt = Date.now();
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
    // Do NOT call process.exit() here. deploy.sh handles the full lifecycle:
    //   1. Starts new instance on standby port
    //   2. Health checks new instance
    //   3. Switches tunnel
    //   4. Drains and kills THIS (old) instance
    // If we exit here, deploy.sh might fail mid-flight with nothing running.
    log(
      "deploy.sh spawned — old instance staying alive until deploy.sh kills it",
    );
  };

  // First check after one interval so any in-flight dispatch completes
  setTimeout(poll, POLL_INTERVAL_MS);
}
