// ---------------------------------------------------------------------------
// Inngest workflow helpers
//
// Shared utilities extracted from workflow files to reduce duplication.
// Only helpers used across multiple workflow files live here; single-file
// helpers stay local to that file.
// ---------------------------------------------------------------------------

import type { OrcaDb } from "../db/index.js";
import { getTask, updateTaskStatus } from "../db/queries.js";
import { emitTaskUpdated } from "../events.js";
import type { TaskStatus } from "../shared/types.js";
import type { SchedulerDeps } from "../scheduler/types.js";
import { writeBackStatus } from "../linear/sync.js";

// ---------------------------------------------------------------------------
// Pattern 1: updateTaskStatus + emitTaskUpdated
//
// Nearly every status transition calls these two in sequence. The null-safe
// variant (skip emit when task row is missing) is always correct to use.
// ---------------------------------------------------------------------------

/**
 * Update a task's status and emit a task:updated SSE event.
 * Skips the emit if the task row is missing (e.g. deleted mid-flight).
 */
export function updateAndEmit(
  db: OrcaDb,
  taskId: string,
  status: TaskStatus,
): void {
  updateTaskStatus(db, taskId, status);
  const task = getTask(db, taskId);
  if (task) emitTaskUpdated(task);
}

// ---------------------------------------------------------------------------
// Pattern 3: Polling timeout check
//
// Both ci-merge and deploy-monitor compute the same elapsed-time check.
// Extracted as a pure predicate so callers can decide what to do on timeout.
// ---------------------------------------------------------------------------

/**
 * Returns true if the polling loop has exceeded its timeout.
 *
 * @param startedAtIso - ISO timestamp when polling began
 * @param timeoutMs    - Maximum allowed elapsed time in milliseconds
 */
export function isPollingTimedOut(
  startedAtIso: string,
  timeoutMs: number,
): boolean {
  const startedAt = new Date(startedAtIso).getTime();
  return startedAt + timeoutMs < Date.now();
}

// ---------------------------------------------------------------------------
// Pattern 2: updateAndEmit + writeBackStatus + createComment
//
// Status transitions that involve both a Linear write-back and a comment
// follow this three-step sequence. The db status and Linear transition are
// kept as separate parameters because they occasionally differ (e.g. the
// merge-escalation path stores "failed" in the DB but writes "in_review" to
// Linear to preserve the PR).
// ---------------------------------------------------------------------------

type LinearTransition = Parameters<typeof writeBackStatus>[2];

/**
 * Transition a task's status, write it back to Linear, and leave a comment.
 *
 * All three operations are fire-and-forget safe: writeBackStatus and
 * createComment failures are swallowed so a Linear outage never blocks the
 * workflow.
 */
export async function transitionToFinalState(
  deps: Pick<SchedulerDeps, "db" | "client" | "stateMap">,
  taskId: string,
  dbStatus: TaskStatus,
  linearTransition: LinearTransition,
  comment: string,
): Promise<void> {
  updateAndEmit(deps.db, taskId, dbStatus);
  await writeBackStatus(deps.client, taskId, linearTransition, deps.stateMap).catch(
    () => {},
  );
  await deps.client.createComment(taskId, comment).catch(() => {});
}
