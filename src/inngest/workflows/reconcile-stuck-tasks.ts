/**
 * Reconcile stuck tasks workflow.
 *
 * Runs every 5 minutes to detect and recover tasks that are stranded in
 * intermediate states with no active session or have been idle too long:
 *
 * - running with no active session handle → stranded, reset to ready/failed
 * - awaiting_ci/deploying/in_review older than strandedTaskThresholdMin → timed-out, reset to ready/failed
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import { isDraining, getDrainingForSeconds, clearDraining } from "../../deploy.js";
import { sendAlertThrottled } from "../../scheduler/alerts.js";
import type { OrcaConfig } from "../../config/index.js";
import type { OrcaDb } from "../../db/index.js";

const logger = createLogger("reconcile");

// ---------------------------------------------------------------------------
// Drain tracking state (persisted to file across Inngest invocations)
// ---------------------------------------------------------------------------

interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstSeenAt: string | null;
}

const DRAIN_TRACKING_FILE = path.join(
  process.cwd(),
  "tmp",
  "drain-tracking.json",
);

async function readDrainTrackingState(): Promise<DrainTrackingState> {
  try {
    const raw = await fs.readFile(DRAIN_TRACKING_FILE, "utf-8");
    return JSON.parse(raw) as DrainTrackingState;
  } catch {
    return { consecutiveZeroSessionSnapshots: 0, firstSeenAt: null };
  }
}

async function writeDrainTrackingState(
  state: DrainTrackingState,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(DRAIN_TRACKING_FILE), { recursive: true });
    await fs.writeFile(DRAIN_TRACKING_FILE, JSON.stringify(state), "utf-8");
  } catch (err) {
    logger.warn(`drain tracking: failed to write state file: ${err}`);
  }
}

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

    // Step 5: Alert if drain flag is stuck (draining=true with 0 active sessions
    // for 2+ consecutive reconcile snapshots). Runs before the auto-clear step so
    // we can alert before potentially clearing.
    await step.run("alert-stuck-drain", async () => {
      const deps = getSchedulerDeps();
      const draining = isDraining();
      const activeSessions = countActiveSessions(deps.db);

      const state = await readDrainTrackingState();

      if (!draining || activeSessions > 0) {
        // Not stuck — reset tracking
        if (state.consecutiveZeroSessionSnapshots > 0) {
          await writeDrainTrackingState({
            consecutiveZeroSessionSnapshots: 0,
            firstSeenAt: null,
          });
        }
        return;
      }

      // draining=true and activeSessions=0 — increment counter
      const newCount = state.consecutiveZeroSessionSnapshots + 1;
      const firstSeenAt = state.firstSeenAt ?? new Date().toISOString();
      await writeDrainTrackingState({
        consecutiveZeroSessionSnapshots: newCount,
        firstSeenAt,
      });

      if (newCount === 2) {
        const durationMin = Math.round(
          (Date.now() - new Date(firstSeenAt).getTime()) / 60000,
        );
        sendAlertThrottled(
          deps,
          "stuck-drain",
          {
            severity: "warning",
            title: "Drain Flag Stuck",
            message: `Orca has been draining for ${durationMin} min with 0 active sessions. deploy.sh may have died mid-deploy. Drain will auto-clear after ${deps.config.drainTimeoutMin} min.`,
          },
          60 * 60 * 1000, // 60-minute cooldown
        );
        logger.warn(
          `stuck drain alert: draining=true with 0 active sessions for ${newCount} consecutive snapshots`,
        );
      }
    });

    // Step 6: Auto-clear drain flag if it has been set for longer than
    // drainTimeoutMin with zero active sessions. This recovers from a
    // mid-deploy crash of deploy.sh that left the drain flag set forever.
    // Controlled by ORCA_DRAIN_TIMEOUT_MIN (default: 10 min).
    await step.run("check-drain-timeout", async () => {
      const deps = getSchedulerDeps();

      if (!isDraining()) return;

      const drainingForSeconds = getDrainingForSeconds();
      if (drainingForSeconds === null) return;

      const drainTimeoutSec = deps.config.drainTimeoutMin * 60;
      const activeSessions = countActiveSessions(deps.db);

      if (drainingForSeconds > drainTimeoutSec && activeSessions === 0) {
        logger.warn(
          `drain timeout: draining for ${drainingForSeconds}s with 0 active sessions — auto-clearing drain flag`,
        );
        clearDraining();
        insertSystemEvent(deps.db, {
          type: "health_check",
          message: `Auto-cleared stuck drain flag after ${Math.round(drainingForSeconds / 60)} min with 0 active sessions`,
          metadata: {
            drainingForSeconds,
            activeSessions,
            drainTimeoutMin: deps.config.drainTimeoutMin,
          },
        });
        sendAlertThrottled(
          deps,
          "drain-timeout",
          {
            severity: "warning",
            title: "Drain Timeout Auto-Cleared",
            message: `Orca was draining for ${Math.round(drainingForSeconds / 60)} min with 0 active sessions. Drain flag auto-cleared to unblock ready tasks.`,
          },
          30 * 60 * 1000, // 30-minute cooldown
        );
      }
    });
  },
);
