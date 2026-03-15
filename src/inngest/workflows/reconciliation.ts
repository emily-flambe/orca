/**
 * Stuck-task reconciliation workflow.
 *
 * Runs every 5 minutes. Finds tasks that appear to be stuck in intermediate
 * states with no active session handling them, and either resets them to
 * `ready` (for retry) or marks them permanently failed when retries are
 * exhausted.
 */

import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import { activeHandles } from "../../session-handles.js";
import {
  getAllTasks,
  getRunningInvocations,
  updateTaskStatus,
  insertSystemEvent,
} from "../../db/queries.js";
import { sendPermanentFailureAlert } from "../../scheduler/alerts.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("reconciliation");

export const stuckTaskReconciliationWorkflow = inngest.createFunction(
  {
    id: "stuck-task-reconciliation",
    retries: 1,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("reconcile-stuck-tasks", async () => {
      const deps = getSchedulerDeps();
      const { db, config } = deps;

      const now = Date.now();
      const sessionThresholdMs = (config.sessionTimeoutMin + 10) * 60 * 1000;
      const deployThresholdMs = (config.deployTimeoutMin + 10) * 60 * 1000;
      const awaitingCiThresholdMs = 3 * 60 * 60 * 1000;

      const allTasks = getAllTasks(db);
      const runningInvocations = getRunningInvocations(db);

      for (const task of allTasks) {
        const taskId = task.linearIssueId;
        const updatedAt = new Date(task.updatedAt).getTime();
        const ageMs = now - updatedAt;

        let shouldReconcile = false;
        let reason = "";

        if (task.orcaStatus === "running" || task.orcaStatus === "dispatched") {
          if (ageMs > sessionThresholdMs) {
            // Check if any running invocation for this task has an active handle
            const taskInvocations = runningInvocations.filter(
              (inv) => inv.linearIssueId === taskId,
            );
            const hasActiveHandle = taskInvocations.some((inv) =>
              activeHandles.has(inv.id),
            );
            if (!hasActiveHandle) {
              shouldReconcile = true;
              reason = `Task stuck in ${task.orcaStatus} for ${Math.round(ageMs / 60000)}min with no active session handle`;
            }
          }
        } else if (task.orcaStatus === "in_review") {
          if (ageMs > sessionThresholdMs) {
            shouldReconcile = true;
            reason = `Task stuck in in_review for ${Math.round(ageMs / 60000)}min`;
          }
        } else if (task.orcaStatus === "awaiting_ci") {
          if (ageMs > awaitingCiThresholdMs) {
            shouldReconcile = true;
            reason = `Task stuck in awaiting_ci for ${Math.round(ageMs / 60000)}min`;
          }
        } else if (task.orcaStatus === "deploying") {
          if (ageMs > deployThresholdMs) {
            shouldReconcile = true;
            reason = `Task stuck in deploying for ${Math.round(ageMs / 60000)}min`;
          }
        }

        if (!shouldReconcile) continue;

        if (task.retryCount >= config.maxRetries) {
          logger.warn(
            `[orca/reconciliation] Task ${taskId} permanently failed (retries exhausted): ${reason}`,
          );
          updateTaskStatus(db, taskId, "failed");
          sendPermanentFailureAlert(deps, taskId, reason);
          insertSystemEvent(db, {
            type: "task_failed",
            message: `Reconciliation: task ${taskId} permanently failed`,
            metadata: {
              taskId,
              reason,
              retryCount: task.retryCount,
              maxRetries: config.maxRetries,
              previousStatus: task.orcaStatus,
            },
          });
        } else {
          logger.info(
            `[orca/reconciliation] Resetting task ${taskId} to ready (retry ${task.retryCount + 1}/${config.maxRetries}): ${reason}`,
          );
          updateTaskStatus(db, taskId, "ready");
          await inngest.send({
            name: "task/ready",
            data: {
              linearIssueId: task.linearIssueId,
              repoPath: task.repoPath,
              priority: task.priority,
              projectName: task.projectName ?? null,
              taskType: task.taskType ?? "standard",
              createdAt: task.createdAt,
            },
          });
          insertSystemEvent(db, {
            type: "error",
            message: `Reconciliation: task ${taskId} reset to ready`,
            metadata: {
              taskId,
              reason,
              retryCount: task.retryCount,
              previousStatus: task.orcaStatus,
            },
          });
        }
      }
    });
  },
);
