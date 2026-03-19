import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLogger } from "../logger.js";
import { sendAlertThrottled } from "./alerts.js";
import type { SchedulerDeps } from "./types.js";

const logger = createLogger("stuck-task-detector");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "task-state-tracking.json",
);

export const DEFAULT_DRAIN_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-state-tracking.json",
);

export const STUCK_THRESHOLDS: Record<string, number> = {
  running: 2,
  dispatched: 2,
  in_review: 2,
  awaiting_ci: 4,
  changes_requested: 2,
  deploying: 2,
};

export const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "canceled",
  "ready",
  "backlog",
]);

const ALERT_COOLDOWN_MS = 1_800_000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstSeenAt: string | null;
}

export interface TaskTrackingEntry {
  status: string;
  firstSeenAt: string;
  consecutiveSnapshots: number;
  retryCount: number;
}

export interface TaskTrackingState {
  [linearIssueId: string]: TaskTrackingEntry;
}

export interface StuckTaskAlert {
  linearIssueId: string;
  status: string;
  consecutiveSnapshots: number;
  firstSeenAt: string;
  retryCount: number;
  durationMinutes: number;
}

// ---------------------------------------------------------------------------
// Core snapshot logic (pure)
// ---------------------------------------------------------------------------

export function processSnapshot(
  currentTasks: Array<{
    linearIssueId: string;
    orcaStatus: string;
    retryCount: number;
  }>,
  state: TaskTrackingState,
  now?: Date,
): { updatedState: TaskTrackingState; alerts: StuckTaskAlert[] } {
  const nowDate = now ?? new Date();
  const nowMs = nowDate.getTime();
  const alerts: StuckTaskAlert[] = [];

  // Build updated state
  const updatedState: TaskTrackingState = {};

  for (const task of currentTasks) {
    const { linearIssueId, orcaStatus, retryCount } = task;

    // Terminal or uninteresting statuses: remove from tracking
    if (TERMINAL_STATUSES.has(orcaStatus)) {
      // Don't carry forward — effectively removed
      continue;
    }

    const existing = state[linearIssueId];

    if (!existing) {
      // New entry
      updatedState[linearIssueId] = {
        status: orcaStatus,
        firstSeenAt: nowDate.toISOString(),
        consecutiveSnapshots: 1,
        retryCount,
      };
    } else if (existing.status !== orcaStatus) {
      // Status changed — reset
      updatedState[linearIssueId] = {
        status: orcaStatus,
        firstSeenAt: nowDate.toISOString(),
        consecutiveSnapshots: 1,
        retryCount,
      };
    } else {
      // Same status — increment
      updatedState[linearIssueId] = {
        status: orcaStatus,
        firstSeenAt: existing.firstSeenAt,
        consecutiveSnapshots: existing.consecutiveSnapshots + 1,
        retryCount,
      };
    }

    // Alert exactly at the threshold boundary (not on every snapshot past it)
    const entry = updatedState[linearIssueId]!;
    const threshold = STUCK_THRESHOLDS[orcaStatus];
    if (threshold !== undefined && entry.consecutiveSnapshots === threshold) {
      const firstSeenMs = new Date(entry.firstSeenAt).getTime();
      const durationMinutes = Math.round((nowMs - firstSeenMs) / 60000);
      alerts.push({
        linearIssueId,
        status: orcaStatus,
        consecutiveSnapshots: entry.consecutiveSnapshots,
        firstSeenAt: entry.firstSeenAt,
        retryCount,
        durationMinutes,
      });
    }
  }

  // Tasks not in currentTasks are implicitly dropped (not carried forward)
  // — already handled by only building updatedState from currentTasks

  return { updatedState, alerts };
}

// ---------------------------------------------------------------------------
// Top-level async function
// ---------------------------------------------------------------------------

export async function detectAndAlertStuckTasks(
  deps: SchedulerDeps,
  currentTasks: Array<{
    linearIssueId: string;
    orcaStatus: string;
    retryCount: number;
  }>,
  filePath?: string,
): Promise<void> {
  const targetPath = filePath ?? DEFAULT_TRACKING_FILE;

  // Load state
  let state: TaskTrackingState = {};
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    state = JSON.parse(raw) as TaskTrackingState;
  } catch (err: unknown) {
    // File not found is expected on first run
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(
        `detectAndAlertStuckTasks: could not read state file: ${err}`,
      );
    }
  }

  // Process snapshot
  const { updatedState, alerts } = processSnapshot(currentTasks, state);

  // Emit alerts
  for (const alert of alerts) {
    const {
      linearIssueId,
      status,
      consecutiveSnapshots,
      firstSeenAt,
      retryCount,
      durationMinutes,
    } = alert;

    const key = `stuck-task-${linearIssueId}`;
    const message = `Task ${linearIssueId} has been in '${status}' for ${consecutiveSnapshots} consecutive snapshots (~${durationMinutes} min). Retry count: ${retryCount}.`;

    sendAlertThrottled(
      deps,
      key,
      {
        severity: "warning",
        title: `Stuck Task: ${linearIssueId}`,
        message,
        taskId: linearIssueId,
        fields: [
          { title: "Task ID", value: linearIssueId, short: true },
          { title: "Status", value: status, short: true },
          {
            title: "Snapshots",
            value: String(consecutiveSnapshots),
            short: true,
          },
          { title: "Duration", value: `${durationMinutes} min`, short: true },
          { title: "Retries", value: String(retryCount), short: true },
          { title: "First Seen", value: firstSeenAt, short: false },
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
    logger.error(`detectAndAlertStuckTasks: failed to save state file: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Drain state monitoring
// ---------------------------------------------------------------------------

export async function detectAndAlertStuckDrain(
  deps: SchedulerDeps,
  isDraining: boolean,
  activeSessions: number,
  filePath?: string,
): Promise<DrainTrackingState> {
  const targetPath = filePath ?? DEFAULT_DRAIN_TRACKING_FILE;

  const resetState: DrainTrackingState = {
    consecutiveZeroSessionSnapshots: 0,
    firstSeenAt: null,
  };

  // Load existing state
  let state: DrainTrackingState = { ...resetState };
  try {
    const raw = await fs.readFile(targetPath, "utf8");
    state = JSON.parse(raw) as DrainTrackingState;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`detectAndAlertStuckDrain: could not read state file: ${err}`);
    }
  }

  let updatedState: DrainTrackingState;

  if (!isDraining) {
    // Not draining — reset state
    updatedState = { ...resetState };
  } else if (activeSessions > 0) {
    // Draining with active sessions — reset state (normal drain in progress)
    updatedState = { ...resetState };
  } else {
    // Draining with zero active sessions — increment counter
    const now = new Date().toISOString();
    const newCount = state.consecutiveZeroSessionSnapshots + 1;
    updatedState = {
      consecutiveZeroSessionSnapshots: newCount,
      firstSeenAt: state.firstSeenAt ?? now,
    };

    if (newCount === 2) {
      const firstSeenMs = new Date(updatedState.firstSeenAt!).getTime();
      const durationMinutes = Math.round((Date.now() - firstSeenMs) / 60000);
      const message = `Drain has been active with 0 sessions for ${durationMinutes} min (${newCount} consecutive snapshots). Drain may be stuck.`;

      sendAlertThrottled(
        deps,
        "stuck-drain",
        {
          severity: "warning",
          title: "Stuck Drain: draining with no sessions",
          message,
          fields: [
            {
              title: "Consecutive Zero-Session Snapshots",
              value: String(newCount),
              short: true,
            },
            {
              title: "Duration",
              value: `${durationMinutes} min`,
              short: true,
            },
            { title: "First Seen", value: updatedState.firstSeenAt!, short: false },
          ],
        },
        1_800_000,
      );
    }
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
    logger.error(
      `detectAndAlertStuckDrain: failed to save state file: ${err}`,
    );
  }

  return updatedState;
}
