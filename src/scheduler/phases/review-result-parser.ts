// ---------------------------------------------------------------------------
// Review result parser: review marker parsing + state transitions
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import {
  getTask,
  updateTaskStatus,
  updateTaskCiInfo,
  incrementReviewCycleCount,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { removeWorktree } from "../../worktree/index.js";
import { writeBackStatus } from "../../linear/sync.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionResult } from "../../runner/index.js";
import type { SchedulerDeps } from "../index.js";
import type { HandleRetryFn } from "./failure-classifier.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_MARKER_RETRY_LIMIT = 3;

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface ReviewResultParserState {
  noMarkerRetryCounts: Map<string, number>;
  terminalWriteBackTasks: Set<string>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

// ---------------------------------------------------------------------------
// Helper: scan NDJSON log for REVIEW_RESULT marker
// ---------------------------------------------------------------------------

function extractMarkerFromLog(invocationId: number): string | null {
  try {
    const logPath = join(process.cwd(), "logs", `${invocationId}.ndjson`);
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "assistant") continue;
        // Extract all text from assistant message content
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
        // skip malformed JSON lines
      }
    }
  } catch {
    // skip if file unreadable
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function onReviewSuccess(
  deps: SchedulerDeps,
  state: ReviewResultParserState,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
  handleRetryFn: HandleRetryFn,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const { noMarkerRetryCounts, terminalWriteBackTasks } = state;

  const task = getTask(db, taskId);
  if (!task) return;

  const summary = result.outputSummary ?? "";

  // Parse review result marker
  let approved = summary.includes("REVIEW_RESULT:APPROVED");
  let changesRequested = summary.includes("REVIEW_RESULT:CHANGES_REQUESTED");

  // If marker not found in summary, scan the full NDJSON log for assistant messages
  if (!approved && !changesRequested) {
    const markerFromLog = extractMarkerFromLog(invocationId);
    if (markerFromLog === "APPROVED") {
      approved = true;
      log(
        `task ${taskId}: REVIEW_RESULT:APPROVED found in NDJSON log (not in summary)`,
      );
    } else if (markerFromLog === "CHANGES_REQUESTED") {
      changesRequested = true;
      log(
        `task ${taskId}: REVIEW_RESULT:CHANGES_REQUESTED found in NDJSON log (not in summary)`,
      );
    }
  }

  if (approved) {
    noMarkerRetryCounts.delete(taskId);
    // Clean up worktree
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }

    // Transition to awaiting_ci — Orca will poll CI on the PR and merge when it passes
    const ciNow = new Date().toISOString();
    updateTaskCiInfo(db, taskId, { ciStartedAt: ciNow });
    updateTaskStatus(db, taskId, "awaiting_ci");
    emitTaskUpdated(getTask(db, taskId)!);

    // Write-back (no-op for awaiting_ci, Linear stays at "In Review")
    if (!terminalWriteBackTasks.has(taskId)) {
      writeBackStatus(client, taskId, "awaiting_ci", stateMap).catch((err) => {
        log(`write-back failed on review approved for task ${taskId}: ${err}`);
      });
    }

    // Post comment (fire-and-forget)
    client
      .createComment(
        taskId,
        `Review approved — awaiting CI checks on PR #${task.prNumber ?? "?"} before merging`,
      )
      .catch((err) => {
        log(`comment failed on review approved for task ${taskId}: ${err}`);
      });

    log(
      `task ${taskId} review approved → awaiting_ci (invocation ${invocationId}, ` +
        `PR #${task.prNumber ?? "?"})`,
    );
  } else if (changesRequested) {
    noMarkerRetryCounts.delete(taskId);
    if (task.reviewCycleCount < config.maxReviewCycles) {
      // Increment cycle count and send back for fixes
      incrementReviewCycleCount(db, taskId);
      updateTaskStatus(db, taskId, "changes_requested");
      emitTaskUpdated(getTask(db, taskId)!);

      if (!terminalWriteBackTasks.has(taskId)) {
        writeBackStatus(client, taskId, "changes_requested", stateMap).catch(
          (err) => {
            log(
              `write-back failed on changes requested for task ${taskId}: ${err}`,
            );
          },
        );
      }

      // Post changes requested comment (fire-and-forget)
      client
        .createComment(
          taskId,
          `Review requested changes (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        )
        .catch((err) => {
          log(`comment failed on changes requested for task ${taskId}: ${err}`);
        });

      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal failed for invocation ${invocationId}: ${err}`);
      }

      log(
        `task ${taskId} review requested changes → changes_requested ` +
          `(cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
      );
    } else {
      // Review cycles exhausted — leave as in_review for human intervention
      updateTaskStatus(db, taskId, "in_review");
      emitTaskUpdated(getTask(db, taskId)!);

      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal failed for invocation ${invocationId}: ${err}`);
      }

      log(
        `task ${taskId} review cycles exhausted (${config.maxReviewCycles}), ` +
          `leaving as in_review for human intervention`,
      );
    }
  } else {
    // No review result marker found — retry review up to NO_MARKER_RETRY_LIMIT times
    const noMarkerCount = (noMarkerRetryCounts.get(taskId) ?? 0) + 1;
    noMarkerRetryCounts.set(taskId, noMarkerCount);

    if (noMarkerCount >= NO_MARKER_RETRY_LIMIT) {
      // Too many retries without a marker — burn a real retry
      log(
        `task ${taskId}: ${noMarkerCount} reviews without REVIEW_RESULT marker — treating as failure`,
      );
      noMarkerRetryCounts.delete(taskId);
      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      handleRetryFn(
        deps,
        taskId,
        "review completed without REVIEW_RESULT marker after multiple attempts",
        "review",
      );
    } else {
      log(
        `task ${taskId}: review completed but no REVIEW_RESULT marker found (${noMarkerCount}/${NO_MARKER_RETRY_LIMIT}) — retrying review`,
      );
      updateTaskStatus(db, taskId, "in_review");
      emitTaskUpdated(getTask(db, taskId)!);
    }

    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }
  }
}
