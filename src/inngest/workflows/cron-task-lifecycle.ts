/**
 * Cron task lifecycle — handles cron_claude tasks independently from the main
 * task-lifecycle, with NO concurrency limit so cron tasks always run
 * immediately regardless of how many Linear tasks are in flight.
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
import { spawnSession } from "../../runner/index.js";
import { emitTaskUpdated, emitInvocationStarted } from "../../events.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import { claimSessionSlot } from "../../session-handles.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import {
  bridgeSessionCompletion,
  buildDisallowedTools,
} from "./task-lifecycle.js";
import { getSchedulerDeps } from "../deps.js";

const logger = createLogger("inngest/cron-lifecycle");

function log(message: string): void {
  logger.info(message);
}

const SESSION_TIMEOUT = "60m";
const WORKFLOW_TIMEOUT = "2h";

export const cronTaskLifecycle = inngest.createFunction(
  {
    id: "cron-task-lifecycle",

    // No global concurrency limit — cron tasks bypass the cap.
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

    log(`cron workflow started for task ${taskId}`);

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
      } => {
        const { db, config } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);

        const model = config.implementModel;
        const wtResult = createWorktree(task.repoPath, taskId, 0);
        const { worktreePath, branchName } = wtResult;

        // No assertSessionCapacity — cron tasks bypass concurrency
        claimSessionSlot();

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

        const handle = spawnSession({
          agentPrompt: task.agentPrompt ?? "",
          worktreePath,
          maxTurns: config.defaultMaxTurns,
          invocationId,
          projectRoot: process.cwd(),
          claudePath: config.claudePath,
          appendSystemPrompt: config.implementSystemPrompt || undefined,
          disallowedTools: buildDisallowedTools(config),
          repoPath: task.repoPath,
          model,
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
        updateTaskStatus(db, taskId, "running");
        emitTaskUpdated(getTask(db, taskId)!);

        log(
          `cron task ${taskId}: session spawned as invocation ${invocationId}`,
        );
        return { invocationId, worktreePath, branchName };
      },
    );

    // Step 3: Wait for session to complete
    const sessionEvent = await step.waitForEvent("await-session", {
      event: "session/completed",
      if: `async.data.invocationId == ${implementCtx.invocationId}`,
      timeout: SESSION_TIMEOUT,
    });

    // Step 4: Finalize
    const succeeded = sessionEvent && sessionEvent.data.exitCode === 0;

    const result = await step.run("finalize-cron-task", () => {
      const { db } = getSchedulerDeps();
      const task = getTask(db, taskId);
      if (!task) return { outcome: "permanent_fail" as const };

      if (succeeded) {
        updateTaskStatus(db, taskId, "done");
        emitTaskUpdated(getTask(db, taskId)!);
        log(`cron task ${taskId} completed successfully`);
        return { outcome: "done" as const };
      }

      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      log(
        `cron task ${taskId} failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
      );
      return { outcome: "permanent_fail" as const };
    });

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
  },
);
