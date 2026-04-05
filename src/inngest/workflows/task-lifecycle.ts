// ---------------------------------------------------------------------------
// Task lifecycle Inngest workflow
//
// Replaces the scheduler's dispatch + phase handlers with a durable,
// step-based workflow. Uses step.waitForEvent() for 45-min Claude sessions
// so the workflow is resilient to server restarts and crashes.
//
// Trigger: task/ready
// Steps:  token budget check → spawn implement → wait → Gate 2
//         → transition to awaiting_ci
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDefaultBranch } from "../../git.js";
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
  countActiveSessions,
  countActiveAgentSessions,
  getTaskStateTransitions,
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
  phase: "implement",
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

      // Always finalize the invocation in DB — don't rely solely on Inngest
      // workflow processing the session/completed event.
      try {
        const { db } = getSchedulerDeps();
        updateInvocation(db, invocationId, {
          status: invStatus,
          endedAt: new Date().toISOString(),
          costUsd: result.costUsd ?? null,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
          numTurns: result.numTurns ?? null,
          sessionId: handle.sessionId ?? null,
          outputSummary: result.outputSummary ?? null,
        });
      } catch (err) {
        log(`failed to finalize invocation ${invocationId} in DB: ${err}`);
      }

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
            isRateLimited: result.subtype === "rate_limited",
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

      // Finalize invocation as failed in DB immediately
      try {
        const { db } = getSchedulerDeps();
        updateInvocation(db, invocationId, {
          status: "failed",
          endedAt: new Date().toISOString(),
        });
      } catch (dbErr) {
        log(`failed to finalize invocation ${invocationId} in DB: ${dbErr}`);
      }

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
            isRateLimited: false,
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

          const claimed = claimTaskForDispatch(db, taskId);
          if (!claimed) {
            return {
              claimed: false,
              reason: `task ${taskId} not in a dispatchable state (stage: ${task.lifecycleStage}, phase: ${task.currentPhase})`,
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

          return { claimed: true, phase: task.currentPhase ?? "implement" };
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
          ["done", "failed", "canceled"].includes(freshTask.lifecycleStage!)
        ) {
          log(
            `task ${taskId} is ${freshTask?.lifecycleStage ?? "deleted"}, aborting stale workflow`,
          );
          insertSystemEvent(db, {
            type: "self_heal",
            message: `Aborted stale workflow for ${taskId} (stage: ${freshTask?.lifecycleStage ?? "deleted"})`,
            metadata: {
              taskId,
              previousStatus: freshTask?.lifecycleStage ?? "deleted",
              lifecycleStage: freshTask?.lifecycleStage ?? "deleted",
              currentPhase: freshTask?.currentPhase ?? null,
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

          const isFixPhase = task.currentPhase === "fix";
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
              wtResult = createWorktree(task.repoPath, taskId, 0, {
                baseRef,
              });
            } catch (err) {
              log(
                `task ${taskId}: implement spawn blocked by worktree error: ${err}`,
              );

              // Check consecutive worktree errors — fail permanently after 5
              const MAX_CONSECUTIVE_WORKTREE_ERRORS = 5;
              const transitions = getTaskStateTransitions(db, taskId);
              let consecutiveErrors = 0;
              for (let i = transitions.length - 1; i >= 0; i--) {
                if (transitions[i]!.reason === "spawn_blocked_worktree_error") {
                  consecutiveErrors++;
                } else {
                  break;
                }
              }

              if (consecutiveErrors >= MAX_CONSECUTIVE_WORKTREE_ERRORS) {
                log(
                  `task ${taskId}: ${consecutiveErrors} consecutive worktree errors — failing permanently`,
                );
                updateAndEmit(
                  db,
                  taskId,
                  "failed",
                  "worktree_error_limit_exceeded",
                  {
                    failureReason: `${consecutiveErrors} consecutive worktree creation failures`,
                    failedPhase: "implement",
                  },
                );
                return null;
              }

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
              const defaultBranch = getDefaultBranch(task.repoPath);
              agentPrompt += `\n\nThe PR branch has merge conflicts. Run \`git fetch origin && git rebase origin/${defaultBranch}\` to rebase onto ${defaultBranch}, resolve any conflicts, then force-push the branch.`;
              updateTaskFixReason(db, taskId, null);
            }
            appendSystemPrompt = config.fixSystemPrompt || undefined;
          } else {
            appendSystemPrompt = config.implementSystemPrompt || undefined;
          }

          if (appendSystemPrompt) {
            const defaultBranchForPrompt = getDefaultBranch(task.repoPath);
            appendSystemPrompt = appendSystemPrompt.replace(
              /\{\{DEFAULT_BRANCH_REF\}\}/g,
              `origin/${defaultBranchForPrompt}`,
            );
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
      | "awaiting_ci"
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
        ciStartedAt?: string;
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

              // Rate-limited sessions are not the agent's fault — retry without
              // incrementing the counter so real failures get full retry budget.
              if (implementEvent.data.isRateLimited) {
                log(
                  `task ${taskId}: rate limited — retrying without incrementing retry count (invocation ${invocationId})`,
                );
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

            // PR found but already merged — the work is done, skip review
            if (prInfo.merged) {
              log(
                `task ${taskId}: PR already merged (${prInfo.url}) — marking done`,
              );
              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }
              return markAlreadyDone(
                db,
                taskId,
                client,
                stateMap,
                worktreePath,
                "pr_already_merged",
              );
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

            const ciStartedAt = new Date().toISOString();
            updateTaskCiInfo(db, taskId, { ciStartedAt });
            updateAndEmit(db, taskId, "awaiting_ci", "pr_found");
            transitionToFinalState(
              { client, stateMap },
              taskId,
              "awaiting_ci",
              `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${storedBranch}\`, awaiting CI`,
            ).catch((err: unknown) => {
              logger.warn(
                "transitionToFinalState failed (gate2 → awaiting_ci)",
                {
                  taskId,
                  error: String(err),
                },
              );
            });

            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }

            log(
              `task ${taskId}: Gate 2 passed → awaiting_ci (PR #${prInfo.number ?? "?"})`,
            );
            return {
              outcome: "awaiting_ci",
              prBranch: storedBranch,
              prNumber: prInfo.number,
              ciStartedAt,
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
    // Step 6: Emit task/awaiting-ci to trigger CI gate workflow
    // -------------------------------------------------------------------------

    {
      const { db: awaitingDb, config: awaitingConfig } = getSchedulerDeps();
      await inngest.send({
        name: "task/awaiting-ci",
        data: {
          linearIssueId: taskId,
          prNumber: (gate2.prNumber ?? 0) as number,
          prBranchName: (gate2.prBranch ?? "") as string,
          repoPath:
            getTask(awaitingDb, taskId)?.repoPath ??
            awaitingConfig.defaultCwd ??
            "",
          ciStartedAt: gate2.ciStartedAt ?? new Date().toISOString(),
        },
      });
    }

    return { outcome: "awaiting_ci" };
  },
);
