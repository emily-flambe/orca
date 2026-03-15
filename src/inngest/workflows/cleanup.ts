import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  cleanupStaleResources,
  cleanupOldInvocationLogs,
} from "../../cleanup/index.js";
import { sweepExitedHandles } from "../../session-handles.js";
import {
  getDueCronSchedules,
  insertTask,
  getTask,
  incrementCronRunCount,
} from "../../db/queries.js";
import { computeNextRunAt } from "../../cron/index.js";

export const cleanupCronWorkflow = inngest.createFunction(
  {
    id: "cleanup-cron",
    retries: 1,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("dispatch-due-cron-schedules", async () => {
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      const due = getDueCronSchedules(db, now);
      for (const schedule of due) {
        const taskId = `cron-${schedule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        insertTask(db, {
          linearIssueId: taskId,
          agentPrompt: schedule.prompt,
          repoPath: schedule.repoPath ?? "",
          orcaStatus: "ready",
          taskType: schedule.type === "claude" ? "cron_claude" : "cron_shell",
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
        incrementCronRunCount(db, schedule.id, computeNextRunAt(schedule.schedule));
        const cronTask = getTask(db, taskId);
        if (cronTask) {
          try {
            await inngest.send({
              name: "task/ready",
              data: {
                linearIssueId: cronTask.linearIssueId,
                repoPath: cronTask.repoPath,
                priority: cronTask.priority,
                projectName: cronTask.projectName ?? null,
                taskType: cronTask.taskType ?? "cron_claude",
                createdAt: cronTask.createdAt,
              },
            });
          } catch (err: unknown) {
            console.warn(
              `[orca/cleanup] Failed to dispatch cron task ${taskId}:`,
              err,
            );
          }
        }
      }
    });

    await step.run("cleanup", async () => {
      sweepExitedHandles();
      const { db, config } = getSchedulerDeps();
      cleanupStaleResources({ db, config });
      cleanupOldInvocationLogs({ db, config });
    });
  },
);
