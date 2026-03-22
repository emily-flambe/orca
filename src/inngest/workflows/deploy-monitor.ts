import { inngest } from "../client.js";
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

const logger = createLogger("deploy-monitor");

function log(message: string): void {
  logger.info(message);
}

export const deployMonitorWorkflow = inngest.createFunction(
  {
    id: "deploy-monitor",
    retries: 0,
    timeouts: { finish: "30m" },
    cancelOn: [
      {
        event: "task/cancelled",
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],
  },
  { event: "task/deploying" },
  async ({ event, step }) => {
    const { linearIssueId, mergeCommitSha, deployStartedAt } = event.data;

    let resolved = false;
    let attempts = 0;
    const maxPollAttempts = getSchedulerDeps().config.maxDeployPollAttempts;

    while (!resolved && attempts < maxPollAttempts) {
      attempts++;

      const deps = getSchedulerDeps();
      const task = getTask(deps.db, linearIssueId);
      if (!task) {
        log(`task ${linearIssueId} not found in DB — aborting`);
        return { status: "aborted", reason: "task_not_found" };
      }

      // If task is no longer deploying (e.g. user cancelled), stop polling
      if (task.orcaStatus !== "deploying") {
        log(
          `task ${linearIssueId} status changed to ${task.orcaStatus} — stopping deploy poll`,
        );
        return { status: "aborted", reason: "status_changed" };
      }

      // Timeout check
      if (hasPollingTimedOut(deployStartedAt, deps.config.deployTimeoutMin)) {
        await step.run("deploy-timeout", async () => {
          const { db, config, client, stateMap } = getSchedulerDeps();
          updateAndEmit(db, linearIssueId, "failed", "deploy_timeout");
          await transitionToFinalState(
            { client, stateMap },
            linearIssueId,
            "failed_permanent",
            `Deploy timed out after ${config.deployTimeoutMin}min — task failed permanently`,
          );
          log(
            `task ${linearIssueId} deploy timed out after ${config.deployTimeoutMin}min`,
          );
        });
        return { status: "failed", reason: "deploy_timeout" };
      }

      // Defensive: no SHA means we can't monitor — mark done
      if (!mergeCommitSha) {
        await step.run("deploy-no-sha", async () => {
          const { db, client, stateMap } = getSchedulerDeps();
          updateAndEmit(db, linearIssueId, "done", "deploy_no_sha");
          await transitionToFinalState(
            { client, stateMap },
            linearIssueId,
            "done",
            "Task complete",
          );
          log(
            `task ${linearIssueId} deploying → done (no merge commit SHA, skipping CI check)`,
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
          updateAndEmit(db, linearIssueId, "done", "deploy_succeeded");
          await transitionToFinalState(
            { client, stateMap },
            linearIssueId,
            "done",
            "Task complete",
          );
          log(
            `task ${linearIssueId} deploy succeeded → done (SHA: ${mergeCommitSha})`,
          );
        });
        resolved = true;
        return { status: "done" };
      } else if (deployStatus.status === "failure") {
        await step.run("deploy-failure", async () => {
          const { db, client, stateMap } = getSchedulerDeps();
          updateAndEmit(db, linearIssueId, "failed", "deploy_ci_failed");
          await transitionToFinalState(
            { client, stateMap },
            linearIssueId,
            "failed_permanent",
            `Deploy CI failed for commit ${mergeCommitSha} — task failed permanently`,
          );
          log(
            `task ${linearIssueId} deploy failed → failed (SHA: ${mergeCommitSha})`,
          );
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
        updateAndEmit(db, linearIssueId, "failed", "deploy_poll_exhausted");
        await transitionToFinalState(
          { client, stateMap },
          linearIssueId,
          "failed_permanent",
        );
        sendPermanentFailureAlert(
          deps,
          linearIssueId,
          `Deploy status never resolved after ${maxPollAttempts} poll attempts`,
        );
        log(
          `task ${linearIssueId} deploy poll exhausted ${maxPollAttempts} attempts`,
        );
      });
      return { status: "failed", reason: "poll_exhausted" };
    }

    return { status: "done" };
  },
);
