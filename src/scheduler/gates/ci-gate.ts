// ---------------------------------------------------------------------------
// CI gate: CI status polling + merge trigger
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import {
  getTask,
  getAwaitingCiTasks,
  updateTaskStatus,
  incrementReviewCycleCount,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { getPrCheckStatus } from "../../github/index.js";
import { writeBackStatus } from "../../linear/sync.js";
import type { SchedulerDeps } from "../index.js";
import {
  mergeAndFinalize,
  type MergeGateState,
  type TriggerParentEvalFn,
  type IsOrcaProjectTaskFn,
  type TriggerSelfDeployFn,
} from "./merge-gate.js";

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface CiGateState {
  ciPollTimes: Map<string, number>;
  terminalWriteBackTasks: Set<string>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function checkPrCi(
  deps: SchedulerDeps,
  state: CiGateState,
  triggerParentEvalFn: TriggerParentEvalFn,
  isOrcaProjectTaskFn: IsOrcaProjectTaskFn,
  triggerSelfDeployFn: TriggerSelfDeployFn,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const { ciPollTimes, terminalWriteBackTasks } = state;
  const mergeState: MergeGateState = { terminalWriteBackTasks };

  const awaitingCi = getAwaitingCiTasks(db);
  if (awaitingCi.length === 0) return;

  const now = Date.now();
  const pollIntervalMs = config.deployPollIntervalSec * 1000;
  const timeoutMs = config.deployTimeoutMin * 60 * 1000;

  for (const task of awaitingCi) {
    const taskId = task.linearIssueId;

    // Throttle: skip if polled too recently
    const lastPoll = ciPollTimes.get(taskId) ?? 0;
    if (now - lastPoll < pollIntervalMs) continue;
    ciPollTimes.set(taskId, now);

    // Timeout check
    if (task.ciStartedAt) {
      const startedAt = new Date(task.ciStartedAt).getTime();
      if (startedAt + timeoutMs < now) {
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        ciPollTimes.delete(taskId);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(`write-back failed on CI timeout for task ${taskId}: ${err}`);
          },
        );

        client
          .createComment(
            taskId,
            `CI timed out after ${config.deployTimeoutMin}min — task failed`,
          )
          .catch((err) => {
            log(`comment failed on CI timeout for task ${taskId}: ${err}`);
          });

        log(`task ${taskId} CI timed out after ${config.deployTimeoutMin}min`);
        continue;
      }
    }

    // No PR number: can't check CI — merge immediately
    if (!task.prNumber) {
      log(
        `task ${taskId} awaiting_ci but no PR number — skipping CI, marking done`,
      );
      await mergeAndFinalize(
        deps,
        mergeState,
        taskId,
        triggerParentEvalFn,
        isOrcaProjectTaskFn,
        triggerSelfDeployFn,
      );
      ciPollTimes.delete(taskId);
      continue;
    }

    // Poll PR check status
    const status = await getPrCheckStatus(task.prNumber, task.repoPath);

    if (status === "success" || status === "no_checks") {
      // CI passed or no checks configured — merge the PR
      await mergeAndFinalize(
        deps,
        mergeState,
        taskId,
        triggerParentEvalFn,
        isOrcaProjectTaskFn,
        triggerSelfDeployFn,
      );
      ciPollTimes.delete(taskId);
    } else if (status === "failure") {
      ciPollTimes.delete(taskId);

      // Check review cycle cap
      if (task.reviewCycleCount < config.maxReviewCycles) {
        incrementReviewCycleCount(db, taskId);
        updateTaskStatus(db, taskId, "changes_requested");
        emitTaskUpdated(getTask(db, taskId)!);

        if (!terminalWriteBackTasks.has(taskId)) {
          writeBackStatus(client, taskId, "changes_requested", stateMap).catch(
            (err) => {
              log(`write-back failed on CI failure for task ${taskId}: ${err}`);
            },
          );
        }

        client
          .createComment(
            taskId,
            `CI failed on PR #${task.prNumber} — requesting fixes (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
          )
          .catch((err) => {
            log(`comment failed on CI failure for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} CI failed → changes_requested ` +
            `(cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        );
      } else {
        // Cycles exhausted — mark as failed
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on CI failure (cycles exhausted) for task ${taskId}: ${err}`,
            );
          },
        );

        client
          .createComment(
            taskId,
            `CI failed and review cycles exhausted (${config.maxReviewCycles}) — task failed permanently`,
          )
          .catch((err) => {
            log(
              `comment failed on CI failure (cycles exhausted) for task ${taskId}: ${err}`,
            );
          });

        log(`task ${taskId} CI failed, cycles exhausted → failed`);
      }
    }
    // "pending" → skip, poll again next interval
  }
}
