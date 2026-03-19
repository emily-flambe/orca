import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { clearDraining } from "../deploy.js";
import { sendAlert, sendAlertThrottled } from "./alerts.js";
import type { SchedulerDeps } from "./types.js";

const logger = createLogger("drain-monitor");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DRAIN_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-state-tracking.json",
);

// Alert after this many consecutive snapshots with drain=true AND activeSessions=0
export const STUCK_DRAIN_SNAPSHOT_THRESHOLD = 2;

const ALERT_COOLDOWN_MS = 1_800_000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstZeroSessionAt: string | null;
}

// ---------------------------------------------------------------------------
// Core snapshot logic (pure)
// ---------------------------------------------------------------------------

/**
 * Pure snapshot logic — returns updated state and whether an alert should fire.
 * Does NOT mutate module state.
 */
export function processDrainSnapshot(
  draining: boolean,
  activeSessions: number,
  state: DrainTrackingState,
  now?: Date,
): {
  updatedState: DrainTrackingState;
  shouldAlert: boolean;
  consecutiveZeroSessionSnapshots: number;
} {
  const nowDate = now ?? new Date();

  if (!draining || activeSessions > 0) {
    // Reset tracking — not draining or has active sessions
    return {
      updatedState: {
        consecutiveZeroSessionSnapshots: 0,
        firstZeroSessionAt: null,
      },
      shouldAlert: false,
      consecutiveZeroSessionSnapshots: 0,
    };
  }

  // draining=true AND activeSessions=0
  const consecutive = state.consecutiveZeroSessionSnapshots + 1;
  const firstZeroSessionAt = state.firstZeroSessionAt ?? nowDate.toISOString();

  return {
    updatedState: {
      consecutiveZeroSessionSnapshots: consecutive,
      firstZeroSessionAt,
    },
    shouldAlert: consecutive === STUCK_DRAIN_SNAPSHOT_THRESHOLD,
    consecutiveZeroSessionSnapshots: consecutive,
  };
}

// ---------------------------------------------------------------------------
// Top-level async function
// ---------------------------------------------------------------------------

/**
 * Check drain state, emit alerts, auto-clear if timed out.
 * Called from the reconcile cron step.
 */
export async function checkDrainState(
  deps: SchedulerDeps,
  draining: boolean,
  activeSessions: number,
  drainStartedAt: number | null,
  filePath?: string,
): Promise<void> {
  const targetPath = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;

  // Load state
  let state: DrainTrackingState = {
    consecutiveZeroSessionSnapshots: 0,
    firstZeroSessionAt: null,
  };
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    state = JSON.parse(raw) as DrainTrackingState;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`checkDrainState: could not read state file: ${err}`);
    }
  }

  const { updatedState, shouldAlert, consecutiveZeroSessionSnapshots } =
    processDrainSnapshot(draining, activeSessions, state);

  // Check for drain timeout: draining + zero sessions for longer than drainTimeoutMin
  const drainTimeoutMs = deps.config.drainTimeoutMin * 60 * 1000;
  if (draining && activeSessions === 0 && drainStartedAt !== null) {
    const drainDurationMs = Date.now() - drainStartedAt;
    if (drainDurationMs >= drainTimeoutMs) {
      logger.warn(
        `drain timeout: draining for ${Math.round(drainDurationMs / 60000)} min with 0 sessions — auto-clearing drain flag`,
      );
      clearDraining();
      sendAlert(deps, {
        severity: "warning",
        title: "Drain Timeout Auto-Cleared",
        message: `Orca was draining for ${Math.round(drainDurationMs / 60000)} min with 0 active sessions. Drain flag auto-cleared to unblock task dispatch.`,
        fields: [
          {
            title: "Drain duration",
            value: `${Math.round(drainDurationMs / 60000)} min`,
            short: true,
          },
          {
            title: "Drain timeout config",
            value: `${deps.config.drainTimeoutMin} min`,
            short: true,
          },
        ],
      });
      // Reset tracking state after auto-clear
      await saveState(targetPath, {
        consecutiveZeroSessionSnapshots: 0,
        firstZeroSessionAt: null,
      });
      return;
    }
  }

  // Alert at threshold boundary
  if (shouldAlert) {
    const durationMin = state.firstZeroSessionAt
      ? Math.round(
          (Date.now() - new Date(state.firstZeroSessionAt).getTime()) / 60000,
        )
      : 0;
    sendAlertThrottled(
      deps,
      "stuck-drain-zero-sessions",
      {
        severity: "warning",
        title: "Stuck Drain: Zero Active Sessions",
        message: `Orca has been draining with 0 active sessions for ${consecutiveZeroSessionSnapshots} consecutive snapshots (~${durationMin} min). Drain flag may be stuck.`,
        fields: [
          {
            title: "Snapshots",
            value: String(consecutiveZeroSessionSnapshots),
            short: true,
          },
          { title: "Duration", value: `~${durationMin} min`, short: true },
          {
            title: "Drain timeout",
            value: `${deps.config.drainTimeoutMin} min`,
            short: true,
          },
        ],
      },
      ALERT_COOLDOWN_MS,
    );
  }

  await saveState(targetPath, updatedState);
}

async function saveState(
  filePath: string,
  state: DrainTrackingState,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logger.error(`checkDrainState: failed to save state file: ${err}`);
  }
}
