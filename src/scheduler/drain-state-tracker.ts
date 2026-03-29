import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { sendAlertThrottled } from "./alerts.js";
import type { SchedulerDeps } from "./types.js";

const logger = createLogger("drain-state-tracker");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DRAIN_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-state-tracking.json",
);

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstSeenAt: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Track drain state across cron snapshots and alert when drain has been stuck
 * (draining=true with 0 active sessions) for 2+ consecutive snapshots.
 */
export async function trackDrainState(
  deps: SchedulerDeps,
  isDraining: boolean,
  activeSessions: number,
  filePath?: string,
): Promise<void> {
  const targetPath = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;

  // Load state
  let state: DrainTrackingState | null = null;
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    state = JSON.parse(raw) as DrainTrackingState;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`trackDrainState: could not read state file: ${err}`);
    }
  }

  const isStuck = isDraining && activeSessions === 0;

  let updatedState: DrainTrackingState | null;

  if (!isStuck) {
    // Reset state when not stuck
    updatedState = null;
  } else if (!state) {
    // First snapshot seeing stuck drain
    updatedState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt: new Date().toISOString(),
    };
  } else {
    // Increment consecutive count
    updatedState = {
      consecutiveZeroSessionSnapshots:
        state.consecutiveZeroSessionSnapshots + 1,
      firstSeenAt: state.firstSeenAt,
    };
  }

  // Alert when stuck for 2+ consecutive snapshots
  if (updatedState && updatedState.consecutiveZeroSessionSnapshots >= 2) {
    const { consecutiveZeroSessionSnapshots, firstSeenAt } = updatedState;
    const durationMinutes = Math.round(
      (Date.now() - new Date(firstSeenAt).getTime()) / 60000,
    );
    const message = `Drain state has been active with 0 sessions for ${consecutiveZeroSessionSnapshots} consecutive snapshots (~${durationMinutes} min). The drain flag may be stuck — manual unpause may be required.`;

    sendAlertThrottled(
      deps,
      "drain-stuck",
      {
        severity: "warning",
        title: "Stuck Drain State",
        message,
        fields: [
          {
            title: "Consecutive Snapshots",
            value: String(consecutiveZeroSessionSnapshots),
            short: true,
          },
          {
            title: "Active Sessions",
            value: String(activeSessions),
            short: true,
          },
          {
            title: "Duration",
            value: `${durationMinutes} min`,
            short: true,
          },
          { title: "First Seen", value: firstSeenAt, short: false },
        ],
      },
      ALERT_COOLDOWN_MS,
    );
  }

  // Persist state (delete file when not stuck)
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (updatedState) {
      await fs.writeFile(
        targetPath,
        JSON.stringify(updatedState, null, 2),
        "utf8",
      );
    } else {
      // Remove stale tracking file when drain is clear or sessions > 0
      await fs.unlink(targetPath).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger.warn(`trackDrainState: failed to remove state file: ${err}`);
        }
      });
    }
  } catch (err) {
    logger.error(`trackDrainState: failed to save state file: ${err}`);
  }
}
