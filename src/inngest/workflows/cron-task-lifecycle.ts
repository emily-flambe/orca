/**
 * Cron task lifecycle — handles cron_claude tasks independently from the main
 * task-lifecycle. Cron tasks respect the global concurrency cap just like
 * Linear tasks; if the cap is reached the workflow exits gracefully.
 *
 * Steps: claim → spawn implement → wait → done/fail → cleanup worktree
 */

import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import { emitTaskUpdated, emitInvocationStarted } from "../../events.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import { getHookUrl } from "../../hooks.js";
import { activeHandles } from "../../session-handles.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { runWithLogContext } from "../../logger-context.js";
import { getSchedulerDeps } from "../deps.js";
import {
  assertSessionCapacity,
  bridgeSessionCompletion,
  buildDisallowedTools,
} from "./task-lifecycle.js";
import { interpolateCronPrompt } from "./cron-dispatch.js";
import { finalizeInvocation } from "./finalize-invocation.js";

const logger = createLogger("inngest/cron-lifecycle");

function log(message: string): void {
  logger.info(message);
}

const SESSION_TIMEOUT = "60m";
const WORKFLOW_TIMEOUT = "2h";

export const cronTaskLifecycle = inngest.createFunction(
  {
    id: "cron-task-lifecycle",

    // Cron tasks respect the global concurrency cap (checked in claim + spawn steps).
    // Per-task dedup only.
    concurrency: [{ limit: 1, key: "event.data.linearIssueId" }],

    cancelOn: [
      {
        event: "task/cancelled" as const,
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],

    timeouts: { finish: WORKFLOW_TIMEOUT },
    retries: 0,
  },
  {
    event: "task/ready" as const,
    if: "event.data.taskType == 'cron_claude'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    return runWithLogContext({ taskId }, async () => {
      log(`cron workflow started for task ${taskId}`);

      // Step 1: Claim task
      const claimResult = await step.run(
        "claim-task",
        (): { claimed: boolean; reason?: string } => {
          const { db } = getSchedulerDeps();

          // Enforce concurrency cap — exit gracefully if full
          try {
            assertSessionCapacity(db);
          } catch (err) {
            const reason =
              err instanceof Error ? err.message : "session cap reached";
            return { claimed: false, reason };
          }

          const task = getTask(db, taskId);
          if (!task) return { claimed: false, reason: "task not found" };

          const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
          if (!claimed) {
            return {
              claimed: false,
              reason: `not in ready state (stage=${task.lifecycleStage}, phase=${task.currentPhase})`,
            };
          }

          emitTaskUpdated(getTask(db, taskId)!);
          return { claimed: true };
        },
      );

      if (!claimResult.claimed) {
        log(`cron task ${taskId}: claim failed — ${claimResult.reason}`);
        return { outcome: "not_claimed", reason: claimResult.reason };
      }

      // Step 2: Spawn Claude session
      const implementCtx = await step.run(
        "start-implement",
        (): {
          invocationId: number;
          worktreePath: string;
          branchName: string;
        } | null => {
          const { db, config } = getSchedulerDeps();
          const task = getTask(db, taskId);
          if (!task) throw new Error(`task ${taskId} not found`);

          // Second capacity check — guards against TOCTOU race between claim and spawn.
          // Catch errors gracefully — with retries: 0, a throw kills the workflow
          // permanently and orphans the task.
          try {
            assertSessionCapacity(db);
          } catch (err) {
            const reason =
              err instanceof Error ? err.message : "session cap reached";
            log(
              `cron task ${taskId}: implement spawn blocked (${reason}), resetting to ready`,
            );
            updateTaskStatus(db, taskId, "ready");
            emitTaskUpdated(getTask(db, taskId)!);
            return null;
          }

          const model = config.model;
          const wtResult = createWorktree(task.repoPath, taskId, 0);
          const { worktreePath, branchName } = wtResult;

          const now = new Date().toISOString();
          const invocationId = insertInvocation(db, {
            linearIssueId: taskId,
            startedAt: now,
            status: "running",
            phase: "implement",
            model,
            worktreePath,
            branchName,
            logPath: "logs/0.ndjson",
          });
          updateInvocation(db, invocationId, {
            logPath: `logs/${invocationId}.ndjson`,
          });

          // Re-interpolate at spawn time so the agent always uses the current
          // active port, even if this task was created by a previous instance
          // (before a blue/green deploy changed the active port).
          const handle = spawnSession({
            agentPrompt: interpolateCronPrompt(task.agentPrompt ?? ""),
            worktreePath,
            maxTurns: config.defaultMaxTurns,
            invocationId,
            projectRoot: process.cwd(),
            claudePath: config.claudePath,
            appendSystemPrompt: config.implementSystemPrompt || undefined,
            disallowedTools: buildDisallowedTools(config),
            repoPath: task.repoPath,
            model,
            hookUrl: getHookUrl(invocationId),
          });

          bridgeSessionCompletion(
            invocationId,
            taskId,
            "implement",
            handle,
            branchName,
            worktreePath,
          );

          emitInvocationStarted({ taskId, invocationId });
          emitTaskUpdated(getTask(db, taskId)!);

          log(
            `cron task ${taskId}: session spawned as invocation ${invocationId}`,
          );
          return { invocationId, worktreePath, branchName };
        },
      );

      if (!implementCtx) return { outcome: "capacity_blocked" };

      // Step 3: Wait for session to complete
      const sessionEvent = await step.waitForEvent("await-session", {
        event: "session/completed",
        if: `async.data.invocationId == ${implementCtx.invocationId}`,
        timeout: SESSION_TIMEOUT,
      });

      // Step 4: Finalize
      const timedOut = !sessionEvent;
      const succeeded = sessionEvent && sessionEvent.data.exitCode === 0;

      const result = await step.run("finalize-cron-task", () =>
        runWithLogContext(
          { taskId, invocationId: String(implementCtx.invocationId) },
          () => {
            const { db } = getSchedulerDeps();
            const { invocationId } = implementCtx;
            const task = getTask(db, taskId);
            if (!task) return { outcome: "permanent_fail" as const };

            // On timeout, kill the orphaned Claude process and release resources
            if (timedOut) {
              log(
                `cron task ${taskId}: session timed out (invocation ${invocationId})`,
              );
              const handle = activeHandles.get(invocationId);
              if (handle) {
                killSession(handle).catch((err: unknown) => {
                  logger.warn("killSession failed (cron timeout)", {
                    taskId,
                    invocationId,
                    error: String(err),
                  });
                });
              }
              finalizeInvocation(db, invocationId, "timed_out", {
                outputSummary: `cron session timed out after ${SESSION_TIMEOUT}`,
              });
              updateTaskStatus(db, taskId, "failed", {
                reason: "cron_session_timeout",
                failureReason: `Cron session timed out after ${SESSION_TIMEOUT}`,
                failedPhase: "implement",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              return { outcome: "permanent_fail" as const };
            }

            if (succeeded) {
              finalizeInvocation(db, invocationId, "completed", {
                costUsd: sessionEvent.data.costUsd ?? null,
                inputTokens: sessionEvent.data.inputTokens ?? null,
                outputTokens: sessionEvent.data.outputTokens ?? null,
              });
              updateTaskStatus(db, taskId, "done", {
                reason: "cron_session_succeeded",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              log(`cron task ${taskId} completed successfully`);
              return { outcome: "done" as const };
            }

            finalizeInvocation(db, invocationId, "failed", {
              costUsd: sessionEvent?.data.costUsd ?? null,
              inputTokens: sessionEvent?.data.inputTokens ?? null,
              outputTokens: sessionEvent?.data.outputTokens ?? null,
            });
            updateTaskStatus(db, taskId, "failed", {
              reason: "cron_session_failed",
              failureReason: `Cron session failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
              failedPhase: "implement",
            });
            emitTaskUpdated(getTask(db, taskId)!);
            log(
              `cron task ${taskId} failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
            );
            return { outcome: "permanent_fail" as const };
          },
        ),
      );

      // Step 5: Cleanup worktree
      if (implementCtx.worktreePath) {
        await step.run("cleanup-worktree", () => {
          try {
            removeWorktree(implementCtx.worktreePath);
          } catch (err) {
            log(
              `failed to remove cron worktree ${implementCtx.worktreePath}: ${err}`,
            );
          }
        });
      }

      return { outcome: result.outcome };
    }); // end runWithLogContext({ taskId })
  },
);
