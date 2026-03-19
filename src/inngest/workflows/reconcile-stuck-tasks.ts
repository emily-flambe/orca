/**
 * Reconcile stuck tasks workflow.
 *
 * Runs every 5 minutes to detect and recover tasks that are stranded in
 * intermediate states with no active session or have been idle too long:
 *
 * - running with no active session handle → stranded, reset to ready/failed
 * - awaiting_ci/deploying/in_review older than strandedTaskThresholdMin → timed-out, reset to ready/failed
 */

import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  getDispatchableTasks,
  getFailedTasksWithRetriesRemaining,
  getRunningInvocations,
  incrementStaleSessionRetryCount,
  insertSystemEvent,
  updateTaskStatus,
  countActiveSessions,
} from "../../db/queries.js";
import { detectAndAlertStuckTasks } from "../../scheduler/stuck-task-detector.js";
import { activeHandles, sweepExitedHandles } from "../../session-handles.js";
import { createLogger } from "../../logger.js";
import type { OrcaConfig } from "../../config/index.js";
import type { OrcaDb } from "../../db/index.js";
import {
  isDraining,
  checkAndAutoClearDrain,
  recordDrainZeroSnapshot,
  resetDrainZeroSnapshots,
} from "../../deploy.js";
import { sendAlertThrottled } from "../../scheduler/alerts.js";

const logger = createLogger("reconcile");

/**
 * Core reconciliation logic — extracted for testability.
 * Detects stranded tasks and resets them to ready or failed.
 */
export async function runReconciliation(deps: {
  db: OrcaDb;
  config: OrcaConfig;
  activeHandles?: Map<number, unknown>;
}): Promise<{ reconciledCount: number }> {
  sweepExitedHandles();

  const { db, config } = deps;
  const handles = deps.activeHandles ?? activeHandles;
  const thresholdMs = config.strandedTaskThresholdMin * 60 * 1000;
  const now = Date.now();

  // Get all tasks in intermediate states that could be stranded.
  const intermediateTasks = getDispatchableTasks(db, [
    "running",
    "awaiting_ci",
    "deploying",
    "in_review",
    "changes_requested",
  ]);

  if (intermediateTasks.length === 0) {
    logger.debug("no intermediate tasks to reconcile");
    return { reconciledCount: 0 };
  }

  // Build a set of linearIssueIds that have a live session handle.
  // activeHandles is keyed by invocationId. Cross-reference via running
  // invocations in DB to find which tasks have live handles.
  const runningInvocations = getRunningInvocations(db);
  const liveTaskIds = new Set<string>();
  for (const inv of runningInvocations) {
    if (handles.has(inv.id)) {
      liveTaskIds.add(inv.linearIssueId);
    }
  }

  let reconciledCount = 0;

  for (const task of intermediateTasks) {
    const { linearIssueId, orcaStatus, retryCount, updatedAt } = task;

    let isStranded = false;
    let reason = "";

    if (orcaStatus === "running") {
      // Apply a minimum age grace period before declaring stranded.
      // A task may have just been claimed and not yet spawned a session.
      const gracePeriodMs = 2 * 60 * 1000; // 2 minutes
      const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
      const ageMs = now - updatedMs;
      if (ageMs > gracePeriodMs && !liveTaskIds.has(linearIssueId)) {
        isStranded = true;
        reason = `task in ${orcaStatus} with no active session handle for ${Math.round(ageMs / 60000)} min`;
      }
    } else {
      // awaiting_ci, deploying, in_review — check age threshold.
      const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
      const ageMs = now - updatedMs;
      if (ageMs > thresholdMs) {
        isStranded = true;
        reason = `task in ${orcaStatus} for ${Math.round(ageMs / 60000)} min (threshold: ${config.strandedTaskThresholdMin} min)`;
      }
    }

    if (!isStranded) continue;

    logger.warn(`[${linearIssueId}] stranded task detected: ${reason}`);

    // Increment stale retry count and decide outcome.
    const newStaleCount = incrementStaleSessionRetryCount(db, linearIssueId);
    const maxRetries = config.maxRetries;

    // Use total retryCount + stale count to decide if exhausted.
    const totalAttempts = retryCount + newStaleCount;
    const targetStatus = totalAttempts > maxRetries ? "failed" : "ready";

    updateTaskStatus(db, linearIssueId, targetStatus);

    insertSystemEvent(db, {
      type: "health_check",
      message: `Reconciled stranded task ${linearIssueId}: ${reason} → ${targetStatus}`,
      metadata: {
        linearIssueId,
        previousStatus: orcaStatus,
        targetStatus,
        staleRetryCount: newStaleCount,
        totalAttempts,
        reason,
      },
    });

    logger.info(
      `[${linearIssueId}] reset to ${targetStatus} (staleCount=${newStaleCount}, totalAttempts=${totalAttempts})`,
    );

    // Re-emit task/ready for tasks that still have retries remaining.
    if (targetStatus === "ready") {
      await inngest.send({
        name: "task/ready",
        data: {
          linearIssueId,
          repoPath: task.repoPath,
          priority: task.priority,
          projectName: task.projectName ?? null,
          taskType: task.taskType,
          createdAt: task.createdAt,
        },
      });
    }

    reconciledCount++;
  }

  if (reconciledCount > 0) {
    logger.info(`reconciled ${reconciledCount} stranded task(s)`);
  } else {
    logger.debug("no stranded tasks found");
  }

  return { reconciledCount };
}

export const reconcileStuckTasksWorkflow = inngest.createFunction(
  {
    id: "reconcile-stuck-tasks",
    retries: 1,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("reconcile", async () => {
      const { db, config } = getSchedulerDeps();
      await runReconciliation({ db, config });
    });

    await step.run("detect-stuck-tasks", async () => {
      const deps = getSchedulerDeps();
      const tasks = getDispatchableTasks(deps.db, [
        "running",
        "in_review",
        "awaiting_ci",
        "changes_requested",
        "deploying",
      ]);
      await detectAndAlertStuckTasks(deps, tasks);
    });

    await step.run("monitor-drain-state", async () => {
      const { db, config } = getSchedulerDeps();
      const activeSessions = countActiveSessions(db);

      if (!isDraining()) {
        resetDrainZeroSnapshots();
        return;
      }

      // Auto-clear if timed out
      const autoCleared = checkAndAutoClearDrain(
        activeSessions,
        config.drainTimeoutMin,
      );
      if (autoCleared) {
        logger.warn(
          `drain auto-cleared after timeout (${config.drainTimeoutMin} min with 0 sessions)`,
        );
        insertSystemEvent(db, {
          type: "health_check",
          message: `Drain auto-cleared: was draining for >${config.drainTimeoutMin} min with 0 active sessions`,
          metadata: { drainTimeoutMin: config.drainTimeoutMin },
        });
        resetDrainZeroSnapshots();
        return;
      }

      if (activeSessions > 0) {
        resetDrainZeroSnapshots();
        return;
      }

      // draining=true, activeSessions=0 — track consecutive snapshots
      const consecutiveCount = recordDrainZeroSnapshot();
      logger.warn(
        `drain+zero-sessions snapshot #${consecutiveCount} (draining=true, activeSessions=0)`,
      );

      if (consecutiveCount >= 2) {
        const deps = getSchedulerDeps();
        sendAlertThrottled(
          deps,
          "stuck-drain",
          {
            severity: "warning",
            title: "Stuck Drain State",
            message: `Orca has been draining with 0 active sessions for ${consecutiveCount} consecutive snapshots (~${consecutiveCount * 5} min). Deploy may have completed without clearing the drain flag.`,
            fields: [
              {
                title: "Consecutive Snapshots",
                value: String(consecutiveCount),
                short: true,
              },
              {
                title: "Drain Duration",
                value: `~${consecutiveCount * 5} min`,
                short: true,
              },
            ],
          },
          30 * 60 * 1000, // 30 min cooldown
        );
      }
    });

    await step.run("auto-retry-failed-tasks", async () => {
      const { db, config } = getSchedulerDeps();

      if (isDraining()) {
        logger.debug("skipping auto-retry while draining");
        return;
      }

      const failedTasks = getFailedTasksWithRetriesRemaining(
        db,
        config.maxRetries,
      );

      if (failedTasks.length === 0) {
        logger.debug("no failed tasks with retries remaining");
        return;
      }

      for (const task of failedTasks) {
        const totalAttempts = task.retryCount + task.staleSessionRetryCount;
        updateTaskStatus(db, task.linearIssueId, "ready");
        insertSystemEvent(db, {
          type: "auto_retry",
          message: `Auto-retrying failed task ${task.linearIssueId} (attempts: ${totalAttempts}/${config.maxRetries})`,
          metadata: {
            linearIssueId: task.linearIssueId,
            retryCount: task.retryCount,
            staleSessionRetryCount: task.staleSessionRetryCount,
            totalAttempts,
            maxRetries: config.maxRetries,
          },
        });

        await inngest.send({
          name: "task/ready",
          data: {
            linearIssueId: task.linearIssueId,
            repoPath: task.repoPath,
            priority: task.priority,
            projectName: task.projectName ?? null,
            taskType: task.taskType,
            createdAt: task.createdAt,
          },
        });

        logger.info(
          `[${task.linearIssueId}] auto-retrying failed task (${totalAttempts}/${config.maxRetries})`,
        );
      }

      logger.info(
        `auto-retried ${failedTasks.length} failed task(s) with retries remaining`,
      );
    });

    // Step 4: Re-emit task/ready for orphaned ready tasks.
    // Tasks can get stuck in "ready" when their task-lifecycle workflow fails
    // (e.g. capacity check) and no mechanism re-emits the event. This step
    // ensures every ready task has a workflow trying to pick it up.
    // Skipped while draining — new dispatches should not start during a deploy.
    await step.run("re-dispatch-ready-tasks", async () => {
      const { db } = getSchedulerDeps();

      if (isDraining()) {
        logger.debug("skipping re-dispatch of ready tasks while draining");
        return;
      }

      const readyTasks = getDispatchableTasks(db, ["ready"]);

      if (readyTasks.length === 0) {
        logger.debug("no orphaned ready tasks to re-dispatch");
        return;
      }

      for (const task of readyTasks) {
        await inngest.send({
          name: "task/ready",
          data: {
            linearIssueId: task.linearIssueId,
            repoPath: task.repoPath,
            priority: task.priority,
            projectName: task.projectName ?? null,
            taskType: task.taskType,
            createdAt: task.createdAt,
          },
        });
      }

      logger.info(
        `re-dispatched ${readyTasks.length} orphaned ready task(s): ${readyTasks.map((t) => t.linearIssueId).join(", ")}`,
      );
    });
  },
);
