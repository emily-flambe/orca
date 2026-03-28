import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { sendAlertThrottled } from "./alerts.js";
import type { SchedulerDeps } from "./types.js";

const logger = createLogger("drain-monitor");

export const DEFAULT_DRAIN_STATE_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-state-tracking.json",
);

interface DrainStateTracking {
  consecutiveZeroSessionDrainSnapshots: number;
  lastAlertedAt: number | null;
}

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if the drain flag is stuck: draining with 0 active sessions for 2+
 * consecutive reconcile snapshots (~10 minutes). Emits a throttled alert if so.
 *
 * Uses a JSON state file to track consecutive snapshot count across cycles.
 * Resets the counter when the drain+zero condition no longer holds.
 */
export function checkDrainAlert(
  deps: SchedulerDeps,
  isDrainingNow: boolean,
  activeSessions: number,
  filePath?: string,
): void {
  const targetPath = filePath ?? DEFAULT_DRAIN_STATE_FILE;

  let state: DrainStateTracking = {
    consecutiveZeroSessionDrainSnapshots: 0,
    lastAlertedAt: null,
  };

  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    state = JSON.parse(raw) as DrainStateTracking;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`checkDrainAlert: could not read state file: ${err}`);
    }
  }

  if (isDrainingNow && activeSessions === 0) {
    state.consecutiveZeroSessionDrainSnapshots++;

    if (state.consecutiveZeroSessionDrainSnapshots >= 2) {
      const count = state.consecutiveZeroSessionDrainSnapshots;
      sendAlertThrottled(
        deps,
        "drain-stuck",
        {
          severity: "warning",
          title: "Drain state stuck — no sessions for 2+ snapshots",
          message: `Orca has been draining with 0 active sessions for ${count} consecutive snapshots (~${count * 5} minutes). Deploy script may have died.`,
          fields: [
            {
              title: "Consecutive snapshots",
              value: String(count),
              short: true,
            },
          ],
        },
        ALERT_COOLDOWN_MS,
      );
    }
  } else {
    // Reset if condition no longer holds
    state.consecutiveZeroSessionDrainSnapshots = 0;
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(state));
  } catch (err) {
    logger.error(`checkDrainAlert: failed to write state file: ${err}`);
  }
}
