// ---------------------------------------------------------------------------
// Stuck task detection — cross-snapshot state tracking
// ---------------------------------------------------------------------------

export interface TaskTrackingState {
  [taskId: string]: {
    status: string;
    firstSeenAt: string; // ISO timestamp when this status was first observed
    consecutiveSnapshots: number;
    retryCount: number;
  };
}

export interface StuckTaskAlert {
  taskId: string;
  status: string;
  consecutiveSnapshots: number;
  durationMinutes: number; // approx minutes stuck (consecutiveSnapshots * 15)
  retryCount: number;
}

// Statuses that indicate a task is in progress and should not stay indefinitely
export const TRANSIENT_THRESHOLD = 2;
export const AWAITING_CI_THRESHOLD = 4;
export const SNAPSHOT_INTERVAL_MINUTES = 15;

export const TERMINAL_STATUSES = new Set(["done", "failed", "canceled", "ready", "backlog"]);

const TRANSIENT_STATUSES = new Set(["running", "dispatched", "in_review", "changes_requested", "deploying"]);

/**
 * Given the previous tracking state and a fresh snapshot of tasks,
 * returns the updated tracking state and any stuck-task alerts.
 *
 * Tasks are "stuck" when:
 * - In 'running'/'dispatched'/'in_review'/'changes_requested'/'deploying' for >= TRANSIENT_THRESHOLD consecutive snapshots
 * - In 'awaiting_ci' for >= AWAITING_CI_THRESHOLD consecutive snapshots
 */
export function updateTrackingState(
  previousState: TaskTrackingState,
  tasks: Array<{ taskId: string; status: string; retryCount: number }>,
  now: Date = new Date(),
): { newState: TaskTrackingState; alerts: StuckTaskAlert[] } {
  const newState: TaskTrackingState = {};
  const alerts: StuckTaskAlert[] = [];
  const nowIso = now.toISOString();

  for (const task of tasks) {
    const { taskId, status, retryCount } = task;

    // Skip terminal statuses — don't track them
    if (TERMINAL_STATUSES.has(status)) {
      continue;
    }

    const prev = previousState[taskId];

    let consecutiveSnapshots: number;
    let firstSeenAt: string;

    if (!prev || prev.status !== status) {
      // New task or status changed — start fresh
      consecutiveSnapshots = 1;
      firstSeenAt = nowIso;
    } else {
      // Same status as before — increment counter
      consecutiveSnapshots = prev.consecutiveSnapshots + 1;
      firstSeenAt = prev.firstSeenAt;
    }

    newState[taskId] = {
      status,
      firstSeenAt,
      consecutiveSnapshots,
      retryCount,
    };

    // Check if this task is stuck
    const threshold =
      status === "awaiting_ci" ? AWAITING_CI_THRESHOLD : TRANSIENT_STATUSES.has(status) ? TRANSIENT_THRESHOLD : null;

    if (threshold !== null && consecutiveSnapshots >= threshold) {
      alerts.push({
        taskId,
        status,
        consecutiveSnapshots,
        durationMinutes: consecutiveSnapshots * SNAPSHOT_INTERVAL_MINUTES,
        retryCount,
      });
    }
  }

  return { newState, alerts };
}
