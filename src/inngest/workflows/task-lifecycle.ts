// ---------------------------------------------------------------------------
// Task lifecycle Inngest workflow
//
// Replaces the scheduler's dispatch + phase handlers with a durable,
// step-based workflow. Uses step.waitForEvent() for 45-min Claude sessions
// so the workflow is resilient to server restarts and crashes.
//
// Trigger: task/ready
// Steps:  budget check → spawn implement → wait → Gate 2
//         → review loop (spawn review → wait → parse → spawn fix → wait → repeat)
//         → transition to awaiting_ci
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrcaDb } from "../../db/index.js";
import type { OrcaConfig } from "../../config/index.js";
import {
  getTask,
  getInvocation,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  insertBudgetEvent,
  sumCostInWindow,
  sumTokensInWindow,
  budgetWindowStart,
  incrementRetryCount,
  incrementReviewCycleCount,
  updateTaskPrBranch,
  updateTaskCiInfo,
  updateTaskDeployInfo,
  updateTaskFixReason,
  getLastMaxTurnsInvocation,
  getLastDeployInterruptedInvocation,
  getLastCompletedImplementInvocation,
  insertSystemEvent,
  countActiveSessions,
  clearSessionIds,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import type { SessionHandle } from "../../runner/index.js";
import {
  emitTaskUpdated,
  emitInvocationStarted,
  emitInvocationCompleted,
} from "../../events.js";
import { writeBackStatus } from "../../linear/sync.js";
import {
  sendAlert,
  sendPermanentFailureAlert,
} from "../../scheduler/alerts.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import {
  findPrForBranch,
  closeSupersededPrs,
  getPrCheckStatus,
} from "../../github/index.js";
import { git } from "../../git.js";
import {
  activeHandles,
  claimSessionSlot,
  releaseSessionSlot,
  getPendingSessionCount,
} from "../../session-handles.js";
import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import { createLogger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Concurrency cap — read from env at module load time so it's available when
// the Inngest function object is constructed.
// ---------------------------------------------------------------------------

const CONCURRENCY_CAP = parseInt(process.env.ORCA_CONCURRENCY_CAP ?? "1", 10);

/**
 * Process-level guard: throws if the number of active Claude sessions has
 * reached the concurrency cap. Uses THREE sources to prevent TOCTOU races:
 * 1. DB count of running invocations (survives deploys)
 * 2. pendingSessionCount (synchronous counter, incremented before spawn)
 * 3. activeHandles.size (in-memory handle registry)
 */
function assertSessionCapacity(db: OrcaDb): void {
  const dbCount = countActiveSessions(db);
  const pending = getPendingSessionCount();
  const effective = Math.max(dbCount, activeHandles.size, pending);
  if (effective >= CONCURRENCY_CAP) {
    throw new Error(
      `session cap reached: ${effective} active sessions (cap=${CONCURRENCY_CAP}), db=${dbCount}, handles=${activeHandles.size}, pending=${pending}`,
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
      releaseSessionSlot();

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
            `failed to send session/completed for invocation ${invocationId}: ${err}`,
          );
        });
    })
    .catch((err) => {
      activeHandles.delete(invocationId);
      releaseSessionSlot();

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
        .catch(() => {
          /* ignore secondary send failure */
        });
    });
}

// ---------------------------------------------------------------------------
// Shared: record budget event after a session completes
// ---------------------------------------------------------------------------

interface SessionEventData {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function recordBudgetEventFromEvent(
  db: OrcaDb,
  invocationId: number,
  eventData: SessionEventData,
): void {
  if (eventData.costUsd != null && eventData.costUsd > 0) {
    insertBudgetEvent(db, {
      invocationId,
      costUsd: eventData.costUsd,
      inputTokens: eventData.inputTokens ?? 0,
      outputTokens: eventData.outputTokens ?? 0,
      recordedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared: scan NDJSON session log for REVIEW_RESULT marker
// ---------------------------------------------------------------------------

function extractMarkerFromLog(invocationId: number): string | null {
  try {
    const logPath = join(process.cwd(), "logs", `${invocationId}.ndjson`);
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "assistant") continue;
        const message = msg.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            if (b.text.includes("REVIEW_RESULT:APPROVED")) return "APPROVED";
            if (b.text.includes("REVIEW_RESULT:CHANGES_REQUESTED"))
              return "CHANGES_REQUESTED";
          }
        }
      } catch {
        /* malformed line — skip */
      }
    }
  } catch {
    /* log unreadable — skip */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared: check if worktree has no commits ahead of origin/main
// ---------------------------------------------------------------------------

function worktreeHasNoChanges(worktreePath: string): boolean {
  try {
    if (!existsSync(worktreePath)) return false;
    const diff = git(["diff", "origin/main...HEAD"], { cwd: worktreePath });
    return diff.trim() === "";
  } catch {
    return false;
  }
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
      { limit: CONCURRENCY_CAP },
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
    if: "event.data.taskType != 'cron_claude' && event.data.taskType != 'cron_shell'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    log(`workflow started for task ${taskId}`);

    // -------------------------------------------------------------------------
    // Step 1: Budget check — fail fast if rolling budget is exhausted
    // -------------------------------------------------------------------------

    const budgetCheck = await step.run(
      "check-budget",
      (): { ok: boolean; reason?: string } => {
        const { db, config } = getSchedulerDeps();
        const windowStart = budgetWindowStart(config.budgetWindowHours);
        const spentUsd = sumCostInWindow(db, windowStart);
        if (spentUsd >= config.budgetMaxCostUsd) {
          return {
            ok: false,
            reason: `budget exhausted: $${spentUsd.toFixed(2)} >= $${config.budgetMaxCostUsd} in ${config.budgetWindowHours}h window`,
          };
        }
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
        `task ${taskId}: ${budgetCheck.reason ?? "budget exceeded"} — requeueing`,
      );
      await step.run("requeue-budget-exceeded", () => {
        const { db } = getSchedulerDeps();
        updateTaskStatus(db, taskId, "ready");
        const task = getTask(db, taskId);
        if (task) emitTaskUpdated(task);
      });
      return { outcome: "budget_exceeded", reason: budgetCheck.reason };
    }

    // -------------------------------------------------------------------------
    // Step 2: Claim task (atomic CAS: ready/in_review/changes_requested → dispatched)
    // -------------------------------------------------------------------------

    const claimResult = await step.run(
      "claim-task",
      (): { claimed: boolean; reason?: string; phase?: string } => {
        const { db, client, stateMap } = getSchedulerDeps();
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
        writeBackStatus(client, taskId, "dispatched", stateMap).catch((err) => {
          log(`write-back failed on claim for task ${taskId}: ${err}`);
        });

        return { claimed: true, phase: task.orcaStatus as string };
      },
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
      } => {
        const { db, config, client } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);

        // Detect resume scenarios
        let resumeSessionId: string | undefined;
        let resumeWorktreePath: string | undefined;
        let resumeBranchName: string | undefined;
        let isDeployResume = false;

        if (config.resumeOnMaxTurns) {
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
        if (isFixPhase && config.resumeOnFix) {
          const prevInv = getLastCompletedImplementInvocation(db, taskId);
          if (prevInv?.sessionId) {
            fixPhaseResumeSessionId = prevInv.sessionId;
          }
        }

        const model = isFixPhase ? config.fixModel : config.implementModel;

        let worktreePath: string;
        let branchName: string;

        if (resumeWorktreePath) {
          worktreePath = resumeWorktreePath;
          branchName = resumeBranchName ?? "unknown";
        } else {
          const baseRef = isFixPhase
            ? (task.prBranchName ?? undefined)
            : undefined;
          const wtResult = createWorktree(task.repoPath, taskId, 0, {
            baseRef,
          });
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

        // Check capacity BEFORE inserting invocation — inserting first would
        // leave a phantom "running" row in the DB if the check throws.
        assertSessionCapacity(db);
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

        const dispatchMsg = isDeployResume
          ? `Resuming after deploy interruption (invocation #${invocationId})`
          : resumeSessionId
            ? `Resuming session (invocation #${invocationId}, session ${resumeSessionId})`
            : isFixPhase
              ? `Dispatched to fix review feedback (invocation #${invocationId})`
              : `Dispatched for implementation (invocation #${invocationId})`;
        client.createComment(taskId, dispatchMsg).catch(() => {});

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
      },
    );

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

    const gate2 = await step.run(
      "process-implement-and-gate2",
      async (): Promise<{
        outcome: Gate2Outcome;
        prBranch?: string;
        prNumber?: number | null;
      }> => {
        const { db, config, client, stateMap } = getSchedulerDeps();
        const { invocationId, worktreePath, branchName } = implementCtx;

        if (!implementEvent) {
          log(
            `task ${taskId}: implement session timed out (invocation ${invocationId})`,
          );
          const timedOutHandle = activeHandles.get(invocationId);
          if (timedOutHandle) {
            killSession(timedOutHandle).catch(() => {});
            activeHandles.delete(invocationId);
            releaseSessionSlot();
          }
          updateInvocation(db, invocationId, {
            status: "timed_out",
            endedAt: new Date().toISOString(),
            outputSummary: "session timed out after 45 minutes",
          });
          updateTaskStatus(db, taskId, "failed");
          const updatedTask = getTask(db, taskId);
          if (updatedTask) emitTaskUpdated(updatedTask);
          try {
            removeWorktree(worktreePath);
          } catch {
            /* ignore */
          }
          return { outcome: "timed_out" };
        }

        const isSuccess =
          implementEvent.data.exitCode === 0 && !implementEvent.data.isMaxTurns;
        const invRecord = getInvocation(db, invocationId);
        const isMaxTurns = implementEvent.data.isMaxTurns;

        recordBudgetEventFromEvent(db, invocationId, implementEvent.data);

        emitInvocationCompleted({
          taskId,
          invocationId,
          status: isSuccess ? "completed" : "failed",
          costUsd: implementEvent.data.costUsd ?? 0,
          inputTokens: implementEvent.data.inputTokens ?? 0,
          outputTokens: implementEvent.data.outputTokens ?? 0,
        });
        updateInvocation(db, invocationId, {
          status: isSuccess ? "completed" : "failed",
          endedAt: new Date().toISOString(),
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
                  updateTaskStatus(db, taskId, "awaiting_ci");
                  updateTaskCiInfo(db, taskId, {
                    ciStartedAt: new Date().toISOString(),
                  });
                  const rescuedTask = getTask(db, taskId);
                  if (rescuedTask) emitTaskUpdated(rescuedTask);
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

          updateTaskStatus(db, taskId, "failed");
          const updatedTask = getTask(db, taskId);
          if (updatedTask) emitTaskUpdated(updatedTask);

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
              .catch(() => {});
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
            writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
              () => {},
            );
            client
              .createComment(
                taskId,
                `Task permanently failed after ${config.maxRetries} retries`,
              )
              .catch(() => {});
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
        const alreadyDonePatterns = [
          "already complete",
          "already implemented",
          "already merged",
          "already on main",
          "already exists",
          "already satisfied",
          "already done",
          "nothing to do",
          "no changes needed",
          "acceptance criteria",
        ];
        const isAlreadyDone = alreadyDonePatterns.some((p) =>
          outputSummary.includes(p),
        );
        const noChanges = worktreeHasNoChanges(worktreePath);

        if (!branchName) {
          if (isAlreadyDone || noChanges) {
            log(`task ${taskId}: work already on main — marking done`);
            updateTaskStatus(db, taskId, "done");
            insertSystemEvent(db, {
              type: "task_completed",
              message: `Task ${taskId} completed`,
              metadata: {
                taskId,
                phase: "implement",
                reason: "already_on_main",
              },
            });
            emitTaskUpdated(getTask(db, taskId)!);
            writeBackStatus(client, taskId, "done", stateMap).catch(() => {});
            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }
            return { outcome: "done" };
          }
          updateInvocation(db, invocationId, {
            status: "failed",
            outputSummary: "Post-implementation gate failed: no branch name",
          });
          updateTaskStatus(db, taskId, "failed");
          emitTaskUpdated(getTask(db, taskId) ?? task);
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
            writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
              () => {},
            );
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
            updateTaskStatus(db, taskId, "done");
            insertSystemEvent(db, {
              type: "task_completed",
              message: `Task ${taskId} completed`,
              metadata: { taskId, phase: "implement", reason: "already_done" },
            });
            emitTaskUpdated(getTask(db, taskId)!);
            writeBackStatus(client, taskId, "done", stateMap).catch(() => {});
            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }
            return { outcome: "done" };
          }
          log(
            `task ${taskId}: Gate 2 failed — no PR found for branch ${branchName}`,
          );
          updateInvocation(db, invocationId, {
            status: "failed",
            outputSummary: `Post-implementation gate failed: no PR found for branch ${branchName}`,
          });
          updateTaskStatus(db, taskId, "failed");
          emitTaskUpdated(getTask(db, taskId) ?? task);
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
            writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
              () => {},
            );
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
            .createAttachment(task.linearIssueId, prInfo.url, "Pull Request")
            .catch(() => {});
        }

        updateTaskStatus(db, taskId, "in_review");
        emitTaskUpdated(getTask(db, taskId)!);
        writeBackStatus(client, taskId, "in_review", stateMap).catch(() => {});
        client
          .createComment(
            taskId,
            `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${storedBranch}\``,
          )
          .catch(() => {});

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
    // Step 6+: Review-fix loop (up to maxReviewCycles)
    // -------------------------------------------------------------------------

    const { config: outerConfig } = getSchedulerDeps();
    for (let cycle = 0; cycle < outerConfig.maxReviewCycles; cycle++) {
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
        } => {
          const { db, config, client } = getSchedulerDeps();
          const task = getTask(db, taskId);
          if (!task) throw new Error(`task ${taskId} not found`);

          const prRef = task.prNumber ? `#${task.prNumber}` : "on this branch";
          const agentPrompt = `${task.agentPrompt ?? ""}\n\nReview PR ${prRef}. The PR branch is checked out in your working directory.`;

          const baseRef = task.prBranchName ?? undefined;
          const wtResult = createWorktree(task.repoPath, taskId, cycle, {
            baseRef,
          });

          assertSessionCapacity(db);
          claimSessionSlot();

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
          updateTaskStatus(db, taskId, "running");
          emitTaskUpdated(getTask(db, taskId)!);
          client
            .createComment(
              taskId,
              `Dispatched for code review (invocation #${invocationId}, cycle ${cycle + 1}/${config.maxReviewCycles})`,
            )
            .catch(() => {});

          log(
            `task ${taskId}: review session spawned as invocation ${invocationId} (cycle ${cycle + 1})`,
          );
          return {
            invocationId,
            worktreePath: wtResult.worktreePath,
            startedAt,
          };
        },
      );

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
        (): { outcome: ReviewOutcome } => {
          const { db } = getSchedulerDeps();
          const { invocationId, worktreePath } = reviewCtx;

          if (!reviewEvent) {
            log(
              `task ${taskId}: review session timed out (cycle ${cycle + 1})`,
            );
            const timedOutHandle = activeHandles.get(invocationId);
            if (timedOutHandle) {
              killSession(timedOutHandle).catch(() => {});
              activeHandles.delete(invocationId);
              releaseSessionSlot();
            }
            updateInvocation(db, invocationId, {
              status: "timed_out",
              endedAt: new Date().toISOString(),
              outputSummary: "review session timed out after 45 minutes",
            });
            updateTaskStatus(db, taskId, "in_review");
            const updatedTask = getTask(db, taskId);
            if (updatedTask) emitTaskUpdated(updatedTask);
            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }
            return { outcome: "timed_out" };
          }

          const isSuccess =
            reviewEvent.data.exitCode === 0 && !reviewEvent.data.isMaxTurns;
          emitInvocationCompleted({
            taskId,
            invocationId,
            status: isSuccess ? "completed" : "failed",
            costUsd: reviewEvent.data.costUsd ?? 0,
            inputTokens: reviewEvent.data.inputTokens ?? 0,
            outputTokens: reviewEvent.data.outputTokens ?? 0,
          });
          updateInvocation(db, invocationId, {
            status: isSuccess ? "completed" : "failed",
            endedAt: new Date().toISOString(),
            costUsd: reviewEvent.data.costUsd ?? null,
            inputTokens: reviewEvent.data.inputTokens ?? null,
            outputTokens: reviewEvent.data.outputTokens ?? null,
          });
          recordBudgetEventFromEvent(db, invocationId, reviewEvent.data);

          if (!isSuccess) {
            updateTaskStatus(db, taskId, "in_review");
            const updatedTask = getTask(db, taskId);
            if (updatedTask) emitTaskUpdated(updatedTask);
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
            const markerFromLog = extractMarkerFromLog(invocationId);
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
      );

      // -----------------------------------------------------------------------
      // 6d: Handle review outcome
      // -----------------------------------------------------------------------

      if (reviewResult.outcome === "approved") {
        const ciInfo = await step.run(`transition-awaiting-ci-${cycle}`, () => {
          const { db, client, stateMap } = getSchedulerDeps();
          const ciStartedAt = new Date().toISOString();
          updateTaskCiInfo(db, taskId, { ciStartedAt });
          updateTaskStatus(db, taskId, "awaiting_ci");
          emitTaskUpdated(getTask(db, taskId)!);
          writeBackStatus(client, taskId, "awaiting_ci", stateMap).catch(
            () => {},
          );
          const task = getTask(db, taskId);
          client
            .createComment(
              taskId,
              `Review approved — awaiting CI checks on PR #${task?.prNumber ?? "?"} before merging`,
            )
            .catch(() => {});
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
          const { db: ciDb, config: ciConfig } = getSchedulerDeps();
          await inngest.send({
            name: "task/awaiting-ci",
            data: {
              linearIssueId: taskId,
              prNumber: ciInfo.prNumber,
              prBranchName: ciInfo.prBranchName,
              repoPath:
                getTask(ciDb, taskId)?.repoPath ?? ciConfig.defaultCwd ?? "",
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
      const isLastCycle = cycle >= outerConfig.maxReviewCycles - 1;

      if (reviewResult.outcome === "no_marker" || isLastCycle) {
        await step.run(`cycles-exhausted-${cycle}`, () => {
          const { db, config, client } = getSchedulerDeps();
          updateTaskStatus(db, taskId, "in_review");
          const updatedTask = getTask(db, taskId);
          if (updatedTask) emitTaskUpdated(updatedTask);
          const reason =
            reviewResult.outcome === "no_marker"
              ? "no REVIEW_RESULT marker found"
              : `review cycles exhausted (${config.maxReviewCycles}/${config.maxReviewCycles})`;
          client
            .createComment(
              taskId,
              `Review loop ended: ${reason} — manual intervention required`,
            )
            .catch(() => {});
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
        } => {
          const { db, config, client, stateMap } = getSchedulerDeps();
          const task = getTask(db, taskId);
          if (!task) throw new Error(`task ${taskId} not found`);

          incrementReviewCycleCount(db, taskId);
          updateTaskStatus(db, taskId, "changes_requested");
          emitTaskUpdated(getTask(db, taskId)!);
          writeBackStatus(client, taskId, "changes_requested", stateMap).catch(
            () => {},
          );

          let resumeSessionId: string | undefined;
          if (config.resumeOnFix) {
            const prevInv = getLastCompletedImplementInvocation(db, taskId);
            if (prevInv?.sessionId) resumeSessionId = prevInv.sessionId;
          }

          const baseRef = task.prBranchName ?? undefined;
          const wtResult = createWorktree(task.repoPath, taskId, cycle + 1000, {
            baseRef,
          });

          let agentPrompt = task.agentPrompt ?? "";
          if (task.fixReason === "merge_conflict") {
            agentPrompt +=
              "\n\nThe PR branch has merge conflicts. Run `git fetch origin && git rebase origin/main` to rebase onto main, resolve any conflicts, then force-push the branch.";
            updateTaskFixReason(db, taskId, null);
          }

          assertSessionCapacity(db);
          claimSessionSlot();

          const now = new Date().toISOString();
          const invocationId = insertInvocation(db, {
            linearIssueId: taskId,
            startedAt: now,
            status: "running",
            phase: "implement",
            model: config.fixModel,
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
            model: config.fixModel,
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
          updateTaskStatus(db, taskId, "running");
          emitTaskUpdated(getTask(db, taskId)!);

          const reviewCycle = task.reviewCycleCount + 1;
          client
            .createComment(
              taskId,
              resumeSessionId
                ? `Dispatched to fix review feedback with session resume (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`
                : `Dispatched to fix review feedback (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`,
            )
            .catch(() => {});

          log(
            `task ${taskId}: fix session spawned as invocation ${invocationId} (review cycle ${reviewCycle})`,
          );
          return {
            invocationId,
            worktreePath: wtResult.worktreePath,
            startedAt,
          };
        },
      );

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
        (): { ok: boolean; timedOut: boolean; resumeNotFound: boolean } => {
          const { db, client, stateMap } = getSchedulerDeps();
          const { invocationId, worktreePath } = fixCtx;

          if (!fixEvent) {
            log(`task ${taskId}: fix session timed out (cycle ${cycle + 1})`);
            const timedOutHandle = activeHandles.get(invocationId);
            if (timedOutHandle) {
              killSession(timedOutHandle).catch(() => {});
              activeHandles.delete(invocationId);
              releaseSessionSlot();
            }
            updateInvocation(db, invocationId, {
              status: "timed_out",
              endedAt: new Date().toISOString(),
              outputSummary: "fix session timed out after 45 minutes",
            });
            updateTaskStatus(db, taskId, "in_review");
            const updatedTask = getTask(db, taskId);
            if (updatedTask) emitTaskUpdated(updatedTask);
            try {
              removeWorktree(worktreePath);
            } catch {
              /* ignore */
            }
            return { ok: false, timedOut: true, resumeNotFound: false };
          }

          const isSuccess =
            fixEvent.data.exitCode === 0 && !fixEvent.data.isMaxTurns;
          emitInvocationCompleted({
            taskId,
            invocationId,
            status: isSuccess ? "completed" : "failed",
            costUsd: fixEvent.data.costUsd ?? 0,
            inputTokens: fixEvent.data.inputTokens ?? 0,
            outputTokens: fixEvent.data.outputTokens ?? 0,
          });
          updateInvocation(db, invocationId, {
            status: isSuccess ? "completed" : "failed",
            endedAt: new Date().toISOString(),
            costUsd: fixEvent.data.costUsd ?? null,
            inputTokens: fixEvent.data.inputTokens ?? null,
            outputTokens: fixEvent.data.outputTokens ?? null,
          });
          recordBudgetEventFromEvent(db, invocationId, fixEvent.data);

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
                .catch(() => {});
              updateTaskStatus(db, taskId, "in_review");
              const updatedTask = getTask(db, taskId);
              if (updatedTask) emitTaskUpdated(updatedTask);
              return { ok: false, timedOut: false, resumeNotFound: true };
            }
            updateTaskStatus(db, taskId, "in_review");
            const updatedTask = getTask(db, taskId);
            if (updatedTask) emitTaskUpdated(updatedTask);
            return { ok: false, timedOut: false, resumeNotFound: false };
          }

          // Fix succeeded — transition back to in_review for next review cycle
          updateTaskStatus(db, taskId, "in_review");
          emitTaskUpdated(getTask(db, taskId)!);
          writeBackStatus(client, taskId, "in_review", stateMap).catch(
            () => {},
          );
          log(`task ${taskId}: fix complete → in_review (cycle ${cycle + 1})`);
          return { ok: true, timedOut: false, resumeNotFound: false };
        },
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
