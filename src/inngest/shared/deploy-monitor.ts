/**
 * Shared deploy monitor logic, callable as inline steps within any lifecycle
 * workflow. Extracted from the standalone deploy-monitor workflow (EMI-505).
 *
 * Usage: await runDeployMonitor(step, taskId, mergeCommitSha, deployStartedAt)
 */

import { getSchedulerDeps } from "../deps.js";
import { createLogger } from "../../logger.js";
import { getTask } from "../../db/queries.js";
import {
  updateAndEmit,
  hasPollingTimedOut,
  transitionToFinalState,
} from "../workflow-utils.js";
import { getWorkflowRunStatus } from "../../github/index.js";
import { sendPermanentFailureAlert } from "../../scheduler/alerts.js";
import type { GetStepTools } from "inngest";
import type { InngestClient } from "../client.js";

type Step = GetStepTools<InngestClient>;

const logger = createLogger("deploy-monitor");

function log(message: string): void {
  logger.info(message);
}

export type DeployMonitorResult =
  | { status: "done"; reason?: string }
  | { status: "aborted"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Run the deploy monitor polling loop as inline steps.
 *
 * Polls GitHub Actions workflow runs for the given merge commit SHA.
 * Returns when the deploy succeeds, fails, or times out.
 */
export async function runDeployMonitor(
  step: Step,
  taskId: string,
  mergeCommitSha: string,
  deployStartedAt: string,
): Promise<DeployMonitorResult> {
  let resolved = false;
  let attempts = 0;
  const maxPollAttempts = getSchedulerDeps().config.maxDeployPollAttempts;

  while (!resolved && attempts < maxPollAttempts) {
    attempts++;

    const deps = getSchedulerDeps();
    const task = getTask(deps.db, taskId);
    if (!task) {
      log(`task ${taskId} not found in DB — aborting`);
      return { status: "aborted", reason: "task_not_found" };
    }

    // If task is no longer in deploy phase (e.g. user cancelled), stop polling
    if (task.currentPhase !== "deploy") {
      log(
        `task ${taskId} status changed (stage=${task.lifecycleStage}, phase=${task.currentPhase}) — stopping deploy poll`,
      );
      return { status: "aborted", reason: "status_changed" };
    }

    // Timeout check
    if (
      hasPollingTimedOut(deployStartedAt, deps.config.maxDeployPollAttempts)
    ) {
      await step.run("deploy-timeout", async () => {
        const { db, config, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "failed", "deploy_timeout", {
          failureReason: `Deploy timed out after ${config.maxDeployPollAttempts} minutes`,
          failedPhase: "deploy",
        });
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `Deploy timed out after ${config.maxDeployPollAttempts}min — task failed permanently`,
        );
        log(
          `task ${taskId} deploy timed out after ${config.maxDeployPollAttempts}min`,
        );
      });
      return { status: "failed", reason: "deploy_timeout" };
    }

    // Defensive: no SHA means we can't monitor — mark done
    if (!mergeCommitSha) {
      await step.run("deploy-no-sha", async () => {
        const { db, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "done", "deploy_no_sha");
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "done",
          "Task complete",
        );
        log(
          `task ${taskId} deploying → done (no merge commit SHA, skipping CI check)`,
        );
      });
      return { status: "done", reason: "no_sha" };
    }

    // Poll GitHub Actions
    const deployStatus = await step.run(
      `check-deploy-${attempts}`,
      async (): Promise<{
        status: "pending" | "in_progress" | "success" | "failure" | "no_runs";
      }> => {
        const result = await getWorkflowRunStatus(
          mergeCommitSha,
          task.repoPath,
        );
        return { status: result };
      },
    );

    if (deployStatus.status === "success") {
      await step.run("deploy-success", async () => {
        const { db, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "done", "deploy_succeeded");
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "done",
          "Task complete",
        );
        log(`task ${taskId} deploy succeeded → done (SHA: ${mergeCommitSha})`);
      });
      resolved = true;
      return { status: "done" };
    } else if (deployStatus.status === "failure") {
      await step.run("deploy-failure", async () => {
        const { db, client, stateMap } = getSchedulerDeps();
        updateAndEmit(db, taskId, "failed", "deploy_ci_failed", {
          failureReason: `Deploy CI failed for commit ${mergeCommitSha}`,
          failedPhase: "deploy",
        });
        await transitionToFinalState(
          { client, stateMap },
          taskId,
          "failed_permanent",
          `Deploy CI failed for commit ${mergeCommitSha} — task failed permanently`,
        );
        log(`task ${taskId} deploy failed → failed (SHA: ${mergeCommitSha})`);
      });
      resolved = true;
      return { status: "failed", reason: "deploy_ci_failure" };
    }

    // "pending", "in_progress", "no_runs" — sleep and poll again
    if (!resolved) {
      await step.sleep(`deploy-poll-wait-${attempts}`, "30s");
    }
  }

  if (!resolved) {
    await step.run("deploy-poll-exhausted", async () => {
      const deps = getSchedulerDeps();
      const { db, client, stateMap } = deps;
      updateAndEmit(db, taskId, "failed", "deploy_poll_exhausted", {
        failureReason: `Deploy status never resolved after ${maxPollAttempts} poll attempts`,
        failedPhase: "deploy",
      });
      await transitionToFinalState(
        { client, stateMap },
        taskId,
        "failed_permanent",
      );
      sendPermanentFailureAlert(
        deps,
        taskId,
        `Deploy status never resolved after ${maxPollAttempts} poll attempts`,
      );
      log(`task ${taskId} deploy poll exhausted ${maxPollAttempts} attempts`);
    });
    return { status: "failed", reason: "poll_exhausted" };
  }

  return { status: "done" };
}
