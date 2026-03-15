/**
 * Cron dispatch workflow.
 *
 * Runs every minute to poll cron_schedules for due tasks and dispatch them.
 * - `claude` type: creates a task and sends it through task-lifecycle.
 * - `shell` type: executes the command directly in a child process.
 */

import { execSync } from "node:child_process";
import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  getDueCronSchedules,
  getTask,
  insertTask,
  updateTaskStatus,
  incrementCronRunCount,
  updateCronLastRunStatus,
} from "../../db/queries.js";
import { emitTaskUpdated } from "../../events.js";
import { computeNextRunAt } from "../../cron/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("cron-dispatch");

export const cronDispatchWorkflow = inngest.createFunction(
  {
    id: "cron-dispatch",
    retries: 1,
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    const dueSchedules = await step.run("get-due-schedules", () => {
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      return getDueCronSchedules(db, now);
    });

    if (dueSchedules.length === 0) {
      return { dispatched: 0 };
    }

    logger.info(`found ${dueSchedules.length} due cron schedule(s)`);

    let dispatched = 0;

    for (const schedule of dueSchedules) {
      if (schedule.type === "shell") {
        // Shell cron: execute command directly, no task-lifecycle needed
        await step.run(`run-shell-cron-${schedule.id}`, () => {
          const { db } = getSchedulerDeps();
          try {
            const cwd = schedule.repoPath || process.cwd();
            execSync(schedule.prompt, {
              cwd,
              timeout: 60_000,
              stdio: "pipe",
              shell: process.platform === "win32" ? "bash" : "/bin/sh",
            });
            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "success");
            logger.info(
              `[cron-${schedule.id}] shell command succeeded for "${schedule.name}"`,
            );
          } catch (err) {
            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "failed");
            logger.error(
              `[cron-${schedule.id}] shell command failed for "${schedule.name}": ${err}`,
            );
          }
        });
      } else {
        // Claude cron: create a task and send through task-lifecycle
        await step.run(`dispatch-cron-${schedule.id}`, async () => {
          const { db } = getSchedulerDeps();
          const now = new Date().toISOString();
          const taskId = `cron-${schedule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          try {
            insertTask(db, {
              linearIssueId: taskId,
              agentPrompt: schedule.prompt,
              repoPath: schedule.repoPath ?? "",
              orcaStatus: "ready",
              taskType: "cron_claude",
              cronScheduleId: schedule.id,
              createdAt: now,
              updatedAt: now,
              priority: 0,
              retryCount: 0,
              reviewCycleCount: 0,
              mergeAttemptCount: 0,
              staleSessionRetryCount: 0,
              isParent: 0,
            });

            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "success");

            const cronTask = getTask(db, taskId);
            if (cronTask) {
              await inngest.send({
                name: "task/ready",
                data: {
                  linearIssueId: cronTask.linearIssueId,
                  repoPath: cronTask.repoPath,
                  priority: cronTask.priority,
                  projectName: cronTask.projectName ?? null,
                  taskType: cronTask.taskType ?? "standard",
                  createdAt: cronTask.createdAt,
                },
              });
            }

            logger.info(
              `[cron-${schedule.id}] dispatched task ${taskId} for schedule "${schedule.name}"`,
            );
          } catch (err) {
            updateCronLastRunStatus(db, schedule.id, "failed");
            logger.error(
              `[cron-${schedule.id}] failed to dispatch task for schedule "${schedule.name}": ${err}`,
            );
            throw err;
          }
        });
      }

      dispatched++;
    }

    logger.info(`dispatched ${dispatched} cron task(s)`);
    return { dispatched };
  },
);
