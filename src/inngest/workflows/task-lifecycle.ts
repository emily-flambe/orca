// ---------------------------------------------------------------------------
// Task lifecycle Inngest workflow
//
// Replaces the scheduler's dispatch + phase handlers with a durable,
// step-based workflow. Uses step.waitForEvent() for 45-min Claude sessions
// so the workflow is resilient to server restarts and crashes.
//
// Trigger: task/ready
// Steps:  token budget check → spawn implement → wait → Gate 2
//         → review loop (spawn review → wait → parse → spawn fix → wait → repeat)
//         → transition to awaiting_ci
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getHookUrl } from "../../hooks.js";
import type { OrcaDb } from "../../db/index.js";
import type { OrcaConfig } from "../../config/index.js";
import {
  getTask,
  getInvocation,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  sumTokensInWindow,
  budgetWindowStart,
  incrementRetryCount,
  incrementReviewCycleCount,
  updateTaskPrBranch,
  updateTaskPrState,
  updateTaskCiInfo,
  updateTaskDeployInfo,
  updateTaskFixReason,
  getLastMaxTurnsInvocation,
  getLastDeployInterruptedInvocation,
  getLastCompletedImplementInvocation,
  insertSystemEvent,
  clearSessionIds,
  resetStaleSessionRetryCount,
  countActiveSessions,
  countActiveAgentSessions,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import type { SessionHandle, McpServerConfig } from "../../runner/index.js";
import {
  emitTaskUpdated,
  emitInvocationStarted,
  emitInvocationCompleted,
} from "../../events.js";
import {
  sendAlert,
  sendAlertThrottled,
  sendPermanentFailureAlert,
} from "../../scheduler/alerts.js";
import { getSchedulerDeps } from "../deps.js";
import {
  extractMarkerFromLog,
  worktreeHasNoChanges,
  alreadyDonePatterns,
  updateAndEmit,
  transitionToFinalState,
} from "../workflow-utils.js";
import { finalizeInvocation } from "./finalize-invocation.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import {
  findPrForBranch,
  closeSupersededPrs,
  getPrCheckStatus,
  enrichPrDescription,
  resolveGhBinary,
} from "../../github/index.js";
import { activeHandles } from "../../session-handles.js";
import { isDraining } from "../../deploy.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { runWithLogContext } from "../../logger-context.js";
import {
  getResourceSnapshot,
  isResourceConstrained,
} from "../resource-check.js";

/**
 * Guard: throws if the number of active Claude sessions has reached the
 * concurrency cap. Checks both the process-local activeHandles map AND the
 * DB running invocation count (survives restarts where activeHandles is empty).
 * Uses Math.max to be conservative — if either source says we're full, we're full.
 *
 * The cap is read dynamically from scheduler deps so tests can override it
 * without module reload.
 */
export function assertSessionCapacity(
  db: import("../../db/index.js").OrcaDb,
): void {
  if (isDraining()) {
    throw new Error("instance is draining — rejecting new session dispatch");
  }
  const cap = getSchedulerDeps().config.concurrencyCap ?? 1;
  const handleCount = activeHandles.size;
  const dbCount = countActiveSessions(db);
  const effectiveCount = Math.max(handleCount, dbCount);
  if (effectiveCount >= cap) {
    throw new Error(
      `session cap reached: ${effectiveCount} active sessions (handles=${handleCount}, db=${dbCount}, cap=${cap})`,
    );
  }

  const snapshot = getResourceSnapshot();
  if (isResourceConstrained(snapshot)) {
    throw new Error(
      `resource constrained: ${snapshot.memAvailableMb.toFixed(0)}MB available, ${snapshot.cpuLoadPercent.toFixed(1)}% CPU load`,
    );
  }
}

/**
 * Guard for agent tasks: same as assertSessionCapacity but uses
 * agentConcurrencyCap and counts only agent sessions.
 */
export function assertAgentSessionCapacity(
  db: import("../../db/index.js").OrcaDb,
): void {
  if (isDraining()) {
    throw new Error("instance is draining — rejecting new session dispatch");
  }
  const cap = getSchedulerDeps().config.agentConcurrencyCap ?? 12;
  const dbCount = countActiveAgentSessions(db);
  if (dbCount >= cap) {
    throw new Error(
      `agent session cap reached: ${dbCount} active agent sessions (cap=${cap})`,
    );
  }

  const snapshot = getResourceSnapshot();
  if (isResourceConstrained(snapshot)) {
    throw new Error(
      `resource constrained: ${snapshot.memAvailableMb.toFixed(0)}MB available, ${snapshot.cpuLoadPercent.toFixed(1)}% CPU load`,
    );
  }
}

// ---------------------------------------------------------------------------
// Timeout constants
// ---------------------------------------------------------------------------

/** Hard cap on total workflow duration. */
const WORKFLOW_TIMEOUT = "4h";

/** Maximum time to wait for a single Claude session to complete. */
const SESSION_TIMEOUT = "45m";

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

const logger = createLogger("inngest/lifecycle");

function log(message: string): void {
  logger.info(message);
}

// ---------------------------------------------------------------------------
// Bridge: send session/completed event when a Claude session finishes.
// The event carries lightweight metadata; callers query DB for full details.
// ---------------------------------------------------------------------------

export function bridgeSessionCompletion(
  invocationId: number,
  linearIssueId: string,
  phase: "implement" | "review",
  handle: SessionHandle,
  branchName: string | null,
  worktreePath: string | null,
): void {
  // Register handle so assertSessionCapacity() and kill endpoints work.
  activeHandles.set(invocationId, handle);

  handle.done
    .then((result) => {
      const invStatus = result.subtype === "success" ? "completed" : "failed";

      activeHandles.delete(invocationId);

      inngest
        .send({
          name: "session/completed",
          data: {
            invocationId,
            linearIssueId,
            phase,
            exitCode: result.exitCode ?? (invStatus === "completed" ? 0 : 1),
            summary: result.outputSummary ?? null,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            numTurns: result.numTurns,
            sessionId: handle.sessionId ?? null,
            branchName: branchName ?? null,
            worktreePath: worktreePath ?? null,
            isMaxTurns: result.subtype === "error_max_turns",
            isResumeNotFound: result.isResumeNotFound ?? false,
          },
        })
        .catch((err) => {
          log(
            `failed to send session/completed for invocation ${invocationId}: ${err} — falling back to DB update`,
          );
          // DB fallback: update invocation and reset task so it gets re-dispatched
          try {
            const { db } = getSchedulerDeps();
            finalizeInvocation(db, invocationId, invStatus, {
              costUsd: result.costUsd ?? null,
              inputTokens: result.inputTokens ?? null,
              outputTokens: result.outputTokens ?? null,
            });
            updateTaskStatus(db, linearIssueId, "failed", {
              reason: "session_failed_db_fallback",
              failureReason: `Session failed (DB fallback, phase: ${phase})`,
              failedPhase: phase,
            });
            log(
              `DB fallback: invocation ${invocationId} marked ${invStatus}, task ${linearIssueId} set to failed`,
            );
          } catch (dbErr) {
            log(
              `DB fallback also failed for invocation ${invocationId}: ${dbErr}`,
            );
          }
        });
    })
    .catch((err) => {
      activeHandles.delete(invocationId);

      // Process-level error — send a synthetic failure event so the workflow
      // doesn't wait forever before timing out.
      log(
        `runner error for invocation ${invocationId}: ${err} — sending synthetic failure event`,
      );
      inngest
        .send({
          name: "session/completed",
          data: {
            invocationId,
            linearIssueId,
            phase,
            exitCode: 1,
            summary: null,
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
            numTurns: null,
            sessionId: null,
            branchName: null,
            worktreePath: null,
            isMaxTurns: false,
            isResumeNotFound: false,
          },
        })
        .catch((sendErr) => {
          log(
            `secondary send also failed for invocation ${invocationId}: ${sendErr} — falling back to DB update`,
          );
          try {
            const { db } = getSchedulerDeps();
            finalizeInvocation(db, invocationId, "failed");
            updateTaskStatus(db, linearIssueId, "failed", {
              reason: "runner_error_db_fallback",
              failureReason: `Runner error (DB fallback, phase: ${phase})`,
              failedPhase: phase,
            });
            log(
              `DB fallback: invocation ${invocationId} marked failed, task ${linearIssueId} set to failed`,
            );
          } catch (dbErr) {
            log(
              `DB fallback also failed for invocation ${invocationId}: ${dbErr}`,
            );
          }
        });
    });
}

// ---------------------------------------------------------------------------
// Shared: build disallowed tools list
// ---------------------------------------------------------------------------

export function buildDisallowedTools(config: OrcaConfig): string[] {
  const ALWAYS_DISALLOWED = ["EnterPlanMode", "AskUserQuestion"];
  const userDisallowed = config.disallowedTools
    ? config.disallowedTools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  return [...new Set([...ALWAYS_DISALLOWED, ...userDisallowed])];
}

// ---------------------------------------------------------------------------
// Shared: build Orca MCP server config for per-session injection
// ---------------------------------------------------------------------------

/**
 * Returns an mcpServers map that injects the Orca state MCP server into every
 * agent session. The server exposes read-only tools for querying Orca's DB
 * (task metadata, invocation history, sibling tasks, parent issue).
 *
 * Uses the built `dist/mcp-server.js` artifact. Skips injection if that file
 * does not exist (e.g. during development before a build).
 */
export function buildOrcaMcpServers(
  config: OrcaConfig,
): Record<string, McpServerConfig> | undefined {
  const servers: Record<string, McpServerConfig> = {};

  const mcpServerPath = join(process.cwd(), "dist", "mcp-server.js");
  if (existsSync(mcpServerPath) && config.dbPath) {
    servers.orca = {
      command: process.execPath,
      args: [mcpServerPath],
      env: { ORCA_DB_PATH: resolve(config.dbPath) },
    };
  }

  if (config.githubMcpPat) {
    servers.github = {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${config.githubMcpPat}` },
    };
  }

  return Object.keys(servers).length > 0 ? servers : undefined;
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

export const taskLifecycle = inngest.createFunction(
  {
    id: "task-lifecycle",

    // Two-level concurrency control:
    // 1. Global cap: max CONCURRENCY_CAP workflow runs total
    // 2. Per-task cap: only one workflow run per task at a time (dedup)
    //
    // NOTE: Do NOT use `idempotency` here — it's sugar for rateLimit with a
    // 24h window, which blocks ALL re-runs for the same task for 24 hours.
    // Per-task concurrency of 1 achieves the dedup goal while still allowing
    // a new run after the previous one completes.
    concurrency: [
      { limit: parseInt(process.env.ORCA_CONCURRENCY_CAP ?? "1", 10) },
      { limit: 1, key: "event.data.linearIssueId" },
    ],

    // Cancel this workflow when a task/cancelled event arrives with the same
    // linearIssueId as the trigger event.
    cancelOn: [
      {
        event: "task/cancelled" as const,
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],

    // Hard cap on total workflow duration.
    timeouts: {
      finish: WORKFLOW_TIMEOUT,
    },

    // No automatic retries — retry logic is handled at the task level
    // via incrementRetryCount + re-firing task/ready.
    retries: 0,
  },
  {
    event: "task/ready" as const,
    if: "event.data.taskType != 'cron_claude' && event.data.taskType != 'cron_shell' && event.data.taskType != 'agent'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    log(`workflow started for task ${taskId}`);

    // -------------------------------------------------------------------------
    // Step 1: Token budget check — fail fast if token budget is exhausted
    // -------------------------------------------------------------------------

    const budgetCheck = await step.run(
      "check-budget",
      (): { ok: boolean; reason?: string } => {
        const { db, config } = getSchedulerDeps();
        const windowStart = budgetWindowStart(config.budgetWindowHours);
        const usedTokens = sumTokensInWindow(db, windowStart);
        if (usedTokens >= config.budgetMaxTokens) {
          return {
            ok: false,
            reason: `token budget exhausted: ${usedTokens.toLocaleString()} >= ${config.budgetMaxTokens.toLocaleString()} tokens in ${config.budgetWindowHours}h window`,
          };
        }
        return { ok: true };
      },
    );

    if (!budgetCheck.ok) {
      log(
        `task ${taskId}: ${budgetCheck.reason ?? "token budget exceeded"} — alerting and requeueing`,
      );

      // Send alert inside step.run so it's memoized on replay
      await step.run("send-budget-alert", () => {
        const alertDeps = getSchedulerDeps();
        sendAlertThrottled(
          alertDeps,
          "budget_exhausted",
          {
            severity: "warning",
            title: "Token Budget Exhausted",
            message: budgetCheck.reason ?? "Token budget limit reached",
            taskId,
            fields: [
              { title: "Task ID", value: taskId, short: true },
              {
                title: "Reason",
                value: budgetCheck.reason ?? "unknown",
                short: false,
              },
            ],
          },
          3_600_000, // 1-hour cooldown
        );
      });

      await step.sleep("budget-backoff", 60_000);

      await step.run("requeue-budget-exceeded", () => {
        const { db } = getSchedulerDeps();
        updateAndEmit(db, taskId, "ready", "budget_exceeded");
      });
      return { outcome: "budget_exceeded", reason: budgetCheck.reason };
    }

    // -------------------------------------------------------------------------
    // Step 2: Claim task (atomic CAS: ready/in_review/changes_requested → running)
    // -------------------------------------------------------------------------

    const claimResult = await step.run(
      "claim-task",
      (): { claimed: boolean; reason?: string; phase?: string } =>
        runWithLogContext({ taskId }, () => {
          const { db, client, stateMap } = getSchedulerDeps();

          // Check capacity BEFORE claiming — if we claim first and capacity is
          // full, the DB row transitions to "running" with no session (zombie).
          // Return gracefully instead of throwing — with retries: 0, a throw
          // kills the workflow permanently and the task is never re-dispatched.
          try {
            assertSessionCapacity(db);
          } catch (err) {
            const reason =
              err instanceof Error ? err.message : "session cap reached";
            return { claimed: false, reason };
          }

          const task = getTask(db, taskId);
          if (!task) return { claimed: false, reason: "task not found" };

          const claimed = claimTaskForDispatch(db, taskId, [
            "ready",
            "in_review",
            "changes_requested",
          ]);
          if (!claimed) {
            return {
              claimed: false,
              reason: `task ${taskId} not in a dispatchable state (current: ${task.orcaStatus})`,
            };
          }

          emitTaskUpdated(getTask(db, taskId)!);
          transitionToFinalState({ client, stateMap }, taskId, "running").catch(
            (err) =>
              logger.warn("Linear write-back failed for running status", {
                taskId,
                error: String(err),
              }),
          );

          return { claimed: true, phase: task.orcaStatus as string };
        }),
    );

    if (!claimResult.claimed) {
      log(`task ${taskId}: claim failed — ${claimResult.reason ?? "unknown"}`);
      return {
        outcome: "not_claimed",
        reason: claimResult.reason ?? "unknown",
      };
    }

    log(`task ${taskId}: claimed (was ${claimResult.phase ?? "unknown"})`);

    // -------------------------------------------------------------------------
    // Guard A: abort if task is in a terminal state before implement spawn
    // -------------------------------------------------------------------------

    const guardAImplement = await step.run(
      "guard-a-implement",
      (): { aborted: boolean } => {
        const { db } = getSchedulerDeps();
        const freshTask = getTask(db, taskId);
        if (
          !freshTask ||
          ["done", "failed", "canceled"].includes(freshTask.orcaStatus)
        ) {
          log(
            `task ${taskId} is ${freshTask?.orcaStatus ?? "deleted"}, aborting stale workflow`,
          );
          insertSystemEvent(db, {
            type: "self_heal",
            message: `Aborted stale workflow for ${taskId} (status: ${freshTask?.orcaStatus ?? "deleted"})`,
            metadata: {
              taskId,
              abortedStatus: freshTask?.orcaStatus ?? "deleted",
              phase: "implement",
            },
          });
          return { aborted: true };
        }
        return { aborted: false };
      },
    );
    if (guardAImplement.aborted) return { outcome: "aborted_stale" };

    // -------------------------------------------------------------------------
    // Step 3: Spawn implement session
    // -------------------------------------------------------------------------

    const implementCtx = await step.run(
      "start-implement",
      (): {
        invocationId: number;
        worktreePath: string;
        branchName: string;
        isFixPhase: boolean;
        startedAt: number;
      } | null =>
        runWithLogContext({ taskId }, () => {
          const { db, config, client } = getSchedulerDeps();
          const task = getTask(db, taskId);
          if (!task) throw new Error(`task ${taskId} not found`);

          // Detect resume scenarios
          let resumeSessionId: string | undefined;
          let resumeWorktreePath: string | undefined;
          let resumeBranchName: string | undefined;
          let isDeployResume = false;

          if (true) {
            const prevInv = getLastMaxTurnsInvocation(db, taskId);
            if (prevInv?.worktreePath && existsSync(prevInv.worktreePath)) {
              resumeSessionId = prevInv.sessionId ?? undefined;
              resumeWorktreePath = prevInv.worktreePath;
              resumeBranchName = prevInv.branchName ?? undefined;
              log(
                `task ${taskId}: resuming max-turns session ${resumeSessionId} at ${resumeWorktreePath}`,
              );
            }
          }

          if (!resumeWorktreePath) {
            const prevInv = getLastDeployInterruptedInvocation(db, taskId);
            if (prevInv?.worktreePath && existsSync(prevInv.worktreePath)) {
              resumeSessionId = prevInv.sessionId ?? undefined;
              resumeWorktreePath = prevInv.worktreePath;
              resumeBranchName = prevInv.branchName ?? undefined;
              isDeployResume = true;
              log(
                `task ${taskId}: resuming deploy-interrupted session ${resumeSessionId ?? "none"} at ${resumeWorktreePath}`,
              );
            }
          }

          const isFixPhase = task.orcaStatus === "changes_requested";
          let fixPhaseResumeSessionId: string | undefined;
          if (isFixPhase) {
            const prevInv = getLastCompletedImplementInvocation(db, taskId);
            if (prevInv?.sessionId) {
              fixPhaseResumeSessionId = prevInv.sessionId;
            }
          }

          const model = config.model;

          // Check capacity BEFORE creating worktree or inserting invocation —
          // creating resources first would leak them if the check throws.
          // Catch errors gracefully — with retries: 0, a throw kills the
          // workflow permanently and orphans the task.
          try {
            assertSessionCapacity(db);
          } catch (err) {
            const reason =
              err instanceof Error ? err.message : "session cap reached";
            log(
              `task ${taskId}: implement spawn blocked (${reason}), resetting to ready`,
            );
            updateTaskStatus(db, taskId, "ready", {
              reason: "spawn_blocked_capacity",
            });
            emitTaskUpdated(getTask(db, taskId)!);
            return null;
          }

          let worktreePath: string;
          let branchName: string;

          if (resumeWorktreePath) {
            worktreePath = resumeWorktreePath;
            branchName = resumeBranchName ?? "unknown";
          } else {
            const baseRef = isFixPhase
              ? (task.prBranchName ?? undefined)
              : undefined;
            let wtResult;
            try {
              const { worktreePool } = getSchedulerDeps();
              if (worktreePool && !baseRef) {
                // Implement phase with no baseRef — try pool first
                wtResult = worktreePool.claim(task.repoPath, taskId, 0);
              } else {
                wtResult = createWorktree(task.repoPath, taskId, 0, {
                  baseRef,
                });
              }
            } catch (err) {
              log(
                `task ${taskId}: implement spawn blocked by worktree error: ${err}`,
              );
              updateTaskStatus(db, taskId, "ready", {
                reason: "spawn_blocked_worktree_error",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              return null;
            }
            worktreePath = wtResult.worktreePath;
            branchName = wtResult.branchName;
          }

          let agentPrompt = task.agentPrompt ?? "";
          let appendSystemPrompt: string | undefined;

          if (isFixPhase) {
            if (task.fixReason === "merge_conflict") {
              agentPrompt +=
                "\n\nThe PR branch has merge conflicts. Run `git fetch origin && git rebase origin/main` to rebase onto main, resolve any conflicts, then force-push the branch.";
              updateTaskFixReason(db, taskId, null);
            }
            appendSystemPrompt = config.fixSystemPrompt || undefined;
          } else {
            appendSystemPrompt = config.implementSystemPrompt || undefined;
          }

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

          const startedAt = Date.now();
          const handle = spawnSession({
            agentPrompt,
            worktreePath,
            maxTurns: config.defaultMaxTurns,
            invocationId,
            projectRoot: process.cwd(),
            claudePath: config.claudePath,
            appendSystemPrompt,
            disallowedTools: buildDisallowedTools(config),
            resumeSessionId: fixPhaseResumeSessionId ?? resumeSessionId,
            repoPath: task.repoPath,
            model,
            mcpServers: buildOrcaMcpServers(config),
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

          const dispatchMsg = isDeployResume
            ? `Resuming after deploy interruption (invocation #${invocationId})`
            : resumeSessionId
              ? `Resuming session (invocation #${invocationId}, session ${resumeSessionId})`
              : isFixPhase
                ? `Dispatched to fix review feedback (invocation #${invocationId})`
                : `Dispatched for implementation (invocation #${invocationId})`;
          client.createComment(taskId, dispatchMsg).catch((err: unknown) => {
            logger.warn("Linear createComment failed (dispatch)", {
              taskId,
              error: String(err),
            });
          });

          log(
            `task ${taskId}: implement session spawned as invocation ${invocationId}`,
          );
          return {
            invocationId,
            worktreePath,
            branchName,
            isFixPhase,
            startedAt,
          };
        }),
    );

    // If implement spawn was blocked by capacity/worktree error, exit gracefully.
    // The task was reset to "ready" and the reconciler will re-dispatch.
    if (!implementCtx) return { outcome: "capacity_blocked" };

    // -------------------------------------------------------------------------
    // Step 4: Wait for implement session to complete (45 min timeout)
    // -------------------------------------------------------------------------

    const implementEvent = await step.waitForEvent("await-implement", {
      event: "session/completed",
      if: `async.data.invocationId == ${implementCtx.invocationId}`,
      timeout: SESSION_TIMEOUT,
    });

    // -------------------------------------------------------------------------
    // Step 5: Process implement result + Gate 2
    // -------------------------------------------------------------------------

    type Gate2Outcome =
      | "in_review"
      | "done"
      | "retry"
      | "permanent_fail"
      | "timed_out"
      | "rescued_pr";

    /**
     * Marks a task as "done" when the work was already complete (no PR needed).
     * Encapsulates the ~15 lines common to both "already done" early-return paths.
     */
    async function markAlreadyDone(
      db: OrcaDb,
      taskId: string,
      client: import("../../linear/client.js").LinearClient,
      stateMap: import("../../linear/client.js").WorkflowStateMap,
      worktreePath: string,
      reason: string,
    ): Promise<{ outcome: "done" }> {
      updateAndEmit(db, taskId, "done", reason);
      insertSystemEvent(db, {
        type: "task_completed",
        message: `Task ${taskId} completed`,
        metadata: { taskId, phase: "implement", reason },
      });
      transitionToFinalState({ client, stateMap }, taskId, "done").catch(
        (err) =>
          logger.warn("Linear write-back failed for done status", {
            taskId,
            error: String(err),
          }),
      );
      try {
        removeWorktree(worktreePath);
      } catch {
        /* ignore */
      }
      return { outcome: "done" };
    }

    const gate2 = await step.run(
      "process-implement-and-gate2",
      async (): Promise<{
        outcome: Gate2Outcome;
        prBranch?: string;
        prNumber?: number | null;
      }> =>
        runWithLogContext(
          { taskId, invocationId: String(implementCtx.invocationId) },
          async () => {
            const { db, config, client, stateMap } = getSchedulerDeps();
            const { invocationId, worktreePath, branchName } = implementCtx;

            if (!implementEvent) {
              log(
                `task ${taskId}: implement session timed out (invocation ${invocationId})`,
              );
              const timedOutHandle = activeHandles.get(invocationId);
              if (timedOutHandle) {
                killSession(timedOutHandle).catch((err: unknown) => {
                  logger.warn("killSession failed (implement timeout)", {
                    taskId,
                    invocationId,
                    error: String(err),
                  });
                });
              }
              finalizeInvocation(db, invocationId, "timed_out", {
                outputSummary: "session timed out after 45 minutes",
              });
              updateAndEmit(db, taskId, "failed", "session_timed_out", {
                failureReason: "Implement session timed out after 45 minutes",
                failedPhase: "implement",
              });
              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }
              const timedOutTask = getTask(db, taskId);
              if (
                timedOutTask &&
                timedOutTask.retryCount >= config.maxRetries
              ) {
                insertSystemEvent(db, {
                  type: "task_failed",
                  message: `Task ${taskId} permanently failed`,
                  metadata: {
                    taskId,
                    phase: "implement",
                    reason: "session_timed_out",
                    retries: config.maxRetries,
                  },
                });
                sendPermanentFailureAlert(
                  getSchedulerDeps(),
                  taskId,
                  `Session timed out after ${config.maxRetries} retries (implement phase)`,
                );
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "failed_permanent",
                ).catch((err: unknown) => {
                  logger.warn(
                    "transitionToFinalState failed (implement timeout)",
                    {
                      taskId,
                      error: String(err),
                    },
                  );
                });
                return { outcome: "permanent_fail" };
              }
              return { outcome: "timed_out" };
            }

            const isSuccess =
              implementEvent.data.exitCode === 0 &&
              !implementEvent.data.isMaxTurns;
            const invRecord = getInvocation(db, invocationId);
            const isMaxTurns = implementEvent.data.isMaxTurns;

            const implStatus = isSuccess ? "completed" : "failed";
            emitInvocationCompleted({
              taskId,
              invocationId,
              status: implStatus,
              costUsd: implementEvent.data.costUsd ?? 0,
              inputTokens: implementEvent.data.inputTokens ?? 0,
              outputTokens: implementEvent.data.outputTokens ?? 0,
            });
            finalizeInvocation(db, invocationId, implStatus, {
              costUsd: implementEvent.data.costUsd ?? null,
              inputTokens: implementEvent.data.inputTokens ?? null,
              outputTokens: implementEvent.data.outputTokens ?? null,
            });

            if (!isSuccess) {
              log(
                `task ${taskId}: implement failed (exit ${implementEvent.data.exitCode}${isMaxTurns ? ", max turns" : ""}) — invocation ${invocationId}`,
              );
              if (!isMaxTurns) {
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }
              }

              // Guard B: check for orphaned green PR before writing failed status
              const guardBTask = getTask(db, taskId);
              if (guardBTask?.prBranchName) {
                try {
                  const prInfo = await findPrForBranch(
                    guardBTask.prBranchName,
                    guardBTask.repoPath,
                  );
                  if (prInfo.exists && prInfo.number) {
                    const ciStatus = await getPrCheckStatus(
                      prInfo.number,
                      guardBTask.repoPath,
                    );
                    if (ciStatus === "success") {
                      updateAndEmit(
                        db,
                        taskId,
                        "awaiting_ci",
                        "rescued_green_pr",
                      );
                      updateTaskCiInfo(db, taskId, {
                        ciStartedAt: new Date().toISOString(),
                      });
                      sendAlert(getSchedulerDeps(), {
                        severity: "info",
                        title: "Rescued orphaned green PR",
                        message: `Task ${taskId} had a passing PR on branch ${guardBTask.prBranchName} — transitioning to awaiting_ci instead of failing`,
                        taskId,
                        fields: [
                          {
                            title: "Branch",
                            value: guardBTask.prBranchName!,
                            short: true,
                          },
                          {
                            title: "PR",
                            value: `#${prInfo.number}`,
                            short: true,
                          },
                        ],
                      });
                      log(
                        `Guard B: rescued task ${taskId} — PR #${prInfo.number} has passing CI`,
                      );
                      await inngest.send({
                        name: "task/awaiting-ci",
                        data: {
                          linearIssueId: taskId,
                          repoPath: guardBTask.repoPath,
                          prNumber: prInfo.number,
                          prBranchName: guardBTask.prBranchName!,
                          ciStartedAt: new Date().toISOString(),
                        },
                      });
                      return { outcome: "rescued_pr" };
                    }
                  }
                } catch (err) {
                  log(`Guard B rescue check failed for ${taskId}: ${err}`);
                }
              }

              updateAndEmit(db, taskId, "failed", "implement_failed", {
                failureReason: `Implement session failed (exit code ${implementEvent.data.exitCode}${isMaxTurns ? ", max turns reached" : ""})`,
                failedPhase: "implement",
              });

              const task = getTask(db, taskId);
              if (!task) return { outcome: "permanent_fail" };

              // If the resume session ID was not found, clear the stale session ID and
              // retry fresh without counting this against the retry budget.
              if (implementEvent.data.isResumeNotFound) {
                log(
                  `task ${taskId}: resume session not found — clearing stale session ID and retrying fresh (invocation ${invocationId})`,
                );
                clearSessionIds(db, taskId);
                client
                  .createComment(
                    taskId,
                    `Resume session not found (stale session ID) — restarting as fresh session`,
                  )
                  .catch((err: unknown) => {
                    logger.warn(
                      "Linear createComment failed (resume not found)",
                      {
                        taskId,
                        error: String(err),
                      },
                    );
                  });
                // Don't increment retry count — this is a setup failure, not a task failure
                return { outcome: "retry" };
              }

              if (task.retryCount >= config.maxRetries) {
                insertSystemEvent(db, {
                  type: "task_failed",
                  message: `Task ${taskId} permanently failed`,
                  metadata: {
                    taskId,
                    phase: "implement",
                    retries: config.maxRetries,
                  },
                });
                sendPermanentFailureAlert(
                  getSchedulerDeps(),
                  taskId,
                  `Session failed after ${config.maxRetries} retries (implement phase)`,
                );
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "failed_permanent",
                  `Task permanently failed after ${config.maxRetries} retries`,
                ).catch((err: unknown) => {
                  logger.warn(
                    "transitionToFinalState failed (implement permanent fail)",
                    { taskId, error: String(err) },
                  );
                });
                return { outcome: "permanent_fail" };
              }

              incrementRetryCount(db, taskId);
              // Skip "retry" (Todo) write-back — immediate re-dispatch will write
              // "In Progress" within seconds, and the intermediate "Todo" webhook
              // can arrive after echo TTL expires, killing the new session.
              return { outcome: "retry" };
            }

            // --- Gate 2: verify PR exists ---

            const task = getTask(db, taskId);
            if (!task) return { outcome: "permanent_fail" };

            const outputSummary = invRecord?.outputSummary?.toLowerCase() ?? "";
            const isAlreadyDone = alreadyDonePatterns.some((p) =>
              outputSummary.includes(p),
            );
            const noChanges = await worktreeHasNoChanges(worktreePath);

            if (!branchName) {
              if (isAlreadyDone || noChanges) {
                log(`task ${taskId}: work already on main — marking done`);
                return markAlreadyDone(
                  db,
                  taskId,
                  client,
                  stateMap,
                  worktreePath,
                  "already_on_main",
                );
              }
              // Direct updateInvocation — intentionally overwrites the
              // "completed" status set by the implement finalize step.
              // Cannot use finalizeInvocation here: its idempotency guard
              // would skip the write.
              updateInvocation(db, invocationId, {
                status: "failed",
                endedAt: new Date().toISOString(),
                outputSummary:
                  "Post-implementation gate failed: no branch name",
              });
              updateAndEmit(db, taskId, "failed", "gate2_no_branch", {
                failureReason:
                  "Post-implementation gate failed: no branch name",
                failedPhase: "gate2",
              });
              if (task.retryCount >= config.maxRetries) {
                insertSystemEvent(db, {
                  type: "task_failed",
                  message: `Task ${taskId} permanently failed`,
                  metadata: {
                    taskId,
                    phase: "gate2",
                    reason: "no_branch_name",
                    retries: config.maxRetries,
                  },
                });
                sendPermanentFailureAlert(
                  getSchedulerDeps(),
                  taskId,
                  `Gate 2 failed: no branch name after ${config.maxRetries} retries`,
                );
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "failed_permanent",
                ).catch((err: unknown) => {
                  logger.warn(
                    "transitionToFinalState failed (gate2 no branch name)",
                    { taskId, error: String(err) },
                  );
                });
                return { outcome: "permanent_fail" };
              }
              incrementRetryCount(db, taskId);
              return { outcome: "retry" };
            }

            const prInfo = await findPrForBranch(branchName, task.repoPath);

            if (!prInfo.exists) {
              if (isAlreadyDone || noChanges) {
                log(
                  `task ${taskId}: no PR found but work is already done — marking done`,
                );
                return markAlreadyDone(
                  db,
                  taskId,
                  client,
                  stateMap,
                  worktreePath,
                  "already_done",
                );
              }
              log(
                `task ${taskId}: Gate 2 failed — no PR found for branch ${branchName}`,
              );
              // Direct updateInvocation — intentionally overwrites the
              // "completed" status set by the implement finalize step.
              // Cannot use finalizeInvocation here: its idempotency guard
              // would skip the write.
              updateInvocation(db, invocationId, {
                status: "failed",
                endedAt: new Date().toISOString(),
                outputSummary: `Post-implementation gate failed: no PR found for branch ${branchName}`,
              });
              updateAndEmit(db, taskId, "failed", "gate2_no_pr", {
                failureReason: `Post-implementation gate failed: no PR found for branch ${branchName}`,
                failedPhase: "gate2",
              });
              if (task.retryCount >= config.maxRetries) {
                insertSystemEvent(db, {
                  type: "task_failed",
                  message: `Task ${taskId} permanently failed`,
                  metadata: {
                    taskId,
                    phase: "gate2",
                    reason: "no_pr_found",
                    retries: config.maxRetries,
                  },
                });
                sendPermanentFailureAlert(
                  getSchedulerDeps(),
                  taskId,
                  `Gate 2 failed: no PR found after ${config.maxRetries} retries`,
                );
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "failed_permanent",
                ).catch((err: unknown) => {
                  logger.warn(
                    "transitionToFinalState failed (gate2 no PR found)",
                    {
                      taskId,
                      error: String(err),
                    },
                  );
                });
                return { outcome: "permanent_fail" };
              }
              incrementRetryCount(db, taskId);
              return { outcome: "retry" };
            }

            // PR found — store branch + PR info
            const storedBranch = prInfo.headBranch ?? branchName;
            updateTaskPrBranch(db, taskId, storedBranch);
            if (prInfo.number != null) {
              updateTaskDeployInfo(db, taskId, { prNumber: prInfo.number });
            }
            if (prInfo.url != null || prInfo.state != null) {
              updateTaskPrState(
                db,
                taskId,
                prInfo.url ?? null,
                prInfo.state ?? null,
              );
            }

            if (prInfo.number != null) {
              try {
                closeSupersededPrs(
                  taskId,
                  prInfo.number,
                  invocationId,
                  branchName,
                  task.repoPath,
                );
              } catch {
                /* ignore */
              }
            }

            if (prInfo.url) {
              client
                .createAttachment(
                  task.linearIssueId,
                  prInfo.url,
                  "Pull Request",
                )
                .catch((err: unknown) => {
                  logger.warn("Linear createAttachment failed", {
                    taskId,
                    error: String(err),
                  });
                });
            }

            resetStaleSessionRetryCount(db, taskId);
            updateAndEmit(db, taskId, "in_review", "pr_found");
            transitionToFinalState(
              { client, stateMap },
              taskId,
              "in_review",
              `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${storedBranch}\``,
            ).catch((err: unknown) => {
              logger.warn("transitionToFinalState failed (gate2 → in_review)", {
                taskId,
                error: String(err),
              });
            });

            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }

            log(
              `task ${taskId}: Gate 2 passed → in_review (PR #${prInfo.number ?? "?"})`,
            );
            return {
              outcome: "in_review",
              prBranch: storedBranch,
              prNumber: prInfo.number,
            };
          },
        ),
    );

    // Terminal outcomes after implement phase
    if (
      gate2.outcome === "timed_out" ||
      gate2.outcome === "permanent_fail" ||
      gate2.outcome === "done" ||
      gate2.outcome === "rescued_pr"
    ) {
      return { outcome: gate2.outcome };
    }

    // Retry: task was reset to "ready" by incrementRetryCount — re-emit
    // task/ready so a new workflow picks it up.
    if (gate2.outcome === "retry") {
      const { db: retryDb } = getSchedulerDeps();
      const retryTask = getTask(retryDb, taskId);
      if (retryTask) {
        await inngest.send({
          name: "task/ready",
          data: {
            linearIssueId: taskId,
            repoPath: retryTask.repoPath,
            priority: retryTask.priority,
            projectName: retryTask.projectName ?? null,
            taskType: retryTask.taskType ?? "standard",
            createdAt: retryTask.createdAt,
          },
        });
      }
      return { outcome: "retry" };
    }

    // -------------------------------------------------------------------------
    // Step 5b: Enrich PR description with AI-generated content (haiku)
    // -------------------------------------------------------------------------
    if (gate2.outcome === "in_review" && gate2.prNumber != null) {
      await step.run("enrich-pr-description", async () => {
        const { db: enrichDb, config: enrichConfig } = getSchedulerDeps();
        const enrichTask = getTask(enrichDb, taskId);
        if (!enrichTask) return;
        try {
          await enrichPrDescription({
            prNumber: gate2.prNumber!,
            taskId,
            agentPrompt: enrichTask.agentPrompt,
            repoPath: enrichTask.repoPath,
            claudePath: enrichConfig.claudePath,
            model: enrichConfig.reviewModel, // haiku
            ghPath: resolveGhBinary(),
          });
        } catch (err) {
          // Non-fatal — log and continue to review
          log(
            `task ${taskId}: PR description enrichment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    // -------------------------------------------------------------------------
    // Step 6+: Review-fix loop (up to maxReviewCycles)
    // -------------------------------------------------------------------------

    const { config: loopConfig } = getSchedulerDeps();
    for (let cycle = 0; cycle < loopConfig.maxReviewCycles; cycle++) {
      // -----------------------------------------------------------------------
      // Guard A: abort if task is in a terminal state before review spawn
      // -----------------------------------------------------------------------

      const guardAReview = await step.run(
        `guard-a-review-${cycle}`,
        (): { aborted: boolean } => {
          const { db } = getSchedulerDeps();
          const freshTask = getTask(db, taskId);
          if (
            !freshTask ||
            ["done", "failed", "canceled"].includes(freshTask.orcaStatus)
          ) {
            log(
              `task ${taskId} is ${freshTask?.orcaStatus ?? "deleted"}, aborting stale workflow`,
            );
            insertSystemEvent(db, {
              type: "self_heal",
              message: `Aborted stale workflow for ${taskId} (status: ${freshTask?.orcaStatus ?? "deleted"})`,
              metadata: {
                taskId,
                abortedStatus: freshTask?.orcaStatus ?? "deleted",
                phase: "review",
                cycle,
              },
            });
            return { aborted: true };
          }
          return { aborted: false };
        },
      );
      if (guardAReview.aborted) return { outcome: "aborted_stale" };

      // -----------------------------------------------------------------------
      // 6a: Spawn review session
      // -----------------------------------------------------------------------

      const reviewCtx = await step.run(
        `start-review-${cycle}`,
        (): {
          invocationId: number;
          worktreePath: string;
          startedAt: number;
        } | null =>
          runWithLogContext({ taskId }, () => {
            const { db, config, client } = getSchedulerDeps();
            const task = getTask(db, taskId);
            if (!task) throw new Error(`task ${taskId} not found`);

            const prRef = task.prNumber
              ? `#${task.prNumber}`
              : "on this branch";
            const agentPrompt = `${task.agentPrompt ?? ""}\n\nReview PR ${prRef}. The PR branch is checked out in your working directory.`;

            const baseRef = task.prBranchName ?? undefined;
            let wtResult;
            try {
              wtResult = createWorktree(task.repoPath, taskId, cycle, {
                baseRef,
              });
            } catch (err) {
              log(
                `task ${taskId}: review spawn blocked by worktree error: ${err}`,
              );
              updateTaskStatus(db, taskId, "ready", {
                reason: "spawn_blocked_worktree_error",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              return null;
            }

            try {
              assertSessionCapacity(db);
            } catch (err) {
              const reason =
                err instanceof Error ? err.message : "session cap reached";
              log(
                `task ${taskId}: review spawn blocked (${reason}), resetting to ready`,
              );
              updateTaskStatus(db, taskId, "ready", {
                reason: "spawn_blocked_capacity",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              try {
                removeWorktree(wtResult.worktreePath);
              } catch {
                /* ignore */
              }
              return null;
            }

            const now = new Date().toISOString();
            const invocationId = insertInvocation(db, {
              linearIssueId: taskId,
              startedAt: now,
              status: "running",
              phase: "review",
              model: config.reviewModel,
              worktreePath: wtResult.worktreePath,
              branchName: wtResult.branchName,
              logPath: "logs/0.ndjson",
            });
            updateInvocation(db, invocationId, {
              logPath: `logs/${invocationId}.ndjson`,
            });

            const startedAt = Date.now();
            const handle = spawnSession({
              agentPrompt,
              worktreePath: wtResult.worktreePath,
              maxTurns: config.reviewMaxTurns,
              invocationId,
              projectRoot: process.cwd(),
              claudePath: config.claudePath,
              appendSystemPrompt: config.reviewSystemPrompt || undefined,
              disallowedTools: buildDisallowedTools(config),
              repoPath: task.repoPath,
              model: config.reviewModel,
              mcpServers: buildOrcaMcpServers(config),
              hookUrl: getHookUrl(invocationId),
            });

            bridgeSessionCompletion(
              invocationId,
              taskId,
              "review",
              handle,
              wtResult.branchName,
              wtResult.worktreePath,
            );

            emitInvocationStarted({ taskId, invocationId });
            updateAndEmit(db, taskId, "running", "review_dispatched");
            client
              .createComment(
                taskId,
                `Dispatched for code review (invocation #${invocationId}, cycle ${cycle + 1}/${config.maxReviewCycles})`,
              )
              .catch((err: unknown) => {
                logger.warn("Linear createComment failed (review dispatch)", {
                  taskId,
                  error: String(err),
                });
              });

            log(
              `task ${taskId}: review session spawned as invocation ${invocationId} (cycle ${cycle + 1})`,
            );
            return {
              invocationId,
              worktreePath: wtResult.worktreePath,
              startedAt,
            };
          }),
      );

      // If review spawn was blocked by capacity/worktree error, exit gracefully.
      // The task was reset to "ready" and the reconciler will re-dispatch.
      if (!reviewCtx) return { outcome: "capacity_blocked" as const };

      // -----------------------------------------------------------------------
      // 6b: Wait for review session to complete
      // -----------------------------------------------------------------------

      const reviewEvent = await step.waitForEvent(`await-review-${cycle}`, {
        event: "session/completed",
        if: `async.data.invocationId == ${reviewCtx.invocationId}`,
        timeout: SESSION_TIMEOUT,
      });

      // -----------------------------------------------------------------------
      // 6c: Process review result
      // -----------------------------------------------------------------------

      type ReviewOutcome =
        | "approved"
        | "changes_requested"
        | "no_marker"
        | "timed_out"
        | "failed";

      const reviewResult = await step.run(
        `process-review-${cycle}`,
        async (): Promise<{ outcome: ReviewOutcome }> =>
          runWithLogContext(
            { taskId, invocationId: String(reviewCtx.invocationId) },
            async () => {
              const { db } = getSchedulerDeps();
              const { invocationId, worktreePath } = reviewCtx;

              if (!reviewEvent) {
                log(
                  `task ${taskId}: review session timed out (cycle ${cycle + 1})`,
                );
                const timedOutHandle = activeHandles.get(invocationId);
                if (timedOutHandle) {
                  killSession(timedOutHandle).catch((err: unknown) => {
                    logger.warn("killSession failed (review timeout)", {
                      taskId,
                      invocationId,
                      error: String(err),
                    });
                  });
                }
                finalizeInvocation(db, invocationId, "timed_out", {
                  outputSummary: "review session timed out after 45 minutes",
                });
                updateAndEmit(
                  db,
                  taskId,
                  "in_review",
                  "review_session_timed_out",
                );
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }
                return { outcome: "timed_out" };
              }

              const isSuccess =
                reviewEvent.data.exitCode === 0 && !reviewEvent.data.isMaxTurns;
              const revStatus = isSuccess ? "completed" : "failed";
              emitInvocationCompleted({
                taskId,
                invocationId,
                status: revStatus,
                costUsd: reviewEvent.data.costUsd ?? 0,
                inputTokens: reviewEvent.data.inputTokens ?? 0,
                outputTokens: reviewEvent.data.outputTokens ?? 0,
              });
              finalizeInvocation(db, invocationId, revStatus, {
                costUsd: reviewEvent.data.costUsd ?? null,
                inputTokens: reviewEvent.data.inputTokens ?? null,
                outputTokens: reviewEvent.data.outputTokens ?? null,
              });
              if (!isSuccess) {
                updateAndEmit(db, taskId, "in_review", "review_session_failed");
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }
                return { outcome: "failed" };
              }

              // Parse REVIEW_RESULT marker from invocation output summary + log
              const invRecord = getInvocation(db, invocationId);
              const summary = invRecord?.outputSummary ?? "";
              let approved = summary.includes("REVIEW_RESULT:APPROVED");
              let changesRequested = summary.includes(
                "REVIEW_RESULT:CHANGES_REQUESTED",
              );

              if (!approved && !changesRequested) {
                const markerFromLog = await extractMarkerFromLog(invocationId);
                if (markerFromLog === "APPROVED") approved = true;
                else if (markerFromLog === "CHANGES_REQUESTED")
                  changesRequested = true;
              }

              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }

              if (approved) return { outcome: "approved" };
              if (changesRequested) return { outcome: "changes_requested" };
              return { outcome: "no_marker" };
            },
          ),
      );

      // -----------------------------------------------------------------------
      // 6d: Handle review outcome
      // -----------------------------------------------------------------------

      if (reviewResult.outcome === "approved") {
        const ciInfo = await step.run(`transition-awaiting-ci-${cycle}`, () => {
          const { db, client, stateMap } = getSchedulerDeps();
          const ciStartedAt = new Date().toISOString();
          updateTaskCiInfo(db, taskId, { ciStartedAt });
          resetStaleSessionRetryCount(db, taskId);
          updateAndEmit(db, taskId, "awaiting_ci", "review_approved");
          const task = getTask(db, taskId);
          transitionToFinalState(
            { client, stateMap },
            taskId,
            "awaiting_ci",
            `Review approved — awaiting CI checks on PR #${task?.prNumber ?? "?"} before merging`,
          ).catch((err: unknown) => {
            logger.warn(
              "transitionToFinalState failed (review approved → awaiting_ci)",
              { taskId, error: String(err) },
            );
          });
          log(
            `task ${taskId}: review approved → awaiting_ci (cycle ${cycle + 1})`,
          );
          return {
            prNumber: (task?.prNumber ?? 0) as number,
            prBranchName: (task?.prBranchName ?? "") as string,
            ciStartedAt: ciStartedAt as string,
          };
        });

        // Emit event to trigger CI gate workflow
        {
          const { db: awaitingDb, config: awaitingConfig } = getSchedulerDeps();
          await inngest.send({
            name: "task/awaiting-ci",
            data: {
              linearIssueId: taskId,
              prNumber: ciInfo.prNumber,
              prBranchName: ciInfo.prBranchName,
              repoPath:
                getTask(awaitingDb, taskId)?.repoPath ??
                awaitingConfig.defaultCwd ??
                "",
              ciStartedAt: ciInfo.ciStartedAt,
            },
          });
        }

        return { outcome: "awaiting_ci" };
      }

      if (
        reviewResult.outcome === "timed_out" ||
        reviewResult.outcome === "failed"
      ) {
        return { outcome: reviewResult.outcome };
      }

      // "no_marker" or "changes_requested" — check if we've exhausted cycles
      const isLastCycle = cycle >= loopConfig.maxReviewCycles - 1;

      if (reviewResult.outcome === "no_marker" || isLastCycle) {
        await step.run(`cycles-exhausted-${cycle}`, () => {
          const { db, client, config } = getSchedulerDeps();
          updateAndEmit(db, taskId, "in_review", "review_cycles_exhausted");
          const reason =
            reviewResult.outcome === "no_marker"
              ? "no REVIEW_RESULT marker found"
              : `review cycles exhausted (${config.maxReviewCycles}/${config.maxReviewCycles})`;
          client
            .createComment(
              taskId,
              `Review loop ended: ${reason} — manual intervention required`,
            )
            .catch((err: unknown) => {
              logger.warn(
                "Linear createComment failed (review cycles exhausted)",
                { taskId, error: String(err) },
              );
            });
          log(`task ${taskId}: ${reason} — leaving at in_review`);
        });
        return { outcome: "in_review_needs_human" };
      }

      // Changes requested — spawn fix session before next review cycle

      // -----------------------------------------------------------------------
      // Guard A: abort if task is in a terminal state before fix spawn
      // -----------------------------------------------------------------------

      const guardAFix = await step.run(
        `guard-a-fix-${cycle}`,
        (): { aborted: boolean } => {
          const { db } = getSchedulerDeps();
          const freshTask = getTask(db, taskId);
          if (
            !freshTask ||
            ["done", "failed", "canceled"].includes(freshTask.orcaStatus)
          ) {
            log(
              `task ${taskId} is ${freshTask?.orcaStatus ?? "deleted"}, aborting stale workflow`,
            );
            insertSystemEvent(db, {
              type: "self_heal",
              message: `Aborted stale workflow for ${taskId} (status: ${freshTask?.orcaStatus ?? "deleted"})`,
              metadata: {
                taskId,
                abortedStatus: freshTask?.orcaStatus ?? "deleted",
                phase: "fix",
                cycle,
              },
            });
            return { aborted: true };
          }
          return { aborted: false };
        },
      );
      if (guardAFix.aborted) return { outcome: "aborted_stale" };

      // -----------------------------------------------------------------------
      // 6e: Spawn fix session
      // -----------------------------------------------------------------------

      const fixCtx = await step.run(
        `start-fix-${cycle}`,
        (): {
          invocationId: number;
          worktreePath: string;
          startedAt: number;
        } | null =>
          runWithLogContext({ taskId }, () => {
            const { db, config, client, stateMap } = getSchedulerDeps();
            const task = getTask(db, taskId);
            if (!task) throw new Error(`task ${taskId} not found`);

            incrementReviewCycleCount(db, taskId);
            updateAndEmit(
              db,
              taskId,
              "changes_requested",
              "review_changes_requested",
            );
            transitionToFinalState(
              { client, stateMap },
              taskId,
              "changes_requested",
            ).catch((err: unknown) => {
              logger.warn(
                "transitionToFinalState failed (review → changes_requested)",
                { taskId, error: String(err) },
              );
            });

            let resumeSessionId: string | undefined;
            {
              const prevInv = getLastCompletedImplementInvocation(db, taskId);
              if (prevInv?.sessionId) resumeSessionId = prevInv.sessionId;
            }

            const baseRef = task.prBranchName ?? undefined;
            let wtResult;
            try {
              wtResult = createWorktree(task.repoPath, taskId, cycle + 1000, {
                baseRef,
              });
            } catch (err) {
              log(
                `task ${taskId}: fix spawn blocked by worktree error: ${err}`,
              );
              updateTaskStatus(db, taskId, "ready", {
                reason: "spawn_blocked_worktree_error",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              return null;
            }

            let agentPrompt = task.agentPrompt ?? "";
            if (task.fixReason === "merge_conflict") {
              agentPrompt +=
                "\n\nThe PR branch has merge conflicts. Run `git fetch origin && git rebase origin/main` to rebase onto main, resolve any conflicts, then force-push the branch.";
              updateTaskFixReason(db, taskId, null);
            }

            try {
              assertSessionCapacity(db);
            } catch (err) {
              const reason =
                err instanceof Error ? err.message : "session cap reached";
              log(
                `task ${taskId}: fix spawn blocked (${reason}), resetting to ready`,
              );
              updateTaskStatus(db, taskId, "ready", {
                reason: "spawn_blocked_capacity",
              });
              emitTaskUpdated(getTask(db, taskId)!);
              try {
                removeWorktree(wtResult.worktreePath);
              } catch {
                /* ignore */
              }
              return null;
            }

            const now = new Date().toISOString();
            const invocationId = insertInvocation(db, {
              linearIssueId: taskId,
              startedAt: now,
              status: "running",
              phase: "implement",
              model: config.model,
              worktreePath: wtResult.worktreePath,
              branchName: wtResult.branchName,
              logPath: "logs/0.ndjson",
            });
            updateInvocation(db, invocationId, {
              logPath: `logs/${invocationId}.ndjson`,
            });

            const startedAt = Date.now();
            const handle = spawnSession({
              agentPrompt,
              worktreePath: wtResult.worktreePath,
              maxTurns: config.defaultMaxTurns,
              invocationId,
              projectRoot: process.cwd(),
              claudePath: config.claudePath,
              appendSystemPrompt: config.fixSystemPrompt || undefined,
              disallowedTools: buildDisallowedTools(config),
              resumeSessionId,
              repoPath: task.repoPath,
              model: config.model,
              mcpServers: buildOrcaMcpServers(config),
              hookUrl: getHookUrl(invocationId),
            });

            bridgeSessionCompletion(
              invocationId,
              taskId,
              "implement",
              handle,
              wtResult.branchName,
              wtResult.worktreePath,
            );

            emitInvocationStarted({ taskId, invocationId });
            updateAndEmit(db, taskId, "running", "fix_dispatched");

            const reviewCycle = task.reviewCycleCount + 1;
            client
              .createComment(
                taskId,
                resumeSessionId
                  ? `Dispatched to fix review feedback with session resume (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`
                  : `Dispatched to fix review feedback (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`,
              )
              .catch((err: unknown) => {
                logger.warn("Linear createComment failed (fix dispatch)", {
                  taskId,
                  error: String(err),
                });
              });

            log(
              `task ${taskId}: fix session spawned as invocation ${invocationId} (review cycle ${reviewCycle})`,
            );
            return {
              invocationId,
              worktreePath: wtResult.worktreePath,
              startedAt,
            };
          }),
      );

      // If fix spawn was blocked by capacity/worktree error, exit gracefully.
      // The task was reset to "ready" and the reconciler will re-dispatch.
      if (!fixCtx) return { outcome: "capacity_blocked" as const };

      // -----------------------------------------------------------------------
      // 6f: Wait for fix session
      // -----------------------------------------------------------------------

      const fixEvent = await step.waitForEvent(`await-fix-${cycle}`, {
        event: "session/completed",
        if: `async.data.invocationId == ${fixCtx.invocationId}`,
        timeout: SESSION_TIMEOUT,
      });

      // -----------------------------------------------------------------------
      // 6g: Process fix result
      // -----------------------------------------------------------------------

      const fixResult = await step.run(
        `process-fix-${cycle}`,
        (): { ok: boolean; timedOut: boolean; resumeNotFound: boolean } =>
          runWithLogContext(
            { taskId, invocationId: String(fixCtx.invocationId) },
            () => {
              const { db, client, stateMap } = getSchedulerDeps();
              const { invocationId, worktreePath } = fixCtx;

              if (!fixEvent) {
                log(
                  `task ${taskId}: fix session timed out (cycle ${cycle + 1})`,
                );
                const timedOutHandle = activeHandles.get(invocationId);
                if (timedOutHandle) {
                  killSession(timedOutHandle).catch((err: unknown) => {
                    logger.warn("killSession failed (fix timeout)", {
                      taskId,
                      invocationId,
                      error: String(err),
                    });
                  });
                }
                finalizeInvocation(db, invocationId, "timed_out", {
                  outputSummary: "fix session timed out after 45 minutes",
                });
                updateAndEmit(db, taskId, "in_review", "fix_session_timed_out");
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }
                return { ok: false, timedOut: true, resumeNotFound: false };
              }

              const isSuccess =
                fixEvent.data.exitCode === 0 && !fixEvent.data.isMaxTurns;
              const fixStatus = isSuccess ? "completed" : "failed";
              emitInvocationCompleted({
                taskId,
                invocationId,
                status: fixStatus,
                costUsd: fixEvent.data.costUsd ?? 0,
                inputTokens: fixEvent.data.inputTokens ?? 0,
                outputTokens: fixEvent.data.outputTokens ?? 0,
              });
              finalizeInvocation(db, invocationId, fixStatus, {
                costUsd: fixEvent.data.costUsd ?? null,
                inputTokens: fixEvent.data.inputTokens ?? null,
                outputTokens: fixEvent.data.outputTokens ?? null,
              });
              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }

              if (!isSuccess) {
                // If the resume session ID was not found, clear the stale session ID
                // so the next iteration starts fresh without burning a retry slot.
                if (fixEvent.data.isResumeNotFound) {
                  log(
                    `task ${taskId}: fix resume session not found — clearing stale session ID, will retry fresh (invocation ${invocationId})`,
                  );
                  clearSessionIds(db, taskId);
                  client
                    .createComment(
                      taskId,
                      `Fix resume session not found (stale session ID) — restarting as fresh session`,
                    )
                    .catch((err: unknown) => {
                      logger.warn(
                        "Linear createComment failed (fix resume not found)",
                        { taskId, error: String(err) },
                      );
                    });
                  updateAndEmit(
                    db,
                    taskId,
                    "in_review",
                    "fix_resume_not_found",
                  );
                  return { ok: false, timedOut: false, resumeNotFound: true };
                }
                updateAndEmit(db, taskId, "in_review", "fix_session_failed");
                return { ok: false, timedOut: false, resumeNotFound: false };
              }

              // Fix succeeded — transition back to in_review for next review cycle
              resetStaleSessionRetryCount(db, taskId);
              updateAndEmit(db, taskId, "in_review", "fix_succeeded");
              transitionToFinalState(
                { client, stateMap },
                taskId,
                "in_review",
              ).catch((err: unknown) => {
                logger.warn("transitionToFinalState failed (fix → in_review)", {
                  taskId,
                  error: String(err),
                });
              });
              log(
                `task ${taskId}: fix complete → in_review (cycle ${cycle + 1})`,
              );
              return { ok: true, timedOut: false, resumeNotFound: false };
            },
          ),
      );

      if (!fixResult.ok) {
        // If the fix failed because the resume session ID was not found,
        // continue the loop — session IDs were cleared so the next iteration
        // will start a fresh fix session without --resume.
        if (fixResult.resumeNotFound) {
          continue;
        }
        return {
          outcome: fixResult.timedOut ? "fix_timed_out" : "fix_failed",
        };
      }

      // Continue to next review cycle
    }

    // Should not reach here — loop always returns early
    return { outcome: "unknown" };
  },
);
