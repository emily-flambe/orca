// ---------------------------------------------------------------------------
// Deploy gate: deploy workflow polling
// ---------------------------------------------------------------------------
// Extracted from src/scheduler/index.ts — pure refactor, no behavior change.

import {
  getTask,
  getDeployingTasks,
  updateTaskStatus,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { getWorkflowRunStatus } from "../../github/index.js";
import { writeBackStatus } from "../../linear/sync.js";
import type { SchedulerDeps } from "../index.js";
import type {
  TriggerParentEvalFn,
  IsOrcaProjectTaskFn,
  TriggerSelfDeployFn,
} from "./merge-gate.js";

// ---------------------------------------------------------------------------
// Mutable state that must be threaded through
// ---------------------------------------------------------------------------

export interface DeployGateState {
  deployPollTimes: Map<string, number>;
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

export async function checkDeployments(
  deps: SchedulerDeps,
  state: DeployGateState,
  triggerParentEvalFn: TriggerParentEvalFn,
  isOrcaProjectTaskFn: IsOrcaProjectTaskFn,
  triggerSelfDeployFn: TriggerSelfDeployFn,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const { deployPollTimes, terminalWriteBackTasks } = state;

  if (config.deployStrategy === "none") return;

  const deploying = getDeployingTasks(db);
  if (deploying.length === 0) return;

  const now = Date.now();
  const pollIntervalMs = config.deployPollIntervalSec * 1000;
  const timeoutMs = config.deployTimeoutMin * 60 * 1000;

  for (const task of deploying) {
    const taskId = task.linearIssueId;

    // Throttle: skip if polled too recently
    const lastPoll = deployPollTimes.get(taskId) ?? 0;
    if (now - lastPoll < pollIntervalMs) continue;
    deployPollTimes.set(taskId, now);

    // Timeout check
    if (task.deployStartedAt) {
      const startedAt = new Date(task.deployStartedAt).getTime();
      if (startedAt + timeoutMs < now) {
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        deployPollTimes.delete(taskId);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on deploy timeout for task ${taskId}: ${err}`,
            );
          },
        );

        // Post deploy timeout comment (fire-and-forget)
        client
          .createComment(
            taskId,
            `Deploy timed out after ${config.deployTimeoutMin}min — task failed permanently`,
          )
          .catch((err) => {
            log(`comment failed on deploy timeout for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} deploy timed out after ${config.deployTimeoutMin}min`,
        );
        continue;
      }
    }

    // Defensive: no SHA means we can't monitor — mark done with warning
    if (!task.mergeCommitSha) {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy (no SHA) for task ${taskId}: ${err}`);
      });

      client.createComment(taskId, "Task complete").catch((err) => {
        log(`comment failed on done (no SHA) for task ${taskId}: ${err}`);
      });

      log(
        `task ${taskId} deploying → done (no merge commit SHA, skipping CI check)`,
      );
      triggerParentEvalFn(deps, taskId);
      continue;
    }

    // Poll GitHub Actions
    const status = await getWorkflowRunStatus(
      task.mergeCommitSha,
      task.repoPath,
    );

    if (status === "success") {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy success for task ${taskId}: ${err}`);
      });

      // Post done comment (fire-and-forget)
      client.createComment(taskId, "Task complete").catch((err) => {
        log(`comment failed on deploy success for task ${taskId}: ${err}`);
      });

      log(
        `task ${taskId} deploy succeeded → done (SHA: ${task.mergeCommitSha})`,
      );
      triggerParentEvalFn(deps, taskId);

      // Self-deploy: if this task's repo is the Orca project, restart with new code
      if (isOrcaProjectTaskFn(task.repoPath)) {
        triggerSelfDeployFn();
      }
    } else if (status === "failure") {
      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
        (err) => {
          log(`write-back failed on deploy failure for task ${taskId}: ${err}`);
        },
      );

      // Post deploy failure comment (fire-and-forget)
      client
        .createComment(
          taskId,
          `Deploy CI failed for commit ${task.mergeCommitSha} — task failed permanently`,
        )
        .catch((err) => {
          log(`comment failed on deploy failure for task ${taskId}: ${err}`);
        });

      log(
        `task ${taskId} deploy failed → failed (SHA: ${task.mergeCommitSha})`,
      );
    }
    // "pending", "in_progress", "no_runs" → skip, poll again next interval
  }
}
