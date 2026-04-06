/**
 * Reconcile stuck tasks workflow.
 *
 * Runs every 5 minutes to detect and recover tasks that are stranded in
 * intermediate states with no active session or have been idle too long:
 *
 * - running with no active session handle → stranded, reset to ready/failed
 * - awaiting_ci/deploying older than 30 min → timed-out, reset to ready/failed
 */

import { inngest } from "../client.js";
import { getSchedulerDeps, isReady } from "../deps.js";
import {
  isDraining,
  clearDraining,
  getDrainingForSeconds,
  getDrainingSeconds,
  tickDrainZeroSessions,
  resetDrainZeroSessions,
} from "../../deploy.js";
import {
  getAllTasks,
  countActiveSessions,
  getDispatchableTasks,
  getFailedTasksWithRetriesRemaining,
  getRunningInvocations,
  incrementRetryCount,
  insertSystemEvent,
  updateInvocation,
  updateTaskStatus,
} from "../../db/queries.js";
import { sendAlert, sendAlertThrottled } from "../../scheduler/alerts.js";
import { detectAndAlertStuckTasks } from "../../scheduler/stuck-task-detector.js";
import { writeMonitorSnapshot } from "../../scheduler/monitor-snapshot.js";
import { trackDrainState } from "../../scheduler/drain-state-tracker.js";
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
    const {
      linearIssueId,
      lifecycleStage,
      currentPhase,
      retryCount,
      updatedAt,
    } = task;

    let isStranded = false;
    let reason = "";

    if (lifecycleStage === "active") {
      const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
      const ageMs = now - updatedMs;

      if (currentPhase === "implement") {
        // Implement phase has an active session — check for missing session handle
        const gracePeriodMs = 2 * 60 * 1000; // 2 minutes
        if (ageMs > gracePeriodMs && !liveTaskIds.has(linearIssueId)) {
          isStranded = true;
          reason = `task in stage=${lifecycleStage}, phase=${currentPhase} with no active session handle for ${Math.round(ageMs / 60000)} min`;
        }
      } else {
        // review, fix, ci, deploy — check age threshold
        if (ageMs > thresholdMs) {
          isStranded = true;
          reason = `task in stage=${lifecycleStage}, phase=${currentPhase} for ${Math.round(ageMs / 60000)} min (threshold: ${STRANDED_TASK_THRESHOLD_MIN} min)`;
        }
      }
    }

    if (!isStranded) continue;

    logger.warn(`[${linearIssueId}] stranded task detected: ${reason}`);

    // Increment retry count and decide outcome.
    incrementRetryCount(db, linearIssueId);
    const maxRetries = config.maxRetries;

    const targetStatus = retryCount + 1 > maxRetries ? "failed" : "ready";

    updateTaskStatus(db, linearIssueId, targetStatus, {
      reason: `reconciled_stranded: ${reason}`,
    });

    insertSystemEvent(db, {
      type: "health_check",
      message: `Reconciled stranded task ${linearIssueId}: ${reason} → ${targetStatus}`,
      metadata: {
        linearIssueId,
        previousStatus: currentPhase ?? lifecycleStage,
        targetStatus,
        retryCount: retryCount + 1,
        reason,
      },
    });

    logger.info(
      `[${linearIssueId}] reset to ${targetStatus} (retryCount=${retryCount + 1})`,
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
    await step.run("track-drain-state", async () => {
      if (!isReady()) return;
      const deps = getSchedulerDeps();
      const activeSessions = countActiveSessions(deps.db);
      await trackDrainState(deps, isDraining(), activeSessions);
    });

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
        updateTaskStatus(db, task.linearIssueId, "ready", {
          reason: "auto_retry",
        });
        insertSystemEvent(db, {
          type: "auto_retry",
          message: `Auto-retrying failed task ${task.linearIssueId} (attempts: ${task.retryCount}/${config.maxRetries})`,
          metadata: {
            linearIssueId: task.linearIssueId,
            retryCount: task.retryCount,
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
          `[${task.linearIssueId}] auto-retrying failed task (${task.retryCount}/${config.maxRetries})`,
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

    // Step 5: Check for stuck drain state. If draining=true with zero active
    // sessions for too long, auto-clear and alert.
    await step.run("check-drain-timeout", async () => {
      const deps = getSchedulerDeps();
      const { db, config } = deps;

      if (!isDraining()) {
        resetDrainZeroSessions();
        return;
      }

      const activeSessions = countActiveSessions(db);

      if (activeSessions > 0) {
        // Sessions still running — drain is progressing normally.
        resetDrainZeroSessions();
        return;
      }

      // draining=true AND activeSessions=0
      const drainingSeconds = getDrainingSeconds() ?? 0;
      const consecutiveCount = tickDrainZeroSessions();
      const timeoutSeconds = (config.drainTimeoutMin ?? 10) * 60;

      logger.warn(
        `drain stuck: draining=true, activeSessions=0 for ${drainingSeconds}s (consecutive ticks: ${consecutiveCount})`,
      );

      // Auto-clear if past the timeout
      if (drainingSeconds >= timeoutSeconds) {
        logger.warn(
          `drain timeout exceeded (${drainingSeconds}s >= ${timeoutSeconds}s) — auto-clearing drain flag`,
        );
        clearDraining();

        insertSystemEvent(db, {
          type: "health_check",
          message: `Drain auto-cleared after ${Math.round(drainingSeconds / 60)}min with zero active sessions (timeout: ${config.drainTimeoutMin}min)`,
          metadata: {
            drainingSeconds,
            drainTimeoutMin: config.drainTimeoutMin,
            consecutiveTicks: consecutiveCount,
          },
        });

        sendAlert(deps, {
          severity: "warning",
          title: "Drain auto-cleared (timeout)",
          message: `Instance was draining with 0 active sessions for ${Math.round(drainingSeconds / 60)} min (timeout: ${config.drainTimeoutMin} min). Drain flag auto-cleared — task dispatch resumed.`,
          fields: [
            {
              title: "Drain duration",
              value: `${Math.round(drainingSeconds / 60)} min`,
              short: true,
            },
            {
              title: "Timeout setting",
              value: `${config.drainTimeoutMin} min`,
              short: true,
            },
          ],
        });
        return;
      }

      // Alert if stuck for 2+ consecutive ticks (without auto-clear yet)
      if (consecutiveCount >= 2) {
        sendAlertThrottled(
          deps,
          "drain-stuck-zero-sessions",
          {
            severity: "warning",
            title: "Drain stuck with zero sessions",
            message: `Instance has been draining with 0 active sessions for ${Math.round(drainingSeconds / 60)} min (${consecutiveCount} consecutive reconciler ticks). Expected drain should complete after sessions finish. Auto-clear will trigger at ${config.drainTimeoutMin} min.`,
            fields: [
              {
                title: "Drain duration",
                value: `${Math.round(drainingSeconds / 60)} min`,
                short: true,
              },
              {
                title: "Consecutive ticks",
                value: String(consecutiveCount),
                short: true,
              },
              {
                title: "Auto-clear at",
                value: `${config.drainTimeoutMin} min`,
                short: true,
              },
            ],
          },
          15 * 60 * 1000, // 15 min cooldown between alerts
        );
      }
    });

    // Step 6: Write monitor snapshot — NDJSON file of all tasks,
    // including lastFailureReason (truncated to 80 chars) for failed tasks.
    // Prepends a metadata line when draining.
    await step.run("write-monitor-snapshot", async () => {
      const { db } = getSchedulerDeps();
      const allTasks = getAllTasks(db);
      const drainingForSeconds = getDrainingForSeconds();
      await writeMonitorSnapshot(allTasks, undefined, {
        drainingForSeconds: drainingForSeconds ?? undefined,
      });
    });
  },
);
