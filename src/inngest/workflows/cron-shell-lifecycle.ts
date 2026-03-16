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
import { getDeps } from "./task-lifecycle.js";

const logger = createLogger("inngest/cron-shell-lifecycle");

export const cronShellLifecycle = inngest.createFunction(
  {
    id: "cron-shell-lifecycle",
    retries: 0,
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
        const { db } = getDeps();
        const task = getTask(db, taskId);
        if (!task) return { claimed: false, reason: "task not found" };

        const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
        if (!claimed) {
          return {
            claimed: false,
            reason: `not in ready state (current: ${task.orcaStatus})`,
          };
        }

        emitTaskUpdated(getTask(db, taskId)!);
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
        const { db } = getDeps();
        const task = getTask(db, taskId);
        if (!task) return { success: false, error: "task not found" };

        const command = task.agentPrompt ?? "";
        const cwd = task.repoPath || process.cwd();
        if (!task.repoPath) {
          logger.warn(
            `cron-shell task ${taskId}: no repoPath set, falling back to process.cwd() (${cwd})`,
          );
        }

        updateTaskStatus(db, taskId, "running");
        emitTaskUpdated(getTask(db, taskId)!);

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
      const { db } = getDeps();

      if (execResult.success) {
        updateTaskStatus(db, taskId, "done");
        emitTaskUpdated(getTask(db, taskId)!);
        logger.info(`cron-shell task ${taskId} completed successfully`);
      } else {
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        logger.info(`cron-shell task ${taskId} failed: ${execResult.error}`);
      }
    });

    return { outcome: execResult.success ? "done" : "failed" };
  },
);
