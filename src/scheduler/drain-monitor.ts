import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { sendAlertThrottled } from "./alerts.js";
import { isDraining, getDrainingForSeconds, clearDraining } from "../deploy.js";
import { activeHandles } from "../session-handles.js";
import { insertSystemEvent } from "../db/queries.js";
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

const ALERT_COOLDOWN_MS = 1_800_000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstZeroSessionAt: string | null;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function checkDrainTimeout(
  deps: SchedulerDeps,
  filePath?: string,
): Promise<void> {
  const { db, config } = deps;

  if (!isDraining()) {
    // If not draining, reset tracking file if it exists
    const targetPath = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;
    const resetState: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 0,
      firstZeroSessionAt: null,
    };
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(
        targetPath,
        JSON.stringify(resetState, null, 2),
        "utf8",
      );
    } catch {
      // Non-critical
    }
    return;
  }

  const activeSessions = activeHandles.size;
  const drainDurationSec = getDrainingForSeconds() ?? 0;
  const drainTimeoutSec = config.drainTimeoutMin * 60;

  // Auto-clear drain if past timeout with no sessions
  if (activeSessions === 0 && drainDurationSec >= drainTimeoutSec) {
    // Load state to check if we should also alert before clearing
    const targetPathEarly = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;
    let stateEarly: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 0,
      firstZeroSessionAt: null,
    };
    try {
      const raw = await fs.readFile(targetPathEarly, "utf8");
      stateEarly = JSON.parse(raw) as DrainTrackingState;
    } catch {
      // Ignore — first run or missing file
    }
    const snapCountAtClear = stateEarly.consecutiveZeroSessionSnapshots + 1;
    if (snapCountAtClear >= 2) {
      sendAlertThrottled(
        deps,
        "drain-zero-sessions",
        {
          severity: "warning",
          title: "Drain stuck with 0 active sessions",
          message: `Drain flag has been set for ${Math.round(drainDurationSec / 60)} min with 0 active sessions across ${snapCountAtClear} consecutive snapshots. Drain timeout is ${config.drainTimeoutMin} min.`,
          fields: [
            {
              title: "Drain Duration",
              value: `${Math.round(drainDurationSec / 60)} min`,
              short: true,
            },
            {
              title: "Drain Timeout",
              value: `${config.drainTimeoutMin} min`,
              short: true,
            },
            {
              title: "First Zero-Session At",
              value: stateEarly.firstZeroSessionAt ?? "unknown",
              short: false,
            },
          ],
        },
        ALERT_COOLDOWN_MS,
      );
    }

    clearDraining();
    logger.warn(
      `drain auto-cleared after ${Math.round(drainDurationSec / 60)}min with no active sessions`,
    );
    insertSystemEvent(db, {
      type: "health_check",
      message: `Drain flag auto-cleared: draining for ${Math.round(drainDurationSec / 60)} min with 0 active sessions (timeout: ${config.drainTimeoutMin} min)`,
      metadata: {
        drainDurationSec,
        drainTimeoutMin: config.drainTimeoutMin,
      },
    });
    // Reset tracking state after auto-clear
    try {
      const resetState: DrainTrackingState = {
        consecutiveZeroSessionSnapshots: 0,
        firstZeroSessionAt: null,
      };
      await fs.mkdir(path.dirname(targetPathEarly), { recursive: true });
      await fs.writeFile(
        targetPathEarly,
        JSON.stringify(resetState, null, 2),
        "utf8",
      );
    } catch {
      // Non-critical
    }
    return;
  }

  // Load tracking state for consecutive snapshot alerting
  const targetPath = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;
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
      logger.warn(`checkDrainTimeout: could not read state file: ${err}`);
    }
  }

  let updatedState: DrainTrackingState;

  if (activeSessions === 0) {
    // Increment consecutive zero-session snapshot count
    const isFirst = state.consecutiveZeroSessionSnapshots === 0;
    updatedState = {
      consecutiveZeroSessionSnapshots:
        state.consecutiveZeroSessionSnapshots + 1,
      firstZeroSessionAt: isFirst
        ? new Date().toISOString()
        : state.firstZeroSessionAt,
    };

    // Alert at threshold=2 and beyond (subject to 30-minute cooldown)
    if (updatedState.consecutiveZeroSessionSnapshots >= 2) {
      sendAlertThrottled(
        deps,
        "drain-zero-sessions",
        {
          severity: "warning",
          title: "Drain stuck with 0 active sessions",
          message: `Drain flag has been set for ${Math.round(drainDurationSec / 60)} min with 0 active sessions across 2 consecutive snapshots. Drain timeout is ${config.drainTimeoutMin} min.`,
          fields: [
            {
              title: "Drain Duration",
              value: `${Math.round(drainDurationSec / 60)} min`,
              short: true,
            },
            {
              title: "Drain Timeout",
              value: `${config.drainTimeoutMin} min`,
              short: true,
            },
            {
              title: "First Zero-Session At",
              value: updatedState.firstZeroSessionAt ?? "unknown",
              short: false,
            },
          ],
        },
        ALERT_COOLDOWN_MS,
      );
    }
  } else {
    // Sessions are active — reset tracking
    updatedState = {
      consecutiveZeroSessionSnapshots: 0,
      firstZeroSessionAt: null,
    };
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
    logger.error(`checkDrainTimeout: failed to save state file: ${err}`);
  }
}
