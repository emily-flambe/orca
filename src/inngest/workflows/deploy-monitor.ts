import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import { createLogger } from "../../logger.js";
import {
  getTask,
  updateTaskStatus,
  updateTaskFailure,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { getWorkflowRunStatus } from "../../github/index.js";
import { writeBackStatus } from "../../linear/sync.js";
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
      const timeoutMs = deps.config.deployTimeoutMin * 60 * 1000;
      const startedAt = new Date(deployStartedAt).getTime();
      if (startedAt + timeoutMs < Date.now()) {
        await step.run("deploy-timeout", async () => {
          const { db, config, client, stateMap } = getSchedulerDeps();
          updateTaskStatus(db, linearIssueId, "failed");
          updateTaskFailure(
            db,
            linearIssueId,
            `Deploy timed out after ${config.deployTimeoutMin} minutes`,
            "deploy",
          );
          emitTaskUpdated(getTask(db, linearIssueId)!);

          await writeBackStatus(
            client,
            linearIssueId,
            "failed_permanent",
            stateMap,
          );

          await client
            .createComment(
              linearIssueId,
              `Deploy timed out after ${config.deployTimeoutMin}min — task failed permanently`,
            )
            .catch((err) => {
              log(
                `comment failed on deploy timeout for task ${linearIssueId}: ${err}`,
              );
            });

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
          updateTaskStatus(db, linearIssueId, "done");
          emitTaskUpdated(getTask(db, linearIssueId)!);

          await writeBackStatus(client, linearIssueId, "done", stateMap);

          await client
            .createComment(linearIssueId, "Task complete")
            .catch((err) => {
              log(
                `comment failed on done (no SHA) for task ${linearIssueId}: ${err}`,
              );
            });

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
          updateTaskStatus(db, linearIssueId, "done");
          emitTaskUpdated(getTask(db, linearIssueId)!);

          await writeBackStatus(client, linearIssueId, "done", stateMap);

          await client
            .createComment(linearIssueId, "Task complete")
            .catch((err) => {
              log(
                `comment failed on deploy success for task ${linearIssueId}: ${err}`,
              );
            });

          log(
            `task ${linearIssueId} deploy succeeded → done (SHA: ${mergeCommitSha})`,
          );
        });
        resolved = true;
        return { status: "done" };
      } else if (deployStatus.status === "failure") {
        await step.run("deploy-failure", async () => {
          const { db, client, stateMap } = getSchedulerDeps();
          updateTaskStatus(db, linearIssueId, "failed");
          updateTaskFailure(
            db,
            linearIssueId,
            `Deploy CI failed for commit ${mergeCommitSha}`,
            "deploy",
          );
          emitTaskUpdated(getTask(db, linearIssueId)!);

          await writeBackStatus(
            client,
            linearIssueId,
            "failed_permanent",
            stateMap,
          );

          await client
            .createComment(
              linearIssueId,
              `Deploy CI failed for commit ${mergeCommitSha} — task failed permanently`,
            )
            .catch((err) => {
              log(
                `comment failed on deploy failure for task ${linearIssueId}: ${err}`,
              );
            });

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
        updateTaskStatus(db, linearIssueId, "failed");
        updateTaskFailure(
          db,
          linearIssueId,
          `Deploy status never resolved after ${maxPollAttempts} poll attempts`,
          "deploy",
        );
        emitTaskUpdated(getTask(db, linearIssueId)!);

        await writeBackStatus(
          client,
          linearIssueId,
          "failed_permanent",
          stateMap,
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
