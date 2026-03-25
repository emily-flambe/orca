/**
 * Reconcile stuck tasks workflow.
 *
 * Runs every 5 minutes to detect and recover tasks that are stranded in
 * intermediate states with no active session or have been idle too long:
 *
 * - running with no active session handle → stranded, reset to ready/failed
 * - awaiting_ci/deploying/in_review older than 30 min → timed-out, reset to ready/failed
 */

import { inngest } from "../client.js";
import { getSchedulerDeps, isReady } from "../deps.js";
import { isDraining } from "../../deploy.js";
import {
  getAllTasks,
  getDispatchableTasks,
  getFailedTasksWithRetriesRemaining,
  getRunningInvocations,
  incrementStaleSessionRetryCount,
  insertSystemEvent,
  updateInvocation,
  updateTaskStatus,
} from "../../db/queries.js";
import { detectAndAlertStuckTasks } from "../../scheduler/stuck-task-detector.js";
import { writeMonitorSnapshot } from "../../scheduler/monitor-snapshot.js";
import { activeHandles, sweepExitedHandles } from "../../session-handles.js";
import { createLogger } from "../../logger.js";
import type { OrcaConfig } from "../../config/index.js";
import type { OrcaDb } from "../../db/index.js";

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
  const STRANDED_TASK_THRESHOLD_MIN = 30;
  const thresholdMs = STRANDED_TASK_THRESHOLD_MIN * 60 * 1000;
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
        reason = `task in ${orcaStatus} for ${Math.round(ageMs / 60000)} min (threshold: ${STRANDED_TASK_THRESHOLD_MIN} min)`;
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

    updateTaskStatus(db, linearIssueId, targetStatus, {
      reason: `reconciled_stranded: ${reason}`,
    });

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
    // Skip during drain — new instance will pick up ready tasks after it registers.
    if (targetStatus === "ready" && !isDraining()) {
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
      // Skip if deps aren't initialized yet (startup grace period).
      if (!isReady()) return;
      const { db, config } = getSchedulerDeps();
      await runReconciliation({ db, config });
    });

    await step.run("cleanup-orphaned-invocations", async () => {
      const { db } = getSchedulerDeps();
      const runningInvs = getRunningInvocations(db);
      let cleaned = 0;

      for (const inv of runningInvs) {
        // Skip invocations with a live session handle
        if (activeHandles.has(inv.id)) continue;

        // Grace period: don't clean up invocations less than 5 minutes old
        const startedMs = inv.startedAt ? new Date(inv.startedAt).getTime() : 0;
        const ageMs = Date.now() - startedMs;
        if (ageMs < 5 * 60 * 1000) continue;

        updateInvocation(db, inv.id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          outputSummary:
            inv.outputSummary ?? "orphaned: no active session handle",
        });
        cleaned++;
        logger.info(
          `[inv:${inv.id}] cleaned orphaned invocation for ${inv.linearIssueId} (age: ${Math.round(ageMs / 60000)}m)`,
        );
      }

      if (cleaned > 0) {
        logger.info(`cleaned ${cleaned} orphaned invocation(s)`);
      }
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

    await step.run("auto-retry-failed-tasks", async () => {
      const { db, config } = getSchedulerDeps();
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
        updateTaskStatus(db, task.linearIssueId, "ready", {
          reason: "auto_retry",
        });
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
    await step.run("re-dispatch-ready-tasks", async () => {
      const { db } = getSchedulerDeps();
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

    // Step 5: Write monitor snapshot — NDJSON file of all tasks,
    // including lastFailureReason (truncated to 80 chars) for failed tasks.
    await step.run("write-monitor-snapshot", async () => {
      const { db } = getSchedulerDeps();
      const allTasks = getAllTasks(db);
      await writeMonitorSnapshot(allTasks);
    });
  },
);
