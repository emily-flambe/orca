/**
 * Cron shell lifecycle — handles cron_shell tasks triggered manually via the
 * API trigger endpoint. Scheduled shell runs are handled directly by
 * cron-dispatch (execSync inline); this workflow handles the manual trigger
 * path where a task record is created and a task/ready event is emitted.
 *
 * Steps: claim → execute shell command → done/fail
 */

import { execSync } from "node:child_process";
import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { getSchedulerDeps } from "../deps.js";

const logger = createLogger("inngest/cron-shell-lifecycle");

export const cronShellLifecycle = inngest.createFunction(
  {
    id: "cron-shell-lifecycle",
    retries: 3,
    concurrency: [
      {
        limit: 1,
        key: `event.data.cronScheduleId`,
      },
    ],
    cancelOn: [
      {
        event: "task/cancelled" as const,
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],
  },
  {
    event: "task/ready" as const,
    if: "event.data.taskType == 'cron_shell'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    logger.info(`cron-shell workflow started for task ${taskId}`);

    // Step 1: Claim task (ready → dispatched)
    const claimResult = await step.run(
      "claim-task",
      (): { claimed: boolean; reason?: string } => {
        const { db } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) return { claimed: false, reason: "task not found" };

        const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
        if (!claimed) {
          return {
            claimed: false,
            reason: `not in ready state (current: ${task.orcaStatus})`,
          };
        }

        const claimedTask = getTask(db, taskId);
        if (claimedTask) emitTaskUpdated(claimedTask);
        return { claimed: true };
      },
    );

    if (!claimResult.claimed) {
      logger.info(
        `cron-shell task ${taskId}: claim failed — ${claimResult.reason}`,
      );
      return { outcome: "not_claimed", reason: claimResult.reason };
    }

    // Step 2: Execute shell command
    const execResult = await step.run(
      "execute-shell",
      (): { success: boolean; error?: string } => {
        const { db } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) return { success: false, error: "task not found" };

        // Guard: command must not be empty
        const command = (task.agentPrompt ?? "").trim();
        if (!command) {
          return {
            success: false,
            error: "agentPrompt is empty — cannot execute shell command",
          };
        }

        // Guard: repoPath should be set (warn but allow fallback)
        const cwd = task.repoPath || process.cwd();
        if (!task.repoPath) {
          logger.warn(
            `cron-shell task ${taskId}: no repoPath set, falling back to process.cwd() (${cwd})`,
          );
        }

        updateTaskStatus(db, taskId, "running");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);

        try {
          execSync(command, {
            cwd,
            timeout: 60_000,
            stdio: "pipe",
            shell: process.platform === "win32" ? "bash" : "/bin/sh",
          });
          return { success: true };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    );

    // Step 3: Finalize status
    await step.run("finalize", () => {
      const { db } = getSchedulerDeps();

      if (execResult.success) {
        updateTaskStatus(db, taskId, "done");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);
        logger.info(`cron-shell task ${taskId} completed successfully`);
      } else {
        updateTaskStatus(db, taskId, "failed");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);
        logger.info(`cron-shell task ${taskId} failed: ${execResult.error}`);
      }
    });

    return { outcome: execResult.success ? "done" : "failed" };
  },
);
