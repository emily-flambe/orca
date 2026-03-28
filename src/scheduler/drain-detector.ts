import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { sendAlertThrottled } from "./alerts.js";
import type { SchedulerDeps } from "./types.js";

const logger = createLogger("drain-detector");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DRAIN_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-state-tracking.json",
);

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

export function processDrainSnapshot(
  draining: boolean,
  activeSessions: number,
  state: DrainTrackingState,
  now?: Date,
): { updatedState: DrainTrackingState; shouldAlert: boolean } {
  // Anomalous session count (DB inconsistency) — leave state unchanged, no alert
  if (activeSessions < 0) {
    return { updatedState: state, shouldAlert: false };
  }

  // If not draining or sessions still active, reset state
  if (!draining || activeSessions > 0) {
    return {
      updatedState: {
        consecutiveZeroSessionSnapshots: 0,
        firstZeroSessionAt: null,
      },
      shouldAlert: false,
    };
  }

  // draining && activeSessions === 0
  const nowDate = now ?? new Date();
  const newCount = state.consecutiveZeroSessionSnapshots + 1;
  const firstZeroSessionAt = state.firstZeroSessionAt ?? nowDate.toISOString();

  const updatedState: DrainTrackingState = {
    consecutiveZeroSessionSnapshots: newCount,
    firstZeroSessionAt,
  };

  // Alert at the threshold boundary and on every subsequent snapshot
  // (sendAlertThrottled handles the cooldown to prevent spam)
  const shouldAlert = newCount >= 2;

  return { updatedState, shouldAlert };
}

// ---------------------------------------------------------------------------
// Top-level async function
// ---------------------------------------------------------------------------

export async function checkDrainState(
  deps: SchedulerDeps,
  draining: boolean,
  activeSessions: number,
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
      // Corrupted or invalid JSON — log and start fresh so the counter
      // can reach the alert threshold cleanly on the next snapshots.
      logger.warn(`checkDrainState: could not read state file (resetting): ${err}`);
    }
    // state stays as the zero default
  }

  // Process snapshot
  const { updatedState, shouldAlert } = processDrainSnapshot(
    draining,
    activeSessions,
    state,
  );

  // Emit alert if threshold hit
  if (shouldAlert) {
    const count = updatedState.consecutiveZeroSessionSnapshots;
    const firstZeroSessionAt = updatedState.firstZeroSessionAt ?? new Date().toISOString();
    const firstMs = new Date(firstZeroSessionAt).getTime();
    const durationMinutes = Math.round((Date.now() - firstMs) / 60000);

    const message = `Orca has been draining with 0 active sessions for ${count} consecutive snapshots (~${durationMinutes} min). Drain flag may be stuck.`;

    sendAlertThrottled(
      deps,
      "stuck-drain",
      {
        severity: "warning",
        title: "Stuck Drain State",
        message,
        fields: [
          { title: "Sessions", value: "0", short: true },
          { title: "Snapshots", value: String(count), short: true },
          { title: "Since", value: firstZeroSessionAt, short: false },
        ],
      },
      ALERT_COOLDOWN_MS,
    );
  }

  // Save updated state
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      JSON.stringify(updatedState, null, 2),
      "utf8",
    );
  } catch (err) {
    logger.error(`checkDrainState: failed to save state file: ${err}`);
  }
}
