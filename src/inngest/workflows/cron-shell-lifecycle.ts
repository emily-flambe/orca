/**
 * Cron shell lifecycle — handles cron_shell tasks created via manual trigger
 * (POST /api/cron/:id/trigger). Executes the shell command directly without
 * worktrees or Claude sessions.
 */

import { execSync } from "node:child_process";
import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("orca/cron-shell-lifecycle");

export const cronShellLifecycle = inngest.createFunction(
  {
    id: "cron-shell-lifecycle",
    retries: 0,
    concurrency: [{ limit: 1, key: "event.data.linearIssueId" }],
    cancelOn: [
      {
        event: "task/cancelled" as const,
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],
    timeouts: { finish: "2h" },
  },
  {
    event: "task/ready" as const,
    if: "event.data.taskType == 'cron_shell'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    logger.info(`cron-shell workflow started for task ${taskId}`);

    // Step 1: Claim task
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

        updateTaskStatus(db, taskId, "running");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);
        return { claimed: true };
      },
    );

    if (!claimResult.claimed) {
      logger.info(
        `cron-shell task ${taskId}: claim failed — ${claimResult.reason}`,
      );
      return { outcome: "not_claimed", reason: claimResult.reason };
    }

    // Step 2: Run shell command
    const result = await step.run(
      "run-shell",
      (): { outcome: "done" | "failed"; output: string | null } => {
        const { db } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) {
          return { outcome: "failed", output: "task not found" };
        }

        const command = task.agentPrompt ?? "";
        if (!command.trim()) {
          updateTaskStatus(db, taskId, "failed");
          const failedTask = getTask(db, taskId);
          if (failedTask) emitTaskUpdated(failedTask);
          logger.error(`cron-shell task ${taskId} failed: empty command`);
          return { outcome: "failed", output: "empty shell command" };
        }

        const cwd = task.repoPath || process.cwd();

        try {
          const stdout = execSync(command, {
            cwd,
            timeout: 60_000,
            stdio: "pipe",
            encoding: "utf8",
            shell: process.platform === "win32" ? "bash" : "/bin/sh",
          });
          const output =
            typeof stdout === "string" ? stdout.slice(0, 10_000) : null;

          updateTaskStatus(db, taskId, "done");
          const doneTask = getTask(db, taskId);
          if (doneTask) emitTaskUpdated(doneTask);
          logger.info(`cron-shell task ${taskId} completed successfully`);
          return { outcome: "done", output };
        } catch (err) {
          let output: string | null = null;
          if (err && typeof err === "object" && "stderr" in err) {
            const stderr = (err as { stderr?: unknown }).stderr;
            if (typeof stderr === "string") {
              output = stderr.slice(0, 10_000);
            }
          }
          if (!output && err instanceof Error) {
            output = err.message.slice(0, 10_000);
          }

          updateTaskStatus(db, taskId, "failed");
          const failedTask = getTask(db, taskId);
          if (failedTask) emitTaskUpdated(failedTask);
          logger.error(`cron-shell task ${taskId} failed: ${err}`);
          return { outcome: "failed", output };
        }
      },
    );

    return { outcome: result.outcome, output: result.output };
  },
);
