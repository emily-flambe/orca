/**
 * Shared utilities used across Inngest workflows.
 * Extracted from task-lifecycle.ts to avoid duplication.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git.js";
import { updateTaskStatus, getTask } from "../db/queries.js";
import { emitTaskUpdated } from "../events.js";
import { writeBackStatus } from "../linear/sync.js";
import type { OrcaDb } from "../db/index.js";
import type { TaskStatus } from "../shared/types.js";
import type { LinearClient, WorkflowStateMap } from "../linear/client.js";
import { createLogger } from "../logger.js";

const log = createLogger("inngest/workflow-utils");

// ---------------------------------------------------------------------------
// alreadyDonePatterns — patterns in output summary indicating task is complete
// ---------------------------------------------------------------------------

/**
 * Patterns in the output summary that indicate the task was already done
 * (no changes needed). Merged from task-lifecycle.ts and verify-pr.ts.
 */
export const alreadyDonePatterns: string[] = [
  "already complete",
  "already implemented",
  "already merged",
  "already on main",
  "already on `main`",
  "already on `origin/main`",
  "already exists",
  "already satisfied",
  "already done",
  "nothing to do",
  "no changes needed",
  "acceptance criteria",
];

// ---------------------------------------------------------------------------
// extractMarkerFromLog — scan NDJSON session log for REVIEW_RESULT marker
// ---------------------------------------------------------------------------

/**
 * Scans the NDJSON session log for a REVIEW_RESULT marker in assistant messages.
 *
 * Returns "APPROVED", "CHANGES_REQUESTED", or null if no marker is found.
 */
export async function extractMarkerFromLog(
  invocationId: number,
): Promise<"APPROVED" | "CHANGES_REQUESTED" | null> {
  try {
    const logPath = join(process.cwd(), "logs", `${invocationId}.ndjson`);
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "assistant") continue;
        const message = msg.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            if (b.text.includes("REVIEW_RESULT:APPROVED")) return "APPROVED";
            if (b.text.includes("REVIEW_RESULT:CHANGES_REQUESTED"))
              return "CHANGES_REQUESTED";
          }
        }
      } catch {
        /* malformed line — skip */
      }
    }
  } catch {
    /* log unreadable — skip */
  }
  return null;
}

// ---------------------------------------------------------------------------
// worktreeHasNoChanges — check if worktree has no commits ahead of origin/main
// ---------------------------------------------------------------------------

/**
 * Returns true if the worktree at `worktreePath` has no commits ahead of
 * `origin/main`. Used to detect "already done" tasks where Claude succeeded
 * but made no changes (because none were needed).
 */
export async function worktreeHasNoChanges(
  worktreePath: string,
): Promise<boolean> {
  try {
    if (!existsSync(worktreePath)) return false;
    const diff = git(["diff", "origin/main...HEAD"], { cwd: worktreePath });
    return diff.trim() === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// updateAndEmit — update task status in DB and emit SSE event in one call
// ---------------------------------------------------------------------------

/**
 * Update task status in DB and emit SSE event in one call.
 * The task must exist — if not found post-update, emitTaskUpdated is skipped.
 */
export function updateAndEmit(
  db: OrcaDb,
  taskId: string,
  status: TaskStatus,
  reason?: string,
  options?: { failureReason?: string; failedPhase?: string },
): void {
  updateTaskStatus(db, taskId, status, {
    ...(reason ? { reason } : {}),
    ...(options?.failureReason
      ? {
          failureReason: options.failureReason,
          failedPhase: options.failedPhase,
        }
      : {}),
  });
  const task = getTask(db, taskId);
  if (task) emitTaskUpdated(task);
}

// ---------------------------------------------------------------------------
// hasPollingTimedOut — check if startedAt has exceeded timeout
// ---------------------------------------------------------------------------

/**
 * Returns true if the given startedAt ISO timestamp has exceeded the timeout.
 * @param startedAt ISO timestamp string (when the operation started)
 * @param timeoutMin Timeout in minutes
 */
export function hasPollingTimedOut(
  startedAt: string,
  timeoutMin: number,
): boolean {
  const timeoutMs = timeoutMin * 60 * 1000;
  return new Date(startedAt).getTime() + timeoutMs < Date.now();
}

// ---------------------------------------------------------------------------
// transitionToFinalState — write back Linear status and post a comment
// ---------------------------------------------------------------------------

/**
 * Write back Linear status and optionally post a comment, swallowing errors
 * on both. Consolidates the repeated `writeBackStatus + createComment` pattern.
 */
export async function transitionToFinalState(
  deps: { client: LinearClient; stateMap: WorkflowStateMap },
  taskId: string,
  targetStatus: Parameters<typeof writeBackStatus>[2],
  comment?: string,
): Promise<void> {
  await writeBackStatus(deps.client, taskId, targetStatus, deps.stateMap).catch(
    (err: unknown) => {
      log.warn("Linear write-back failed", {
        taskId,
        targetStatus,
        error: String(err),
      });
    },
  );
  if (comment !== undefined) {
    await deps.client.createComment(taskId, comment).catch((err: unknown) => {
      log.warn("Linear createComment failed", { taskId, error: String(err) });
    });
  }
}
