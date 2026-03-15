/**
 * Stuck-task reconciliation workflow.
 *
 * Runs every 5 minutes. Finds tasks that appear to be stuck in intermediate
 * states with no active session handling them, and either resets them to
 * `ready` (for retry) or marks them permanently failed when retries are
 * exhausted.
 */

import { inngest } from "../client.js";
import { sendWithRetry } from "../activities/session-bridge.js";
import { getSchedulerDeps } from "../deps.js";
import { activeHandles } from "../../session-handles.js";
import {
  getDispatchableTasks,
  getAllTasks,
  updateTaskStatus,
  updateTaskFields,
  incrementRetryCount,
  getRunningInvocations,
  updateInvocation,
  insertSystemEvent,
} from "../../db/queries.js";
import { sendPermanentFailureAlert } from "../../scheduler/alerts.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("reconciliation");

export const stuckTaskReconciliationWorkflow = inngest.createFunction(
  { id: "stuck-task-reconciliation", retries: 1 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("reconcile-stuck-tasks", async () => {
      let deps: ReturnType<typeof getSchedulerDeps>;
      try {
        deps = getSchedulerDeps();
      } catch (err) {
        logger.error("[reconcile] deps not initialized, skipping:", err);
        return { reconciled: 0, taskIds: [] };
      }

      const { db, config } = deps;
      const now = Date.now();
      const thresholdMs = config.strandedTaskThresholdMin * 60 * 1000;
      const sessionTimeoutMs = config.sessionTimeoutMin * 60 * 1000;
      const reconciled: string[] = [];

      // Build a map of running invocation IDs per task (used by phases 1 and 2).
      const runningInvocations = getRunningInvocations(db);
      const runningInvocationsByTask = new Map<string, number[]>();
      for (const inv of runningInvocations) {
        const existing = runningInvocationsByTask.get(inv.linearIssueId) ?? [];
        existing.push(inv.id);
        runningInvocationsByTask.set(inv.linearIssueId, existing);
      }

      // -----------------------------------------------------------------------
      // Phase 1: dispatched/running tasks with no active session handle
      //
      // A task in dispatched/running should have a corresponding running
      // invocation with an active handle. If the process died or the Inngest
      // event was lost, there will be no handle. Only recover tasks older than
      // threshold to avoid racing with legitimate startup/dispatch.
      // -----------------------------------------------------------------------
      const activeTasks = getDispatchableTasks(db, ["dispatched", "running"]);
      for (const task of activeTasks) {
        const age = now - new Date(task.updatedAt).getTime();
        if (age < thresholdMs) continue;

        const taskInvocations =
          runningInvocationsByTask.get(task.linearIssueId) ?? [];
        const hasActiveHandle = taskInvocations.some((id) =>
          activeHandles.has(id),
        );

        if (!hasActiveHandle) {
          // Mark orphaned running invocations as failed so DB counts stay accurate.
          const endedAt = new Date().toISOString();
          for (const invId of taskInvocations) {
            updateInvocation(db, invId, {
              status: "failed",
              endedAt,
              outputSummary: "orphaned by reconciliation",
            });
          }

          const reason = `Task stuck in ${task.orcaStatus} for ${Math.round(age / 60000)}min with no active session handle`;

          if (task.retryCount >= config.maxRetries) {
            updateTaskStatus(db, task.linearIssueId, "failed");
            logger.warn(
              `[reconcile] ${task.linearIssueId}: exhausted retries, marked failed (was ${task.orcaStatus})`,
            );
            sendPermanentFailureAlert(deps, task.linearIssueId, reason);
            insertSystemEvent(db, {
              type: "task_failed",
              message: `Reconciliation: task ${task.linearIssueId} permanently failed`,
              metadata: {
                taskId: task.linearIssueId,
                reason,
                retryCount: task.retryCount,
                maxRetries: config.maxRetries,
                previousStatus: task.orcaStatus,
              },
            });
          } else {
            incrementRetryCount(db, task.linearIssueId, "ready");
            logger.warn(
              `[reconcile] ${task.linearIssueId}: no active handle, reset to ready (was ${task.orcaStatus}, retry ${task.retryCount + 1}/${config.maxRetries})`,
            );
            await sendWithRetry("task/ready", {
              linearIssueId: task.linearIssueId,
              repoPath: task.repoPath,
              priority: task.priority,
              projectName: task.projectName ?? null,
              taskType: task.taskType ?? "standard",
              createdAt: task.createdAt,
            });
            insertSystemEvent(db, {
              type: "error",
              message: `Reconciliation: task ${task.linearIssueId} reset to ready`,
              metadata: {
                taskId: task.linearIssueId,
                reason,
                retryCount: task.retryCount,
                previousStatus: task.orcaStatus,
              },
            });
          }
          reconciled.push(task.linearIssueId);
        }
      }

      // -----------------------------------------------------------------------
      // Phase 2: in_review tasks stuck past session timeout + threshold
      //
      // An in_review task should have a review session running. If the session
      // died silently, the task stays in_review forever. Skip tasks that still
      // have an active handle (legitimate long-running review session).
      // -----------------------------------------------------------------------
      const inReviewTasks = getDispatchableTasks(db, ["in_review"]);
      for (const task of inReviewTasks) {
        const age = now - new Date(task.updatedAt).getTime();
        if (age < sessionTimeoutMs + thresholdMs) continue;

        const taskInvocations =
          runningInvocationsByTask.get(task.linearIssueId) ?? [];
        const hasActiveHandle = taskInvocations.some((id) =>
          activeHandles.has(id),
        );
        if (hasActiveHandle) continue;

        const endedAt = new Date().toISOString();
        for (const invId of taskInvocations) {
          updateInvocation(db, invId, {
            status: "failed",
            endedAt,
            outputSummary: "orphaned by reconciliation",
          });
        }

        const reason = `Task stuck in in_review for ${Math.round(age / 60000)}min`;

        if (task.retryCount >= config.maxRetries) {
          updateTaskStatus(db, task.linearIssueId, "failed");
          logger.warn(
            `[reconcile] ${task.linearIssueId}: in_review exhausted retries, marked failed`,
          );
          sendPermanentFailureAlert(deps, task.linearIssueId, reason);
          insertSystemEvent(db, {
            type: "task_failed",
            message: `Reconciliation: task ${task.linearIssueId} permanently failed`,
            metadata: {
              taskId: task.linearIssueId,
              reason,
              retryCount: task.retryCount,
              maxRetries: config.maxRetries,
              previousStatus: task.orcaStatus,
            },
          });
        } else {
          incrementRetryCount(db, task.linearIssueId, "ready");
          logger.warn(
            `[reconcile] ${task.linearIssueId}: in_review timeout, reset to ready (retry ${task.retryCount + 1}/${config.maxRetries})`,
          );
          await sendWithRetry("task/ready", {
            linearIssueId: task.linearIssueId,
            repoPath: task.repoPath,
            priority: task.priority,
            projectName: task.projectName ?? null,
            taskType: task.taskType ?? "standard",
            createdAt: task.createdAt,
          });
          insertSystemEvent(db, {
            type: "error",
            message: `Reconciliation: task ${task.linearIssueId} reset to ready`,
            metadata: {
              taskId: task.linearIssueId,
              reason,
              retryCount: task.retryCount,
              previousStatus: task.orcaStatus,
            },
          });
        }
        reconciled.push(task.linearIssueId);
      }

      // -----------------------------------------------------------------------
      // Phase 3: awaiting_ci/deploying tasks stuck past threshold
      //
      // These are handled by separate Inngest workflows. If those workflows
      // were lost, the task sits here indefinitely. Re-emit the relevant event
      // to kick off a new workflow run, then touch updatedAt to prevent
      // duplicate re-emission on the next cron tick.
      //
      // If required fields are missing (e.g. prBranchName lost), fall back to
      // resetting the task to ready/failed rather than leaving it stuck.
      // -----------------------------------------------------------------------
      const allTasks = getAllTasks(db);
      const awaitingOrDeploying = allTasks.filter(
        (t) => t.orcaStatus === "awaiting_ci" || t.orcaStatus === "deploying",
      );

      for (const task of awaitingOrDeploying) {
        const age = now - new Date(task.updatedAt).getTime();
        if (age < thresholdMs) continue;

        if (task.orcaStatus === "awaiting_ci") {
          if (!task.prBranchName || task.prNumber == null) {
            // Missing required fields — cannot re-emit; fall back to reset.
            const reason = `awaiting_ci but missing prBranchName or prNumber`;
            logger.warn(
              `[reconcile] ${task.linearIssueId}: ${reason}, resetting`,
            );
            if (task.retryCount >= config.maxRetries) {
              updateTaskStatus(db, task.linearIssueId, "failed");
              sendPermanentFailureAlert(deps, task.linearIssueId, reason);
              insertSystemEvent(db, {
                type: "task_failed",
                message: `Reconciliation: task ${task.linearIssueId} permanently failed`,
                metadata: {
                  taskId: task.linearIssueId,
                  reason,
                  retryCount: task.retryCount,
                  maxRetries: config.maxRetries,
                  previousStatus: task.orcaStatus,
                },
              });
            } else {
              incrementRetryCount(db, task.linearIssueId, "ready");
              insertSystemEvent(db, {
                type: "error",
                message: `Reconciliation: task ${task.linearIssueId} reset to ready`,
                metadata: {
                  taskId: task.linearIssueId,
                  reason,
                  retryCount: task.retryCount,
                  previousStatus: task.orcaStatus,
                },
              });
            }
            reconciled.push(task.linearIssueId);
            continue;
          }
          try {
            await inngest.send({
              name: "task/awaiting-ci",
              data: {
                linearIssueId: task.linearIssueId,
                prNumber: task.prNumber,
                prBranchName: task.prBranchName,
                repoPath: task.repoPath,
                ciStartedAt: task.ciStartedAt ?? new Date().toISOString(),
              },
            });
            // Touch updatedAt so we don't re-emit on the next cron tick.
            updateTaskFields(db, task.linearIssueId, {});
            logger.warn(
              `[reconcile] ${task.linearIssueId}: awaiting_ci for ${Math.round(age / 60000)}min, re-emitted task/awaiting-ci`,
            );
            insertSystemEvent(db, {
              type: "error",
              message: `Reconciliation: task ${task.linearIssueId} re-emitted task/awaiting-ci`,
              metadata: {
                taskId: task.linearIssueId,
                ageMin: Math.round(age / 60000),
                previousStatus: task.orcaStatus,
              },
            });
          } catch (err) {
            logger.error(
              `[reconcile] failed to re-emit task/awaiting-ci for ${task.linearIssueId}:`,
              err,
            );
            continue;
          }
        } else {
          // deploying
          if (!task.mergeCommitSha || task.prNumber == null) {
            const reason = `deploying but missing mergeCommitSha or prNumber`;
            logger.warn(
              `[reconcile] ${task.linearIssueId}: ${reason}, resetting`,
            );
            if (task.retryCount >= config.maxRetries) {
              updateTaskStatus(db, task.linearIssueId, "failed");
              sendPermanentFailureAlert(deps, task.linearIssueId, reason);
              insertSystemEvent(db, {
                type: "task_failed",
                message: `Reconciliation: task ${task.linearIssueId} permanently failed`,
                metadata: {
                  taskId: task.linearIssueId,
                  reason,
                  retryCount: task.retryCount,
                  maxRetries: config.maxRetries,
                  previousStatus: task.orcaStatus,
                },
              });
            } else {
              incrementRetryCount(db, task.linearIssueId, "ready");
              insertSystemEvent(db, {
                type: "error",
                message: `Reconciliation: task ${task.linearIssueId} reset to ready`,
                metadata: {
                  taskId: task.linearIssueId,
                  reason,
                  retryCount: task.retryCount,
                  previousStatus: task.orcaStatus,
                },
              });
            }
            reconciled.push(task.linearIssueId);
            continue;
          }
          try {
            await inngest.send({
              name: "task/deploying",
              data: {
                linearIssueId: task.linearIssueId,
                mergeCommitSha: task.mergeCommitSha,
                repoPath: task.repoPath,
                prNumber: task.prNumber,
                deployStartedAt:
                  task.deployStartedAt ?? new Date().toISOString(),
              },
            });
            // Touch updatedAt so we don't re-emit on the next cron tick.
            updateTaskFields(db, task.linearIssueId, {});
            logger.warn(
              `[reconcile] ${task.linearIssueId}: deploying for ${Math.round(age / 60000)}min, re-emitted task/deploying`,
            );
            insertSystemEvent(db, {
              type: "error",
              message: `Reconciliation: task ${task.linearIssueId} re-emitted task/deploying`,
              metadata: {
                taskId: task.linearIssueId,
                ageMin: Math.round(age / 60000),
                previousStatus: task.orcaStatus,
              },
            });
          } catch (err) {
            logger.error(
              `[reconcile] failed to re-emit task/deploying for ${task.linearIssueId}:`,
              err,
            );
            continue;
          }
        }
        reconciled.push(task.linearIssueId);
      }

      if (reconciled.length > 0) {
        logger.info(
          `[reconcile] reconciled ${reconciled.length} stranded task(s): ${reconciled.join(", ")}`,
        );
      }

      return { reconciled: reconciled.length, taskIds: reconciled };
    });
  },
);
