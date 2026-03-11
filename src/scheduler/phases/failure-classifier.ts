// ---------------------------------------------------------------------------
// Failure classifier: failure triage (rate limit, stale, content filter, max-turns)
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import {
  getTask,
  updateTaskStatus,
  updateInvocation,
  incrementStaleSessionRetryCount,
  getLastCompletedImplementInvocation,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { removeWorktree } from "../../worktree/index.js";
import { writeBackStatus } from "../../linear/sync.js";
import type { SessionResult } from "../../runner/index.js";
import type { DispatchPhase, SchedulerDeps } from "../index.js";

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface FailureClassifierState {
  rateLimitCooldowns: Map<string, number>;
  terminalWriteBackTasks: Set<string>;
}

// ---------------------------------------------------------------------------
// Callback type for handleRetry (stays in index.ts)
// ---------------------------------------------------------------------------

export type HandleRetryFn = (
  deps: SchedulerDeps,
  taskId: string,
  summary?: string,
  phase?: DispatchPhase,
) => void;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function onSessionFailure(
  deps: SchedulerDeps,
  state: FailureClassifierState,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
  phase: DispatchPhase,
  isFixPhase = false,
  handleRetryFn?: HandleRetryFn,
): void {
  const { db, config, client, stateMap } = deps;
  const { rateLimitCooldowns, terminalWriteBackTasks } = state;

  log(
    `task ${taskId} failed (invocation ${invocationId}, ` +
      `subtype: ${result.subtype}, summary: ${result.outputSummary})`,
  );

  // Rate-limited: re-queue without burning a retry slot.
  if (result.subtype === "rate_limited") {
    // Record cooldown expiry if we know when the limit resets.
    if (result.rateLimitResetsAt) {
      const expiresAt = new Date(result.rateLimitResetsAt).getTime();
      if (!isNaN(expiresAt)) {
        rateLimitCooldowns.set(taskId, expiresAt);
      }
    }

    // Put task back in the queue for the same phase, without incrementing retryCount.
    const requeueStatus =
      phase === "review" ? ("in_review" as const) : ("ready" as const);
    updateTaskStatus(db, taskId, requeueStatus);
    emitTaskUpdated(getTask(db, taskId)!);

    client
      .createComment(
        taskId,
        `Rate limited (${result.outputSummary}) — will retry automatically when quota resets`,
      )
      .catch((err) => {
        log(`comment failed on rate limit for task ${taskId}: ${err}`);
      });

    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on rate limit for invocation ${invocationId}: ${err}`,
      );
    }
    return;
  }

  // Stale session resume — clear session ID and re-dispatch fresh instead of burning a retry
  if (
    result.subtype === "error_during_execution" &&
    result.outputSummary?.includes("No conversation found with session ID")
  ) {
    log(
      `task ${taskId}: stale session detected — clearing session and re-dispatching fresh`,
    );
    // Clear the stale session from the CURRENT invocation
    updateInvocation(db, invocationId, {
      sessionId: null,
    });
    // Also clear the session from the ORIGINAL completed invocation that provided
    // the session ID, so getLastCompletedImplementInvocation won't return it again
    const sourceInv = getLastCompletedImplementInvocation(db, taskId);
    if (sourceInv) {
      log(
        `task ${taskId}: clearing stale session from source invocation ${sourceInv.id}`,
      );
      updateInvocation(db, sourceInv.id, { sessionId: null });
    }
    // Increment stale-session retry counter and cap at 3 to prevent runaway loops
    const staleRetries = incrementStaleSessionRetryCount(db, taskId);
    const maxStaleSessionRetries = 3;
    if (staleRetries >= maxStaleSessionRetries) {
      log(
        `task ${taskId}: stale session retry limit reached (${staleRetries}/${maxStaleSessionRetries}) — permanently failing`,
      );
      updateTaskStatus(db, taskId, "failed");
      const failedTask = getTask(db, taskId);
      emitTaskUpdated(failedTask!);
      client
        .createComment(
          taskId,
          `Task permanently failed: stale session detected ${staleRetries} times in a row. The Claude session cannot be resumed — manual intervention required.`,
        )
        .catch((err) => {
          log(`comment failed on stale session cap for task ${taskId}: ${err}`);
        });
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(
          `worktree removal on stale session cap for invocation ${invocationId}: ${err}`,
        );
      }
      return;
    }

    // Re-queue without burning a retry
    const staleTask = getTask(db, taskId);
    const requeueStatus =
      phase === "review"
        ? ("in_review" as const)
        : staleTask && staleTask.reviewCycleCount > 0
          ? ("changes_requested" as const)
          : ("ready" as const);
    updateTaskStatus(db, taskId, requeueStatus);
    emitTaskUpdated(staleTask!);
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on stale session for invocation ${invocationId}: ${err}`,
      );
    }
    return;
  }

  // Content filtering: permanent failure — retries are futile (same prompt → same block)
  if (
    result.outputSummary?.includes("Output blocked by content filtering policy")
  ) {
    log(
      `task ${taskId}: content filtering — permanently failing without retries (retries would be futile)`,
    );
    updateTaskStatus(db, taskId, "failed");
    emitTaskUpdated(getTask(db, taskId)!);
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on content filter for invocation ${invocationId}: ${err}`,
      );
    }
    terminalWriteBackTasks.add(taskId);
    writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
      (err) => {
        log(`write-back failed on content filter for task ${taskId}: ${err}`);
      },
    );
    client
      .createComment(
        taskId,
        `Task permanently failed: output blocked by Claude's content filtering policy. Retries skipped — the same prompt would produce the same result.`,
      )
      .catch((err) => {
        log(`comment failed on content filter for task ${taskId}: ${err}`);
      });
    return;
  }

  updateTaskStatus(db, taskId, "failed");
  emitTaskUpdated(getTask(db, taskId)!);

  // Preserve worktree for resume when max turns hit on fresh implement phase.
  // Fix sessions (implement on changes_requested) create their own fresh worktree
  // from the PR branch but still resume the previous session via sessionId.
  const preserveForResume =
    result.subtype === "error_max_turns" &&
    config.resumeOnMaxTurns &&
    phase === "implement" &&
    !isFixPhase;

  if (preserveForResume) {
    log(`preserving worktree for resume: ${worktreePath}`);
  } else {
    // Clean up worktree so retries start fresh
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal on failure for invocation ${invocationId}: ${err}`);
    }
  }

  // Retry logic — review failures retry as in_review, not ready
  if (handleRetryFn) {
    handleRetryFn(deps, taskId, result.outputSummary, phase);
  }
}
