// PR lifecycle gates verified
import { isDraining } from "../deploy.js";
import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import {
  countActiveSessions,
  getAllTasks,
  getAwaitingCiTasks,
  getDeployingTasks,
  getDispatchableTasks,
  getInvocationsByTask,
  getLastCompletedImplementInvocation,
  getLastMaxTurnsInvocation,
  getRunningInvocations,
  getTask,
  incrementMergeAttemptCount,
  resetMergeAttemptCount,
  incrementRetryCount,
  incrementReviewCycleCount,
  incrementStaleSessionRetryCount,
  insertBudgetEvent,
  insertInvocation,
  sumTokensInWindow,
  budgetWindowStart,
  updateInvocation,
  updateTaskCiInfo,
  updateTaskDeployInfo,
  updateTaskFixReason,
  updateTaskPrBranch,
  updateTaskStatus,
  claimTaskForDispatch,
} from "../db/queries.js";
import type { TaskStatus } from "../db/schema.js";
import {
  emitTaskUpdated,
  emitInvocationStarted,
  emitInvocationCompleted,
  emitStatusUpdated,
} from "../events.js";
import {
  spawnSession,
  killSession,
  type SessionHandle,
  type SessionResult,
} from "../runner/index.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorktree, removeWorktree } from "../worktree/index.js";
import { isTransientGitError, isDllInitError, git } from "../git.js";
import {
  findPrForBranch,
  findPrByUrl,
  getMergeCommitSha,
  getPrCheckStatus,
  getWorkflowRunStatus,
  mergePr,
  getPrMergeState,
  updatePrBranch,
  rebasePrBranch,
  closeSupersededPrs,
} from "../github/index.js";
import {
  cleanupStaleResources,
  cleanupOldInvocationLogs,
} from "../cleanup/index.js";
import type { DependencyGraph } from "../linear/graph.js";
import type { LinearClient, WorkflowStateMap } from "../linear/client.js";
import { writeBackStatus, evaluateParentStatuses } from "../linear/sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DispatchPhase = "implement" | "review";

export interface SchedulerDeps {
  db: OrcaDb;
  config: OrcaConfig;
  graph: DependencyGraph;
  client: LinearClient;
  stateMap: WorkflowStateMap;
}

export interface SchedulerHandle {
  stop: () => void;
  start: () => void;
  running: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Active session handles keyed by invocation ID.
 * Exported so the CLI shutdown handler can iterate and kill them.
 */
export const activeHandles = new Map<number, SessionHandle>();

/**
 * Consecutive transient worktree-creation failure count per task ID.
 * After TRANSIENT_FAILURE_LIMIT consecutive transient failures, the task
 * falls through to the normal retry path (burns a real retry) so the
 * scheduler doesn't spin forever on a persistent "transient" error.
 */
const transientFailureCounts = new Map<string, number>();
const TRANSIENT_FAILURE_LIMIT = 5;

/**
 * Per-task count of times the transient worktree-creation circuit breaker
 * has tripped. After config.maxWorktreeRetries trips, the task is
 * permanently failed regardless of retryCount.
 */
const worktreeBurnedRetries = new Map<string, number>();

/**
 * Per-task count of review completions that lack a REVIEW_RESULT marker.
 * After NO_MARKER_RETRY_LIMIT attempts, the task burns a real retry instead
 * of looping indefinitely.
 */
const noMarkerRetryCounts = new Map<string, number>();
const NO_MARKER_RETRY_LIMIT = 3;

/**
 * In-memory cooldown map for rate-limited tasks.
 * Maps taskId → epoch ms when the rate limit resets.
 * Tasks in this map with a future expiry are skipped during dispatch.
 */
const rateLimitCooldowns = new Map<string, number>();

/** Tasks that have reached a terminal state — block further writeBackStatus calls. */
const terminalWriteBackTasks = new Set<string>();

/**
 * Global cooldown timestamp. When ANY git command hits DLL_INIT
 * (0xC0000142 — Windows resource exhaustion), ALL git-based operations
 * (dispatch AND cleanup) pause until the cooldown expires.
 *
 * DLL_INIT is a system-wide condition, not per-repo. Pausing everything
 * prevents the death spiral where retries spawn more processes into an
 * already-exhausted system.
 */
let globalDllCooldownUntil = 0;
const GLOBAL_DLL_COOLDOWN_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
}

// ---------------------------------------------------------------------------
// Parent evaluation helper
// ---------------------------------------------------------------------------

function triggerParentEval(deps: SchedulerDeps, taskId: string): void {
  const task = getTask(deps.db, taskId);
  if (task?.parentIdentifier) {
    evaluateParentStatuses(deps.db, deps.client, deps.stateMap, [
      task.parentIdentifier,
    ]).catch((err) => {
      log(`parent eval failed for ${taskId}: ${err}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Phase-aware dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  deps: SchedulerDeps,
  task: ReturnType<typeof getDispatchableTasks>[number],
  phase: DispatchPhase,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const taskId = task.linearIssueId;

  // Clear terminal flag — this task has been re-activated for dispatch.
  terminalWriteBackTasks.delete(taskId);

  // Guard: ensure no running invocation already exists for this task.
  const runningInvs = getRunningInvocations(db);
  const alreadyRunning = runningInvs.some(
    (inv) => inv.linearIssueId === taskId,
  );
  if (alreadyRunning) {
    log(`dispatch aborted: task ${taskId} already has a running invocation`);
    return;
  }

  // Atomically claim the task via compare-and-swap.
  const claimed = claimTaskForDispatch(db, taskId, [
    "ready",
    "in_review",
    "changes_requested",
  ]);
  if (!claimed) {
    log(
      `dispatch aborted: task ${taskId} is no longer dispatchable (lost CAS race or status changed)`,
    );
    return;
  }
  emitTaskUpdated(getTask(db, taskId)!);

  // Write-back on dispatch: implement/fix → "In Progress", review → skip (already "In Review")
  if (phase === "implement" && !terminalWriteBackTasks.has(taskId)) {
    writeBackStatus(client, taskId, "dispatched", stateMap).catch((err) => {
      log(`write-back failed on dispatch for task ${taskId}: ${err}`);
    });
  }

  // 2. Detect resume scenario (max-turns retry on implement phase)
  let resumeSessionId: string | undefined;
  let resumeWorktreePath: string | undefined;
  let resumeBranchName: string | undefined;

  if (
    phase === "implement" &&
    task.orcaStatus !== "changes_requested" &&
    config.resumeOnMaxTurns
  ) {
    const prevInv = getLastMaxTurnsInvocation(db, taskId);
    if (prevInv && prevInv.worktreePath && existsSync(prevInv.worktreePath)) {
      resumeSessionId = prevInv.sessionId!;
      resumeWorktreePath = prevInv.worktreePath;
      resumeBranchName = prevInv.branchName ?? undefined;
      log(
        `resume candidate found for task ${taskId}: session ${resumeSessionId}, worktree ${resumeWorktreePath}`,
      );
    } else if (prevInv) {
      log(
        `resume candidate for task ${taskId} has missing worktree (${prevInv.worktreePath}) — fresh dispatch`,
      );
    }
  }

  // Case 2: Fix phase resumes implement session
  if (
    phase === "implement" &&
    task.orcaStatus === "changes_requested" &&
    config.resumeOnFix
  ) {
    const prevInv = getLastCompletedImplementInvocation(db, taskId);
    if (prevInv?.sessionId) {
      resumeSessionId = prevInv.sessionId;
      // No worktreePath — fix phase creates its own worktree from the PR branch
      log(`fix-phase resume: session ${resumeSessionId} for task ${taskId}`);
    }
  }

  const isResume = resumeSessionId != null;
  const isWorktreeResume = resumeWorktreePath != null;

  // 3. Determine model for this phase (needed for invocation record)
  const model =
    phase === "review"
      ? config.reviewModel
      : task.orcaStatus === "changes_requested"
        ? config.fixModel
        : config.implementModel;

  // 4. Insert invocation record with phase and model
  const now = new Date().toISOString();
  const invocationId = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now,
    status: "running",
    phase,
    model,
  });

  const logPath = `logs/${invocationId}.ndjson`;

  // Post dispatch comment to Linear (fire-and-forget)
  const dispatchComment =
    phase === "review"
      ? `Dispatched for code review (invocation #${invocationId}, cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`
      : task.orcaStatus === "changes_requested"
        ? isResume
          ? `Dispatched to fix review feedback with session resume (invocation #${invocationId}, session ${resumeSessionId}, cycle ${task.reviewCycleCount}/${config.maxReviewCycles})`
          : `Dispatched to fix review feedback (invocation #${invocationId}, cycle ${task.reviewCycleCount}/${config.maxReviewCycles})`
        : isResume
          ? `Resuming session (invocation #${invocationId}, session ${resumeSessionId})`
          : `Dispatched for implementation (invocation #${invocationId})`;
  client.createComment(taskId, dispatchComment).catch((err) => {
    log(`comment failed on dispatch for task ${taskId}: ${err}`);
  });

  // 4. Determine worktree base ref
  const useExistingBranch =
    phase === "review" ||
    (phase === "implement" && task.orcaStatus === "changes_requested");
  const baseRef =
    useExistingBranch && task.prBranchName ? task.prBranchName : undefined;

  // 5. Create or reuse worktree
  let worktreeResult: { worktreePath: string; branchName: string };

  if (isWorktreeResume) {
    // Reuse preserved worktree from previous max-turns invocation
    worktreeResult = {
      worktreePath: resumeWorktreePath!,
      branchName: resumeBranchName ?? "unknown",
    };
    log(
      `reusing preserved worktree for resume: ${worktreeResult.worktreePath}`,
    );
  } else {
    try {
      worktreeResult = createWorktree(task.repoPath, taskId, invocationId, {
        baseRef,
      });
      // Successful worktree creation — reset transient failure counter and global cooldown
      transientFailureCounts.delete(taskId);
      worktreeBurnedRetries.delete(taskId);
      if (globalDllCooldownUntil > 0) {
        log("worktree creation succeeded — clearing DLL_INIT cooldown");
        globalDllCooldownUntil = 0;
      }
    } catch (err) {
      log(`worktree creation failed for task ${taskId}: ${err}`);

      if (isDllInitError(err)) {
        // DLL_INIT is system-wide resource exhaustion. Activate global
        // cooldown to stop ALL git operations (dispatch + cleanup).
        globalDllCooldownUntil = Date.now() + GLOBAL_DLL_COOLDOWN_MS;
        log(
          `DLL_INIT detected — global cooldown for ${GLOBAL_DLL_COOLDOWN_MS / 1000}s (all git ops paused)`,
        );
      }

      if (isTransientGitError(err)) {
        const count = (transientFailureCounts.get(taskId) ?? 0) + 1;
        transientFailureCounts.set(taskId, count);

        if (count < TRANSIENT_FAILURE_LIMIT) {
          // Transient failure — re-queue without burning a retry.
          log(
            `transient error for task ${taskId} (${count}/${TRANSIENT_FAILURE_LIMIT}) — re-queuing`,
          );
          updateTaskStatus(
            db,
            taskId,
            task.orcaStatus === "in_review"
              ? "in_review"
              : task.orcaStatus === "changes_requested"
                ? "changes_requested"
                : "ready",
          );
          updateInvocation(db, invocationId, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: `worktree creation failed (transient ${count}/${TRANSIENT_FAILURE_LIMIT}, re-queued): ${err}`,
          });
          emitTaskUpdated(getTask(db, taskId)!);
          return;
        }

        // Circuit breaker tripped — burn a real retry.
        const burned = (worktreeBurnedRetries.get(taskId) ?? 0) + 1;
        worktreeBurnedRetries.set(taskId, burned);
        log(
          `transient circuit breaker for task ${taskId} after ${count} failures (burned ${burned}/${config.maxWorktreeRetries}) — burning retry`,
        );
        transientFailureCounts.delete(taskId);

        if (burned >= config.maxWorktreeRetries) {
          // Exhausted worktree retry budget — permanently fail without going through handleRetry
          worktreeBurnedRetries.delete(taskId);
          const permanentSummary = `persistent worktree creation failure after ${burned} retries: ${err}`;
          log(`task ${taskId}: ${permanentSummary} — permanently failing`);
          updateTaskStatus(db, taskId, "failed");
          updateInvocation(db, invocationId, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: permanentSummary,
          });
          emitTaskUpdated(getTask(db, taskId)!);
          // Write-back to Linear as Canceled (fire-and-forget)
          if (!terminalWriteBackTasks.has(taskId)) {
            terminalWriteBackTasks.add(taskId);
            writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
              (writeErr) => {
                log(
                  `write-back failed on permanent worktree failure for task ${taskId}: ${writeErr}`,
                );
              },
            );
            client
              .createComment(
                taskId,
                `Task permanently failed: ${permanentSummary}`,
              )
              .catch((commentErr) => {
                log(
                  `comment failed on permanent worktree failure for task ${taskId}: ${commentErr}`,
                );
              });
          }
          return;
        }

        // Not yet at the burned retry limit — fall through to handleRetry
      }

      // Non-transient error or circuit breaker below maxWorktreeRetries — mark failed, burn retry
      updateTaskStatus(db, taskId, "failed");
      updateInvocation(db, invocationId, {
        status: "failed",
        endedAt: new Date().toISOString(),
        outputSummary: `worktree creation failed: ${err}`,
      });
      emitTaskUpdated(getTask(db, taskId)!);
      handleRetry(deps, taskId, `worktree creation failed: ${err}`, phase);
      return;
    }
  }

  // 6. Build agent prompt and system prompt based on phase
  let agentPrompt = task.agentPrompt;
  let systemPrompt: string | undefined;
  let maxTurns = config.defaultMaxTurns;

  // Always block interactive-only tools; merge with user-configured list
  const ALWAYS_DISALLOWED = ["EnterPlanMode", "AskUserQuestion"];
  const userDisallowed = config.disallowedTools
    ? config.disallowedTools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const disallowedTools = [
    ...new Set([...ALWAYS_DISALLOWED, ...userDisallowed]),
  ];

  if (phase === "review") {
    const prRef = task.prNumber ? `#${task.prNumber}` : "on this branch";
    agentPrompt = `${task.agentPrompt}\n\nReview PR ${prRef}. The PR branch is checked out in your working directory.`;
    systemPrompt = config.reviewSystemPrompt || undefined;
    maxTurns = config.reviewMaxTurns;
  } else if (useExistingBranch) {
    // Fix phase (implement on changes_requested)
    if (task.fixReason === "merge_conflict") {
      agentPrompt = `${task.agentPrompt}\n\nThe PR branch has merge conflicts. Run \`git fetch origin && git rebase origin/main\` to rebase onto main, resolve any conflicts, then force-push the branch.`;
      // Clear the fix reason so subsequent fix cycles (if needed) use the normal prompt
      updateTaskFixReason(db, taskId, null);
    } else {
      agentPrompt = isResume
        ? `You previously implemented this task. The code review requested changes — fix the issues raised in the review.`
        : `${task.agentPrompt}\n\nFix issues from code review.`;
    }
    systemPrompt = config.fixSystemPrompt || undefined;
  } else if (isResume) {
    // Resume: continuation prompt instead of full task prompt
    agentPrompt = `You hit the maximum turn limit. Continue where you left off — complete the implementation, commit, push, and open a PR.\n\nIMPORTANT: This worktree is pre-configured with branch \`${worktreeResult.branchName}\`. You MUST push on this branch — do NOT create a new branch.`;
    systemPrompt = config.implementSystemPrompt || undefined;
  } else {
    // Normal implement — inject the pre-created branch name so the agent doesn't create its own
    agentPrompt = `${task.agentPrompt}\n\nIMPORTANT: This worktree is pre-configured with branch \`${worktreeResult.branchName}\`. You MUST commit and push on this branch — do NOT create a new branch. Run \`git branch --show-current\` to confirm before pushing.`;
    systemPrompt = config.implementSystemPrompt || undefined;
  }

  // 8. Spawn session
  const handle = spawnSession({
    agentPrompt,
    worktreePath: worktreeResult.worktreePath,
    maxTurns,
    invocationId,
    projectRoot: process.cwd(),
    claudePath: config.claudePath,
    appendSystemPrompt: systemPrompt,
    disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
    resumeSessionId,
    repoPath: task.repoPath,
    model,
  });

  // 9. Update task to running
  updateTaskStatus(db, taskId, "running");

  // 10. Update invocation with worktree details
  updateInvocation(db, invocationId, {
    branchName: worktreeResult.branchName,
    worktreePath: worktreeResult.worktreePath,
    logPath,
  });

  // 11. Store handle
  activeHandles.set(invocationId, handle);
  emitInvocationStarted({ taskId, invocationId });

  log(
    `${isResume ? "resumed" : "dispatched"} task ${taskId} as invocation ${invocationId} ` +
      `(phase: ${phase}, model: ${model}, branch: ${worktreeResult.branchName}${isResume ? `, session: ${resumeSessionId}` : ""})`,
  );

  // 12. Attach completion handler
  const fixPhase = useExistingBranch && phase === "implement";
  attachCompletionHandler(
    deps,
    taskId,
    invocationId,
    handle,
    worktreeResult.worktreePath,
    phase,
    fixPhase,
  );
}

// ---------------------------------------------------------------------------
// Session completion handler
// ---------------------------------------------------------------------------

/**
 * Attach the standard completion/error handler to a session handle.
 * Used by both the scheduler's `dispatch()` and the CLI's manual dispatch.
 */
export function attachCompletionHandler(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  handle: SessionHandle,
  worktreePath: string,
  phase: DispatchPhase,
  isFixPhase = false,
): void {
  handle.done
    .then((result) => {
      onSessionComplete(
        deps,
        taskId,
        invocationId,
        handle,
        result,
        worktreePath,
        phase,
        isFixPhase,
      );
    })
    .catch((err) => {
      log(
        `completion handler error for invocation ${invocationId} (task ${taskId}): ${err}`,
      );
      activeHandles.delete(invocationId);
      try {
        updateInvocation(deps.db, invocationId, {
          status: "failed",
          endedAt: new Date().toISOString(),
          outputSummary: `completion handler error: ${err}`,
        });
        updateTaskStatus(deps.db, taskId, "failed");
        handleRetry(deps, taskId);
      } catch (cleanupErr) {
        log(
          `cleanup also failed for invocation ${invocationId}: ${cleanupErr}`,
        );
      }
    });
}

async function onSessionComplete(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  handle: SessionHandle,
  result: SessionResult,
  worktreePath: string,
  phase: DispatchPhase,
  isFixPhase: boolean,
): Promise<void> {
  const { db, config, client: _client, stateMap: _stateMap } = deps;

  // Remove from active handles
  activeHandles.delete(invocationId);

  const isSuccess = result.subtype === "success";
  const invocationStatus = isSuccess ? "completed" : "failed";

  // 1. Update invocation
  updateInvocation(db, invocationId, {
    endedAt: new Date().toISOString(),
    status: invocationStatus,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    numTurns: result.numTurns,
    outputSummary: result.outputSummary,
    sessionId: handle.sessionId,
  });

  // 2. Insert budget event if tokens are available
  const inputTokens = result.inputTokens ?? 0;
  const outputTokens = result.outputTokens ?? 0;
  if (inputTokens > 0 || outputTokens > 0) {
    insertBudgetEvent(db, {
      invocationId,
      costUsd: result.costUsd,
      inputTokens,
      outputTokens,
      recordedAt: new Date().toISOString(),
    });
  }

  log(
    `session complete: task=${taskId} invocation=${invocationId} status=${invocationStatus} ` +
      `tokens=${inputTokens + outputTokens} (in=${inputTokens} out=${outputTokens}) turns=${result.numTurns ?? "unknown"}`,
  );

  // Emit task updated + invocation completed events
  emitTaskUpdated(getTask(db, taskId)!);
  emitInvocationCompleted({
    taskId,
    invocationId,
    status: invocationStatus,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
  });

  // Emit current status
  emitCurrentStatus(db, config);

  // Guard: if the task is already in a terminal state (done, failed, deploying),
  // skip phase handlers. This catches orphaned invocations that complete after
  // another invocation already moved the task forward.
  const currentTask = getTask(db, taskId);
  if (currentTask) {
    const terminalStatuses = new Set<TaskStatus>([
      "done",
      "failed",
      "deploying",
      "awaiting_ci",
    ]);
    if (terminalStatuses.has(currentTask.orcaStatus)) {
      log(
        `invocation ${invocationId}: task ${taskId} is already "${currentTask.orcaStatus}" — ` +
          `skipping ${phase} completion handler`,
      );
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for orphaned invocation ${invocationId}: ${err}`);
      }
      return;
    }
  }

  if (isSuccess) {
    if (phase === "implement") {
      onImplementSuccess(deps, taskId, invocationId, worktreePath, result);
    } else {
      try {
        await onReviewSuccess(deps, taskId, invocationId, worktreePath, result);
      } catch (err) {
        log(`onReviewSuccess error for task ${taskId}: ${err}`);
      }
    }
  } else {
    onSessionFailure(
      deps,
      taskId,
      invocationId,
      worktreePath,
      result,
      phase,
      isFixPhase,
    );
  }

  // Evaluate parent status if this task is a child
  triggerParentEval(deps, taskId);
}

// ---------------------------------------------------------------------------
// Helper: detect whether a worktree has no local commits vs origin/main
// ---------------------------------------------------------------------------

/**
 * Returns true if the worktree at `worktreePath` has no commits ahead of
 * `origin/main`. Used to objectively detect "already done" tasks where
 * Claude succeeded but made no changes (because none were needed).
 */
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
// Implement success: verify PR, transition to in_review
// ---------------------------------------------------------------------------

function onImplementSuccess(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
): void {
  const { db, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) return;

  // Get branch name from the invocation record
  const invocations = getInvocationsByTask(db, taskId);
  const thisInv = invocations.find((inv) => inv.id === invocationId);
  const branchName = thisInv?.branchName ?? task.prBranchName;

  // Check if Claude indicated the work is already on main (no branch/PR needed)
  const summary = result.outputSummary?.toLowerCase() ?? "";
  const alreadyDonePatterns = [
    "already complete",
    "already implemented",
    "already merged",
    "already on main",
    "already on `main`",
    "already on `origin/main`",
    "already exists",
    "already satisfied",
    "already done",
    "nothing to do",
    "no changes needed",
    "acceptance criteria",
  ];
  const isAlreadyDone = alreadyDonePatterns.some((p) => summary.includes(p));

  // Hard gate: branch name is required
  if (!branchName) {
    // Objective check: if the worktree has no commits ahead of origin/main,
    // Claude made no changes — the task was already complete.
    const noChanges = worktreeHasNoChanges(worktreePath);
    if (noChanges || isAlreadyDone) {
      const reason = noChanges
        ? "no local commits on worktree"
        : "output summary indicates already done";
      log(
        `task ${taskId}: work already complete on main (${reason}) — marking done`,
      );
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on already-done for task ${taskId}: ${err}`);
      });
      try {
        const closedCount = closeSupersededPrs(
          taskId,
          0,
          0,
          "",
          task.repoPath,
          "Closed: the task was already complete on the main branch — no changes were needed.",
        );
        if (closedCount > 0) {
          log(
            `closed ${closedCount} orphaned PR(s) for already-done task ${taskId}`,
          );
        }
      } catch (err) {
        log(`PR cleanup for already-done task ${taskId}: ${err}`);
      }
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for already-done task ${taskId}: ${err}`);
      }
      return;
    }

    const gateMsg = "no branch name found on invocation or task";
    log(`task ${taskId}: ${gateMsg} — treating as failure`);
    updateInvocation(db, invocationId, {
      status: "failed",
      outputSummary: `Post-implementation gate failed: ${gateMsg}`,
    });
    onSessionFailure(
      deps,
      taskId,
      invocationId,
      worktreePath,
      result,
      "implement",
    );
    return;
  }

  // Hard gate: PR must exist
  let prInfo = findPrForBranch(branchName, task.repoPath);
  let wrongRepoUrlFound = false;
  let rejectedUrl: string | undefined;
  if (!prInfo.exists) {
    // Fallback: try to verify via PR URL extracted from Claude's summary.
    // This handles GitHub API lag or branch name mismatches where
    // `gh pr list --head <branch>` returns empty but the PR was created.
    const rawSummary = result.outputSummary ?? "";
    const prUrlMatch = rawSummary.match(
      /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/,
    );
    if (prUrlMatch) {
      const extractedUrl = prUrlMatch[0];
      // Validate the extracted URL belongs to the same repo as task.repoPath.
      // This prevents an unrelated PR URL mentioned in the summary from
      // hijacking Gate 2 (e.g. a reference PR from another org/repo).
      let repoUrlPrefix: string | null = null;
      try {
        const remoteUrl = git(["remote", "get-url", "origin"], {
          cwd: task.repoPath,
        }).trim();
        // Normalize SSH → HTTPS: git@github.com:owner/repo.git → https://github.com/owner/repo
        const sshMatch = remoteUrl.match(
          /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/,
        );
        if (sshMatch) {
          repoUrlPrefix = `https://github.com/${sshMatch[1]}/pull/`;
        }
      } catch {
        // If we can't get the remote URL, skip the validation (allow fallback)
      }
      const urlBelongsToRepo =
        repoUrlPrefix === null || extractedUrl.startsWith(repoUrlPrefix);
      if (urlBelongsToRepo) {
        log(
          `task ${taskId}: Gate 2 branch lookup found no PR for ${branchName}, ` +
            `trying PR URL from summary: ${extractedUrl}`,
        );
        const urlInfo = findPrByUrl(extractedUrl, task.repoPath);
        if (urlInfo.exists) {
          log(
            `task ${taskId}: Gate 2 PR confirmed via URL fallback (PR #${urlInfo.number})`,
          );
          prInfo = urlInfo;
        }
      } else {
        log(
          `task ${taskId}: Gate 2 skipping PR URL from summary (wrong repo): ${extractedUrl}`,
        );
        wrongRepoUrlFound = true;
        rejectedUrl = extractedUrl;
      }
    }
  }

  if (!prInfo.exists) {
    // Check objectively (git diff) or via text patterns if no PR was opened
    const noChanges = worktreeHasNoChanges(worktreePath);
    if (!wrongRepoUrlFound && (noChanges || isAlreadyDone)) {
      const reason = noChanges
        ? "no local commits on worktree"
        : "output summary indicates already done";
      log(
        `task ${taskId}: work already complete on main (no PR needed, ${reason}) — marking done`,
      );
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on already-done for task ${taskId}: ${err}`);
      });
      try {
        const closedCount = closeSupersededPrs(
          taskId,
          0,
          0,
          "",
          task.repoPath,
          "Closed: the task was already complete on the main branch — no changes were needed.",
        );
        if (closedCount > 0) {
          log(
            `closed ${closedCount} orphaned PR(s) for already-done task ${taskId}`,
          );
        }
      } catch (err) {
        log(`PR cleanup for already-done task ${taskId}: ${err}`);
      }
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for already-done task ${taskId}: ${err}`);
      }
      return;
    }

    if (wrongRepoUrlFound && noChanges) {
      log(
        `task ${taskId}: Gate 2 found PR URL in summary but it belongs to a different repo (${rejectedUrl}) — likely repo_path mismatch; treating as failure for manual review`,
      );
    }
    const gateMsg = `no PR found for branch ${branchName}`;
    log(
      `task ${taskId}: implementation succeeded but ${gateMsg} — treating as failure`,
    );
    updateInvocation(db, invocationId, {
      status: "failed",
      outputSummary: `Post-implementation gate failed: ${gateMsg}`,
    });
    onSessionFailure(
      deps,
      taskId,
      invocationId,
      worktreePath,
      result,
      "implement",
    );
    return;
  }

  // Store the PR branch name and PR number on the task
  updateTaskPrBranch(db, taskId, branchName);
  if (prInfo.number != null) {
    updateTaskDeployInfo(db, taskId, { prNumber: prInfo.number });
  }

  // Close any superseded PRs for this task
  if (prInfo.number != null) {
    const supersededCount = closeSupersededPrs(
      taskId,
      prInfo.number,
      invocationId,
      branchName,
      task.repoPath,
    );
    if (supersededCount > 0) {
      log(`closed ${supersededCount} superseded PR(s) for task ${taskId}`);
    }
  } else {
    log(
      `skipping superseded PR closure for task ${taskId}: no PR number available`,
    );
  }

  // Attach PR link to Linear issue (fire-and-forget)
  if (prInfo.url) {
    client
      .createAttachment(task.linearIssueId, prInfo.url, "Pull Request")
      .catch((err) => {
        log(`failed to attach PR link to Linear issue ${taskId}: ${err}`);
      });
  }

  // Transition to in_review
  updateTaskStatus(db, taskId, "in_review");
  emitTaskUpdated(getTask(db, taskId)!);

  // Write-back "In Review"
  if (!terminalWriteBackTasks.has(taskId)) {
    writeBackStatus(client, taskId, "in_review", stateMap).catch((err) => {
      log(`write-back failed on implement success for task ${taskId}: ${err}`);
    });
  }

  // Post implementation success comment (fire-and-forget)
  client
    .createComment(
      taskId,
      `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${branchName}\``,
    )
    .catch((err) => {
      log(`comment failed on implement success for task ${taskId}: ${err}`);
    });

  // Clean up worktree
  try {
    removeWorktree(worktreePath);
  } catch (err) {
    log(`worktree removal failed for invocation ${invocationId}: ${err}`);
  }

  log(
    `task ${taskId} implementation complete → in_review (invocation ${invocationId}, ` +
      `PR #${prInfo.number ?? "?"}, cost: $${result.costUsd ?? "unknown"}, turns: ${result.numTurns ?? "unknown"})`,
  );
}

// ---------------------------------------------------------------------------
// Review success: parse result, merge or request changes
// ---------------------------------------------------------------------------

async function onReviewSuccess(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) return;

  const summary = result.outputSummary ?? "";

  // Parse review result marker
  const approved = summary.includes("REVIEW_RESULT:APPROVED");
  const changesRequested = summary.includes("REVIEW_RESULT:CHANGES_REQUESTED");

  if (approved) {
    noMarkerRetryCounts.delete(taskId);
    // Clean up worktree
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }

    // Transition to awaiting_ci — Orca will poll CI on the PR and merge when it passes
    const ciNow = new Date().toISOString();
    updateTaskCiInfo(db, taskId, { ciStartedAt: ciNow });
    updateTaskStatus(db, taskId, "awaiting_ci");
    emitTaskUpdated(getTask(db, taskId)!);

    // Write-back (no-op for awaiting_ci, Linear stays at "In Review")
    if (!terminalWriteBackTasks.has(taskId)) {
      writeBackStatus(client, taskId, "awaiting_ci", stateMap).catch((err) => {
        log(`write-back failed on review approved for task ${taskId}: ${err}`);
      });
    }

    // Post comment (fire-and-forget)
    client
      .createComment(
        taskId,
        `Review approved — awaiting CI checks on PR #${task.prNumber ?? "?"} before merging`,
      )
      .catch((err) => {
        log(`comment failed on review approved for task ${taskId}: ${err}`);
      });

    log(
      `task ${taskId} review approved → awaiting_ci (invocation ${invocationId}, ` +
        `PR #${task.prNumber ?? "?"})`,
    );
  } else if (changesRequested) {
    noMarkerRetryCounts.delete(taskId);
    if (task.reviewCycleCount < config.maxReviewCycles) {
      // Increment cycle count and send back for fixes
      incrementReviewCycleCount(db, taskId);
      updateTaskStatus(db, taskId, "changes_requested");
      emitTaskUpdated(getTask(db, taskId)!);

      if (!terminalWriteBackTasks.has(taskId)) {
        writeBackStatus(client, taskId, "changes_requested", stateMap).catch(
          (err) => {
            log(
              `write-back failed on changes requested for task ${taskId}: ${err}`,
            );
          },
        );
      }

      // Post changes requested comment (fire-and-forget)
      client
        .createComment(
          taskId,
          `Review requested changes (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        )
        .catch((err) => {
          log(`comment failed on changes requested for task ${taskId}: ${err}`);
        });

      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal failed for invocation ${invocationId}: ${err}`);
      }

      log(
        `task ${taskId} review requested changes → changes_requested ` +
          `(cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
      );
    } else {
      // Review cycles exhausted — leave as in_review for human intervention
      updateTaskStatus(db, taskId, "in_review");
      emitTaskUpdated(getTask(db, taskId)!);

      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal failed for invocation ${invocationId}: ${err}`);
      }

      log(
        `task ${taskId} review cycles exhausted (${config.maxReviewCycles}), ` +
          `leaving as in_review for human intervention`,
      );
    }
  } else {
    // No review result marker found — retry review up to NO_MARKER_RETRY_LIMIT times
    const noMarkerCount = (noMarkerRetryCounts.get(taskId) ?? 0) + 1;
    noMarkerRetryCounts.set(taskId, noMarkerCount);

    if (noMarkerCount >= NO_MARKER_RETRY_LIMIT) {
      // Too many retries without a marker — burn a real retry
      log(
        `task ${taskId}: ${noMarkerCount} reviews without REVIEW_RESULT marker — treating as failure`,
      );
      noMarkerRetryCounts.delete(taskId);
      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      handleRetry(
        deps,
        taskId,
        "review completed without REVIEW_RESULT marker after multiple attempts",
        "review",
      );
    } else {
      log(
        `task ${taskId}: review completed but no REVIEW_RESULT marker found (${noMarkerCount}/${NO_MARKER_RETRY_LIMIT}) — retrying review`,
      );
      updateTaskStatus(db, taskId, "in_review");
      emitTaskUpdated(getTask(db, taskId)!);
    }

    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Session failure handler
// ---------------------------------------------------------------------------

function onSessionFailure(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  worktreePath: string,
  result: SessionResult,
  phase: DispatchPhase,
  isFixPhase = false,
): void {
  const { db, config, client, stateMap } = deps;

  log(
    `task ${taskId} failed (invocation ${invocationId}, ` +
      `subtype: ${result.subtype}, summary: ${result.outputSummary})`,
  );

  // Rate-limited: re-queue without burning a retry slot.
  if (result.subtype === "rate_limited") {
    // Record cooldown expiry if we know when the limit resets.
    if (result.rateLimitResetsAt) {
      const expiresAt = new Date(result.rateLimitResetsAt).getTime();
      if (!isNaN(expiresAt)) {
        rateLimitCooldowns.set(taskId, expiresAt);
      }
    }

    // Put task back in the queue for the same phase, without incrementing retryCount.
    const requeueStatus =
      phase === "review" ? ("in_review" as const) : ("ready" as const);
    updateTaskStatus(db, taskId, requeueStatus);
    emitTaskUpdated(getTask(db, taskId)!);

    client
      .createComment(
        taskId,
        `Rate limited (${result.outputSummary}) — will retry automatically when quota resets`,
      )
      .catch((err) => {
        log(`comment failed on rate limit for task ${taskId}: ${err}`);
      });

    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on rate limit for invocation ${invocationId}: ${err}`,
      );
    }
    return;
  }

  // Stale session resume — clear session ID and re-dispatch fresh instead of burning a retry
  if (
    result.subtype === "error_during_execution" &&
    result.outputSummary?.includes("No conversation found with session ID")
  ) {
    log(
      `task ${taskId}: stale session detected — clearing session and re-dispatching fresh`,
    );
    // Clear the stale session from the CURRENT invocation
    updateInvocation(db, invocationId, {
      sessionId: null,
    });
    // Also clear the session from the ORIGINAL completed invocation that provided
    // the session ID, so getLastCompletedImplementInvocation won't return it again
    const sourceInv = getLastCompletedImplementInvocation(db, taskId);
    if (sourceInv) {
      log(
        `task ${taskId}: clearing stale session from source invocation ${sourceInv.id}`,
      );
      updateInvocation(db, sourceInv.id, { sessionId: null });
    }
    // Increment stale-session retry counter and cap at 3 to prevent runaway loops
    const staleRetries = incrementStaleSessionRetryCount(db, taskId);
    const maxStaleSessionRetries = 3;
    if (staleRetries >= maxStaleSessionRetries) {
      log(
        `task ${taskId}: stale session retry limit reached (${staleRetries}/${maxStaleSessionRetries}) — permanently failing`,
      );
      updateTaskStatus(db, taskId, "failed");
      const failedTask = getTask(db, taskId);
      emitTaskUpdated(failedTask!);
      client
        .createComment(
          taskId,
          `Task permanently failed: stale session detected ${staleRetries} times in a row. The Claude session cannot be resumed — manual intervention required.`,
        )
        .catch((err) => {
          log(`comment failed on stale session cap for task ${taskId}: ${err}`);
        });
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(
          `worktree removal on stale session cap for invocation ${invocationId}: ${err}`,
        );
      }
      return;
    }

    // Re-queue without burning a retry
    const staleTask = getTask(db, taskId);
    const requeueStatus =
      phase === "review"
        ? ("in_review" as const)
        : staleTask && staleTask.reviewCycleCount > 0
          ? ("changes_requested" as const)
          : ("ready" as const);
    updateTaskStatus(db, taskId, requeueStatus);
    emitTaskUpdated(staleTask!);
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on stale session for invocation ${invocationId}: ${err}`,
      );
    }
    return;
  }

  // Content filtering: permanent failure — retries are futile (same prompt → same block)
  if (
    result.outputSummary?.includes("Output blocked by content filtering policy")
  ) {
    log(
      `task ${taskId}: content filtering — permanently failing without retries (retries would be futile)`,
    );
    updateTaskStatus(db, taskId, "failed");
    emitTaskUpdated(getTask(db, taskId)!);
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(
        `worktree removal on content filter for invocation ${invocationId}: ${err}`,
      );
    }
    terminalWriteBackTasks.add(taskId);
    writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
      (err) => {
        log(`write-back failed on content filter for task ${taskId}: ${err}`);
      },
    );
    client
      .createComment(
        taskId,
        `Task permanently failed: output blocked by Claude's content filtering policy. Retries skipped — the same prompt would produce the same result.`,
      )
      .catch((err) => {
        log(`comment failed on content filter for task ${taskId}: ${err}`);
      });
    return;
  }

  updateTaskStatus(db, taskId, "failed");
  emitTaskUpdated(getTask(db, taskId)!);

  // Preserve worktree for resume when max turns hit on fresh implement phase.
  // Fix sessions (implement on changes_requested) create their own fresh worktree
  // from the PR branch but still resume the previous session via sessionId.
  const preserveForResume =
    result.subtype === "error_max_turns" &&
    config.resumeOnMaxTurns &&
    phase === "implement" &&
    !isFixPhase;

  if (preserveForResume) {
    log(`preserving worktree for resume: ${worktreePath}`);
  } else {
    // Clean up worktree so retries start fresh
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal on failure for invocation ${invocationId}: ${err}`);
    }
  }

  // Retry logic — review failures retry as in_review, not ready
  handleRetry(deps, taskId, result.outputSummary, phase);
}

// ---------------------------------------------------------------------------
// Status emission helper
// ---------------------------------------------------------------------------

function emitCurrentStatus(db: OrcaDb, config: OrcaConfig): void {
  const activeSessions = countActiveSessions(db);
  const allTasks = getAllTasks(db);
  const queuedTasks = allTasks.filter(
    (t) =>
      t.orcaStatus === "ready" ||
      t.orcaStatus === "in_review" ||
      t.orcaStatus === "changes_requested",
  ).length;
  const tokensInWindow = sumTokensInWindow(
    db,
    budgetWindowStart(config.budgetWindowHours),
  );
  emitStatusUpdated({
    activeSessions,
    queuedTasks,
    tokensInWindow,
    tokenBudgetLimit: config.budgetMaxTokens,
    budgetWindowHours: config.budgetWindowHours,
  });
}

// ---------------------------------------------------------------------------
// Retry logic (6.5)
// ---------------------------------------------------------------------------

function handleRetry(
  deps: SchedulerDeps,
  taskId: string,
  summary?: string,
  phase?: DispatchPhase,
): void {
  const { db, config, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) {
    log(`retry: task ${taskId} not found`);
    return;
  }

  const briefSummary = summary ? summary.slice(0, 200) : "unknown error";

  if (task.retryCount < config.maxRetries) {
    // Review failures retry as in_review so the review is re-dispatched,
    // not a fresh implementation.
    const retryStatus =
      phase === "review" ? ("in_review" as const) : ("ready" as const);
    incrementRetryCount(db, taskId, retryStatus);
    log(
      `task ${taskId} queued for retry as "${retryStatus}" (attempt ${task.retryCount + 1}/${config.maxRetries})`,
    );

    // Write-back on retry (fire-and-forget)
    // Only write back for review retries (→ "In Review"). Implementation
    // retries intentionally skip the write-back to avoid setting Linear to
    // "Todo", which can race with the "failed_permanent" → "Canceled"
    // write-back and reset retryCount to 0 via resolveConflict/upsertTask,
    // causing an infinite retry loop.
    if (phase === "review" && !terminalWriteBackTasks.has(taskId)) {
      writeBackStatus(client, taskId, "in_review", stateMap).catch((err) => {
        log(`write-back failed on retry for task ${taskId}: ${err}`);
      });
    }

    // Post retry comments (fire-and-forget)
    const isMaxTurnsResumable =
      briefSummary === "max turns reached" && config.resumeOnMaxTurns;
    const retryComment = isMaxTurnsResumable
      ? `Max turns reached — will resume session (attempt ${task.retryCount + 1}/${config.maxRetries})`
      : `Invocation failed — retrying (attempt ${task.retryCount + 1}/${config.maxRetries}): ${briefSummary}`;
    client.createComment(taskId, retryComment).catch((err) => {
      log(`comment failed on retry for task ${taskId}: ${err}`);
    });
    client.createComment(taskId, "Queued for retry").catch((err) => {
      log(`comment failed on queued for retry for task ${taskId}: ${err}`);
    });
  } else {
    log(
      `task ${taskId} exhausted all retries (${config.maxRetries}), leaving as failed`,
    );

    // Write-back on permanent failure (fire-and-forget)
    terminalWriteBackTasks.add(taskId);
    writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
      (err) => {
        log(
          `write-back failed on permanent failure for task ${taskId}: ${err}`,
        );
      },
    );

    // Post permanent failure comment (fire-and-forget)
    client
      .createComment(
        taskId,
        `Task failed permanently after ${config.maxRetries} retries: ${briefSummary}`,
      )
      .catch((err) => {
        log(`comment failed on permanent failure for task ${taskId}: ${err}`);
      });
  }
}

// ---------------------------------------------------------------------------
// Timeout check (6.4)
// ---------------------------------------------------------------------------

function checkTimeouts(deps: SchedulerDeps): void {
  const { db, config } = deps;

  // Liveness check: detect handles whose process already exited but whose
  // done promise silently failed to resolve. Mark them as failed immediately
  // rather than waiting for the clock-based timeout.
  // Collect IDs first to avoid mutating the map during iteration.
  const deadHandles: Array<{ invId: number; exitCode: number }> = [];
  for (const [invId, handle] of activeHandles) {
    if (handle.process.exitCode !== null) {
      deadHandles.push({ invId, exitCode: handle.process.exitCode });
    }
  }
  for (const { invId, exitCode } of deadHandles) {
    log(
      `invocation ${invId}: process already exited (code ${exitCode}) but handle still active — forcing cleanup`,
    );
    activeHandles.delete(invId);

    // Look up the task ID before marking the invocation as failed
    // (getRunningInvocations won't return it after the update).
    const runningBefore = getRunningInvocations(db);
    const inv = runningBefore.find((r) => r.id === invId);

    updateInvocation(db, invId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      outputSummary: `process exited (code ${exitCode}) but completion handler did not fire`,
    });

    if (inv) {
      updateTaskStatus(db, inv.linearIssueId, "failed");
      handleRetry(
        deps,
        inv.linearIssueId,
        `process exited (code ${exitCode}) but completion handler did not fire`,
      );
    }
  }

  const running = getRunningInvocations(db);
  const now = Date.now();
  const timeoutMs = config.sessionTimeoutMin * 60 * 1000;

  for (const inv of running) {
    const startedAt = new Date(inv.startedAt).getTime();
    if (startedAt + timeoutMs < now) {
      log(`invocation ${inv.id} timed out (task ${inv.linearIssueId})`);

      // Find and kill the matching session handle
      const handle = activeHandles.get(inv.id);
      if (handle) {
        killSession(handle).catch((err) => {
          log(`error killing timed-out session ${inv.id}: ${err}`);
        });
        activeHandles.delete(inv.id);
      }

      // Mark invocation as timed_out
      updateInvocation(db, inv.id, {
        status: "timed_out",
        endedAt: new Date().toISOString(),
      });

      // Mark task as failed
      updateTaskStatus(db, inv.linearIssueId, "failed");

      // Attempt retry
      handleRetry(
        deps,
        inv.linearIssueId,
        `session timed out after ${config.sessionTimeoutMin}min`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Self-deploy (Orca-project tasks)
// ---------------------------------------------------------------------------

/** Flag to prevent multiple simultaneous self-deploys. */
let selfDeployTriggered = false;

function isOrcaProjectTask(repoPath: string): boolean {
  try {
    return resolve(repoPath) === resolve(process.cwd());
  } catch {
    return false;
  }
}

function triggerSelfDeploy(): void {
  if (selfDeployTriggered) {
    log("self-deploy: already triggered, skipping");
    return;
  }
  selfDeployTriggered = true;

  const deployScript = join(process.cwd(), "scripts", "deploy.sh");
  log("self-deploy: spawning deploy.sh — Orca will pull, rebuild, and restart");

  const child = spawn("bash", [deployScript], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// Deploy monitoring
// ---------------------------------------------------------------------------

/** Last poll time per task ID, for throttling. */
const deployPollTimes = new Map<string, number>();

/** Last time cleanup ran (epoch ms), for throttling. */
let lastCleanupTime = 0;

async function checkDeployments(deps: SchedulerDeps): Promise<void> {
  const { db, config, client, stateMap } = deps;

  if (config.deployStrategy === "none") return;

  const deploying = getDeployingTasks(db);
  if (deploying.length === 0) return;

  const now = Date.now();
  const pollIntervalMs = config.deployPollIntervalSec * 1000;
  const timeoutMs = config.deployTimeoutMin * 60 * 1000;

  for (const task of deploying) {
    const taskId = task.linearIssueId;

    // Throttle: skip if polled too recently
    const lastPoll = deployPollTimes.get(taskId) ?? 0;
    if (now - lastPoll < pollIntervalMs) continue;
    deployPollTimes.set(taskId, now);

    // Timeout check
    if (task.deployStartedAt) {
      const startedAt = new Date(task.deployStartedAt).getTime();
      if (startedAt + timeoutMs < now) {
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        deployPollTimes.delete(taskId);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on deploy timeout for task ${taskId}: ${err}`,
            );
          },
        );

        // Post deploy timeout comment (fire-and-forget)
        client
          .createComment(
            taskId,
            `Deploy timed out after ${config.deployTimeoutMin}min — task failed permanently`,
          )
          .catch((err) => {
            log(`comment failed on deploy timeout for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} deploy timed out after ${config.deployTimeoutMin}min`,
        );
        continue;
      }
    }

    // Defensive: no SHA means we can't monitor — mark done with warning
    if (!task.mergeCommitSha) {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy (no SHA) for task ${taskId}: ${err}`);
      });

      client.createComment(taskId, "Task complete").catch((err) => {
        log(`comment failed on done (no SHA) for task ${taskId}: ${err}`);
      });

      log(
        `task ${taskId} deploying → done (no merge commit SHA, skipping CI check)`,
      );
      triggerParentEval(deps, taskId);
      continue;
    }

    // Poll GitHub Actions
    const status = await getWorkflowRunStatus(
      task.mergeCommitSha,
      task.repoPath,
    );

    if (status === "success") {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy success for task ${taskId}: ${err}`);
      });

      // Post done comment (fire-and-forget)
      client.createComment(taskId, "Task complete").catch((err) => {
        log(`comment failed on deploy success for task ${taskId}: ${err}`);
      });

      log(
        `task ${taskId} deploy succeeded → done (SHA: ${task.mergeCommitSha})`,
      );
      triggerParentEval(deps, taskId);

      // Self-deploy: if this task's repo is the Orca project, restart with new code
      if (isOrcaProjectTask(task.repoPath)) {
        triggerSelfDeploy();
      }
    } else if (status === "failure") {
      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      terminalWriteBackTasks.add(taskId);
      writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
        (err) => {
          log(`write-back failed on deploy failure for task ${taskId}: ${err}`);
        },
      );

      // Post deploy failure comment (fire-and-forget)
      client
        .createComment(
          taskId,
          `Deploy CI failed for commit ${task.mergeCommitSha} — task failed permanently`,
        )
        .catch((err) => {
          log(`comment failed on deploy failure for task ${taskId}: ${err}`);
        });

      log(
        `task ${taskId} deploy failed → failed (SHA: ${task.mergeCommitSha})`,
      );
    }
    // "pending", "in_progress", "no_runs" → skip, poll again next interval
  }
}

// ---------------------------------------------------------------------------
// Pre-merge CI gate: poll PR checks, merge on success
// ---------------------------------------------------------------------------

/** Last poll time per task ID, for throttling CI checks. */
const ciPollTimes = new Map<string, number>();

async function checkPrCi(deps: SchedulerDeps): Promise<void> {
  const { db, config, client, stateMap } = deps;

  const awaitingCi = getAwaitingCiTasks(db);
  if (awaitingCi.length === 0) return;

  const now = Date.now();
  const pollIntervalMs = config.deployPollIntervalSec * 1000;
  const timeoutMs = config.deployTimeoutMin * 60 * 1000;

  for (const task of awaitingCi) {
    const taskId = task.linearIssueId;

    // Throttle: skip if polled too recently
    const lastPoll = ciPollTimes.get(taskId) ?? 0;
    if (now - lastPoll < pollIntervalMs) continue;
    ciPollTimes.set(taskId, now);

    // Timeout check
    if (task.ciStartedAt) {
      const startedAt = new Date(task.ciStartedAt).getTime();
      if (startedAt + timeoutMs < now) {
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        ciPollTimes.delete(taskId);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(`write-back failed on CI timeout for task ${taskId}: ${err}`);
          },
        );

        client
          .createComment(
            taskId,
            `CI timed out after ${config.deployTimeoutMin}min — task failed`,
          )
          .catch((err) => {
            log(`comment failed on CI timeout for task ${taskId}: ${err}`);
          });

        log(`task ${taskId} CI timed out after ${config.deployTimeoutMin}min`);
        continue;
      }
    }

    // No PR number: can't check CI — merge immediately
    if (!task.prNumber) {
      log(
        `task ${taskId} awaiting_ci but no PR number — skipping CI, marking done`,
      );
      await mergeAndFinalize(deps, taskId);
      ciPollTimes.delete(taskId);
      continue;
    }

    // Poll PR check status
    const status = await getPrCheckStatus(task.prNumber, task.repoPath);

    if (status === "success" || status === "no_checks") {
      // CI passed or no checks configured — merge the PR
      await mergeAndFinalize(deps, taskId);
      ciPollTimes.delete(taskId);
    } else if (status === "failure") {
      ciPollTimes.delete(taskId);

      // Check review cycle cap
      if (task.reviewCycleCount < config.maxReviewCycles) {
        incrementReviewCycleCount(db, taskId);
        updateTaskStatus(db, taskId, "changes_requested");
        emitTaskUpdated(getTask(db, taskId)!);

        if (!terminalWriteBackTasks.has(taskId)) {
          writeBackStatus(client, taskId, "changes_requested", stateMap).catch(
            (err) => {
              log(`write-back failed on CI failure for task ${taskId}: ${err}`);
            },
          );
        }

        client
          .createComment(
            taskId,
            `CI failed on PR #${task.prNumber} — requesting fixes (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
          )
          .catch((err) => {
            log(`comment failed on CI failure for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} CI failed → changes_requested ` +
            `(cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        );
      } else {
        // Cycles exhausted — mark as failed
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on CI failure (cycles exhausted) for task ${taskId}: ${err}`,
            );
          },
        );

        client
          .createComment(
            taskId,
            `CI failed and review cycles exhausted (${config.maxReviewCycles}) — task failed permanently`,
          )
          .catch((err) => {
            log(
              `comment failed on CI failure (cycles exhausted) for task ${taskId}: ${err}`,
            );
          });

        log(`task ${taskId} CI failed, cycles exhausted → failed`);
      }
    }
    // "pending" → skip, poll again next interval
  }
}

/**
 * Merge a PR programmatically and transition the task to done/deploying.
 */
async function mergeAndFinalize(
  deps: SchedulerDeps,
  taskId: string,
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) return;

  if (task.prNumber) {
    // Pre-flight: check merge state before attempting merge
    const mergeState = await getPrMergeState(task.prNumber, task.repoPath);
    log(
      `task ${taskId} PR #${task.prNumber} mergeStateStatus: ${mergeState.mergeStateStatus}`,
    );

    if (mergeState.mergeStateStatus === "BEHIND") {
      // Branch is behind main but has no conflicts — update it
      log(`task ${taskId} PR #${task.prNumber} is BEHIND — updating branch`);
      const updated = await updatePrBranch(task.prNumber, task.repoPath);
      if (!updated) {
        log(
          `task ${taskId} PR #${task.prNumber} branch update failed — proceeding with merge anyway`,
        );
      } else {
        log(`task ${taskId} PR #${task.prNumber} branch updated successfully`);
      }
    } else if (mergeState.mergeStateStatus === "CONFLICTING") {
      // Merge conflicts — trigger a fix-phase invocation to rebase and resolve
      log(
        `task ${taskId} PR #${task.prNumber} has CONFLICTING state — triggering conflict resolution fix phase`,
      );

      if (task.reviewCycleCount < config.maxReviewCycles) {
        incrementReviewCycleCount(db, taskId);
        updateTaskFixReason(db, taskId, "merge_conflict");
        updateTaskStatus(db, taskId, "changes_requested");
        emitTaskUpdated(getTask(db, taskId)!);

        client
          .createComment(
            taskId,
            `PR #${task.prNumber} has merge conflicts — dispatching fix phase to rebase and resolve (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
          )
          .catch((err) => {
            log(`comment failed on merge conflict for task ${taskId}: ${err}`);
          });

        log(
          `task ${taskId} → changes_requested (merge conflict, cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
        );
      } else {
        // Review cycles exhausted — fail the task
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        terminalWriteBackTasks.add(taskId);
        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch(
          (err) => {
            log(
              `write-back failed on merge conflict exhaustion for task ${taskId}: ${err}`,
            );
          },
        );

        client
          .createComment(
            taskId,
            `PR #${task.prNumber} has merge conflicts and review cycle limit reached — marking failed`,
          )
          .catch((err) => {
            log(
              `comment failed on merge conflict exhaustion for task ${taskId}: ${err}`,
            );
          });

        log(`task ${taskId} merge conflict — review cycles exhausted → failed`);
      }
      return;
    }

    const mergeResult = await mergePr(task.prNumber, task.repoPath);

    if (!mergeResult.merged) {
      // Check if PR was already merged (race condition fallback)
      let alreadyMerged = false;
      if (task.prBranchName) {
        const prInfo = findPrForBranch(task.prBranchName, task.repoPath);
        alreadyMerged = prInfo.merged === true;
      }

      if (!alreadyMerged) {
        // Genuine merge failure. Increment the attempt counter first.
        const freshTask = getTask(db, taskId);
        const attemptsSoFar = (freshTask?.mergeAttemptCount ?? 0) + 1;
        incrementMergeAttemptCount(db, taskId);
        emitTaskUpdated(getTask(db, taskId)!);

        const maxMergeAttempts = 3;

        // On the first failure, attempt a rebase onto main before giving up.
        // This handles "not up to date" and conflict-based merge failures.
        if (attemptsSoFar === 1 && task.prBranchName) {
          log(
            `task ${taskId} merge attempt 1 failed — attempting rebase of ${task.prBranchName} onto origin/main`,
          );
          const rebaseResult = rebasePrBranch(task.prBranchName, task.repoPath);

          if (rebaseResult.success) {
            // Rebase succeeded. Force-push has been done; CI will re-run on the
            // new commits. Stay in awaiting_ci so the CI poll loop will pick it
            // up again and re-attempt the merge once CI passes.
            client
              .createComment(
                taskId,
                `Merge failed for PR #${task.prNumber}: ${mergeResult.error}\n\nRebased branch \`${task.prBranchName}\` onto \`main\` and force-pushed — waiting for CI to re-run before retrying merge.`,
              )
              .catch((err) => {
                log(
                  `comment failed on rebase success for task ${taskId}: ${err}`,
                );
              });

            log(
              `task ${taskId} rebase succeeded — force-pushed, keeping awaiting_ci for CI re-run`,
            );
            return;
          }

          if (rebaseResult.hasConflicts) {
            // Rebase has conflicts — dispatch a fix-phase agent to resolve them,
            // same as when we detect CONFLICTING in the pre-flight check.
            log(
              `task ${taskId} rebase has conflicts — triggering conflict resolution fix phase`,
            );

            if (task.reviewCycleCount < config.maxReviewCycles) {
              incrementReviewCycleCount(db, taskId);
              updateTaskFixReason(db, taskId, "merge_conflict");
              // Reset merge attempt counter so the next awaiting_ci cycle
              // starts fresh (mergeAttemptCount was incremented before the
              // rebase attempt and would otherwise skip the rebase on re-entry).
              resetMergeAttemptCount(db, taskId);
              updateTaskStatus(db, taskId, "changes_requested");
              emitTaskUpdated(getTask(db, taskId)!);

              client
                .createComment(
                  taskId,
                  `Merge failed for PR #${task.prNumber} and rebase has conflicts — dispatching fix phase to resolve (cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
                )
                .catch((err) => {
                  log(
                    `comment failed on rebase conflict for task ${taskId}: ${err}`,
                  );
                });

              log(
                `task ${taskId} → changes_requested (rebase conflicts, cycle ${task.reviewCycleCount + 1}/${config.maxReviewCycles})`,
              );
            } else {
              // Review cycles exhausted — fail the task
              updateTaskStatus(db, taskId, "failed");
              emitTaskUpdated(getTask(db, taskId)!);

              terminalWriteBackTasks.add(taskId);
              writeBackStatus(
                client,
                taskId,
                "failed_permanent",
                stateMap,
              ).catch((err) => {
                log(
                  `write-back failed on rebase conflict exhaustion for task ${taskId}: ${err}`,
                );
              });

              client
                .createComment(
                  taskId,
                  `Merge failed for PR #${task.prNumber}, rebase has conflicts, and review cycle limit reached — marking failed`,
                )
                .catch((err) => {
                  log(
                    `comment failed on rebase conflict exhaustion for task ${taskId}: ${err}`,
                  );
                });

              log(
                `task ${taskId} rebase conflicts — review cycles exhausted → failed`,
              );
            }
            return;
          }

          // Rebase failed for another reason (push error, network, etc.).
          // Log it and fall through to the standard retry logic below.
          log(
            `task ${taskId} rebase failed (non-conflict): ${rebaseResult.error} — falling back to merge retry`,
          );
        }

        if (attemptsSoFar < maxMergeAttempts) {
          // Keep task in awaiting_ci — the CI poll loop will call mergeAndFinalize again.
          client
            .createComment(
              taskId,
              `Merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed for PR #${task.prNumber}: ${mergeResult.error}. Will retry automatically on next scheduler tick.`,
            )
            .catch((err) => {
              log(`comment failed on merge retry for task ${taskId}: ${err}`);
            });

          log(
            `task ${taskId} merge attempt ${attemptsSoFar}/${maxMergeAttempts} failed — keeping awaiting_ci for retry`,
          );
          return;
        }

        // Exhausted retries — escalate to failed but preserve the PR.
        // Write "In Review" (not Cancelled) so the PR stays open and the branch is not deleted.
        updateTaskStatus(db, taskId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);

        if (!terminalWriteBackTasks.has(taskId)) {
          writeBackStatus(client, taskId, "in_review", stateMap).catch(
            (err) => {
              log(
                `write-back failed on merge escalation for task ${taskId}: ${err}`,
              );
            },
          );
        }

        client
          .createComment(
            taskId,
            `Merge failed after ${attemptsSoFar} attempts for PR #${task.prNumber}: ${mergeResult.error}\n\nThe PR has been preserved. Please resolve the merge blocker and merge manually, or reset this issue to Todo to re-implement.`,
          )
          .catch((err) => {
            log(
              `comment failed on merge escalation for task ${taskId}: ${err}`,
            );
          });

        log(
          `task ${taskId} merge failed after ${attemptsSoFar} attempts — escalated, PR preserved, status=failed`,
        );
        return;
      }
      // PR was already merged by someone else — continue normally
      log(`task ${taskId} PR #${task.prNumber} already merged — proceeding`);
    }
  }

  // After merge: transition to deploying (if github_actions) or done
  if (config.deployStrategy === "github_actions") {
    let mergeCommitSha: string | null = null;
    if (task.prNumber) {
      mergeCommitSha = await getMergeCommitSha(task.prNumber, task.repoPath);
    }

    const now = new Date().toISOString();
    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha,
      prNumber: task.prNumber ?? null,
      deployStartedAt: now,
    });
    updateTaskStatus(db, taskId, "deploying");
    emitTaskUpdated(getTask(db, taskId)!);

    client
      .createComment(
        taskId,
        `PR #${task.prNumber ?? "?"} merged — monitoring deploy CI for commit ${mergeCommitSha ?? "unknown"}`,
      )
      .catch((err) => {
        log(`comment failed on merge+deploy for task ${taskId}: ${err}`);
      });

    log(
      `task ${taskId} merged → deploying (PR #${task.prNumber ?? "?"}, SHA: ${mergeCommitSha ?? "unknown"})`,
    );
  } else {
    // deploy_strategy = "none" — go straight to done
    updateTaskStatus(db, taskId, "done");
    emitTaskUpdated(getTask(db, taskId)!);

    terminalWriteBackTasks.add(taskId);
    writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
      log(`write-back failed on merge+done for task ${taskId}: ${err}`);
    });

    client
      .createComment(
        taskId,
        `PR #${task.prNumber ?? "?"} merged — task complete`,
      )
      .catch((err) => {
        log(`comment failed on merge+done for task ${taskId}: ${err}`);
      });

    log(`task ${taskId} merged → done`);

    // Self-deploy: if this task's repo is the Orca project, restart with new code
    if (isOrcaProjectTask(task.repoPath)) {
      triggerSelfDeploy();
    }

    triggerParentEval(deps, taskId);
  }
}

// ---------------------------------------------------------------------------
// Tick — multi-phase dispatch
// ---------------------------------------------------------------------------

async function tick(deps: SchedulerDeps): Promise<void> {
  const { db, config, graph } = deps;

  // Check for timed-out invocations even during drain — stale sessions block
  // the deploy indefinitely if timeouts are skipped while isDraining() is true.
  checkTimeouts(deps);

  // During a graceful deploy drain, skip polling, cleanup, and new
  // implementation dispatch. Review and fix-cycle dispatches are still
  // allowed — they continue existing work and are typically fast.
  const draining = isDraining();

  if (!draining) {
    // Check deploying tasks (non-blocking per-task polling)
    await checkDeployments(deps);

    // Check awaiting_ci tasks (poll PR checks, merge when CI passes)
    await checkPrCi(deps);

    // Global DLL_INIT cooldown — skip dispatch and cleanup entirely.
    // DLL_INIT is system-wide resource exhaustion; spawning ANY process
    // (git, gh, node) will likely fail and make things worse.
    const now = Date.now();
    if (now < globalDllCooldownUntil) {
      const remainingSec = Math.ceil((globalDllCooldownUntil - now) / 1000);
      // Only log every 30s to avoid spam
      if (remainingSec % 30 < config.schedulerIntervalSec + 1) {
        log(
          `DLL_INIT cooldown active — ${remainingSec}s remaining, skipping dispatch and cleanup`,
        );
      }
      return;
    }

    // Periodic cleanup of stale branches and orphaned worktrees
    const cleanupIntervalMs = config.cleanupIntervalMin * 60 * 1000;
    if (now - lastCleanupTime >= cleanupIntervalMs) {
      lastCleanupTime = now;
      try {
        cleanupStaleResources({ db, config });
        cleanupOldInvocationLogs({ db, config });
      } catch (err) {
        log(`cleanup error: ${err}`);
        // If cleanup hit DLL_INIT, activate cooldown
        if (isDllInitError(err)) {
          globalDllCooldownUntil = Date.now() + GLOBAL_DLL_COOLDOWN_MS;
          log(
            `DLL_INIT in cleanup — global cooldown for ${GLOBAL_DLL_COOLDOWN_MS / 1000}s`,
          );
          return;
        }
      }
    }
  }

  // 1. Count active sessions
  const active = countActiveSessions(db);
  if (active >= config.concurrencyCap) {
    return;
  }

  // 2. Check budget
  const tokens = sumTokensInWindow(
    db,
    budgetWindowStart(config.budgetWindowHours),
  );
  if (tokens >= config.budgetMaxTokens) {
    log(
      `budget exhausted: ${tokens.toLocaleString()} tokens used of ${config.budgetMaxTokens.toLocaleString()} limit`,
    );
    return;
  }

  // 3. Get tasks in dispatchable states.
  // During drain, only allow review/fix-cycle phases — no new implementations.
  const candidateStatuses: TaskStatus[] = draining
    ? ["in_review", "changes_requested"]
    : ["ready", "in_review", "changes_requested"];
  const candidates = getDispatchableTasks(db, candidateStatuses);
  if (candidates.length === 0) {
    return;
  }

  // 4. Filter: skip empty prompts, blocked tasks, and tasks with running invocations
  const getStatus = (id: string): string | undefined =>
    getTask(db, id)?.orcaStatus;

  // Build a set of task IDs that already have a running invocation.
  // This prevents dispatching a duplicate session for a task whose prior
  // completion handler hasn't finished updating its status yet.
  const runningInvs = getRunningInvocations(db);
  const tasksWithRunningInv = new Set(
    runningInvs.map((inv) => inv.linearIssueId),
  );

  const dispatchable = candidates.filter((t) => {
    if (!t.agentPrompt) return false;
    if (t.isParent) return false; // never dispatch parent issues
    if (tasksWithRunningInv.has(t.linearIssueId)) return false;
    // Skip tasks under a rate-limit cooldown
    const cooldownUntil = rateLimitCooldowns.get(t.linearIssueId);
    if (cooldownUntil !== undefined) {
      if (Date.now() < cooldownUntil) return false;
      rateLimitCooldowns.delete(t.linearIssueId);
    }
    // Skip in_review tasks where review cycles are exhausted — leave for human intervention
    if (
      t.orcaStatus === "in_review" &&
      t.reviewCycleCount >= config.maxReviewCycles
    ) {
      return false;
    }
    // Dependency graph filtering only applies to initial implementation (ready)
    if (t.orcaStatus === "ready") {
      return graph.isDispatchable(t.linearIssueId, getStatus);
    }
    // in_review and changes_requested are always dispatchable (they've already passed filtering)
    return true;
  });

  if (dispatchable.length === 0) {
    return;
  }

  // 5. Sort: prioritize review/fix phases over new implementations
  const PHASE_ORDER: Record<string, number> = {
    in_review: 0,
    changes_requested: 1,
    ready: 2,
  };

  const getPriority = (id: string): number => getTask(db, id)?.priority ?? 0;

  dispatchable.sort((a, b) => {
    const aPhaseOrder = PHASE_ORDER[a.orcaStatus] ?? 9;
    const bPhaseOrder = PHASE_ORDER[b.orcaStatus] ?? 9;
    if (aPhaseOrder !== bPhaseOrder) return aPhaseOrder - bPhaseOrder;

    const aPrio = graph.computeEffectivePriority(a.linearIssueId, getPriority);
    const bPrio = graph.computeEffectivePriority(b.linearIssueId, getPriority);
    if (aPrio !== bPrio) return aPrio - bPrio;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });

  // 6. Pick first and dispatch with appropriate phase
  const task = dispatchable[0]!;
  let phase: DispatchPhase;
  if (task.orcaStatus === "in_review") {
    phase = "review";
  } else if (task.orcaStatus === "changes_requested") {
    phase = "implement"; // fix phase uses implement with existing branch
  } else {
    phase = "implement";
  }

  await dispatch(deps, task, phase);
}

// ---------------------------------------------------------------------------
// Scheduler loop (6.1)
// ---------------------------------------------------------------------------

/**
 * Start the scheduler dispatch loop.
 *
 * Runs a tick immediately, then on an interval defined by
 * `config.schedulerIntervalSec`. A mutex flag prevents overlapping ticks.
 * If a tick is requested while one is already running, a pending flag is set
 * so the next tick runs immediately after the current one completes rather
 * than being silently dropped.
 *
 * @returns A handle with a `stop()` method that clears the interval and
 *          kills all active sessions.
 */
export function createScheduler(
  deps: SchedulerDeps,
  opts?: { paused?: boolean },
): SchedulerHandle {
  const { config } = deps;
  let ticking = false;
  let pendingTick = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  async function guardedTick(): Promise<void> {
    if (ticking) {
      pendingTick = true;
      return;
    }
    ticking = true;
    try {
      await tick(deps);
    } catch (err) {
      log(`tick error: ${err}`);
    } finally {
      ticking = false;
      if (pendingTick) {
        pendingTick = false;
        guardedTick();
      }
    }
  }

  const handle: SchedulerHandle = {
    get running() {
      return isRunning;
    },

    start() {
      if (isRunning) return;
      isRunning = true;

      // Run first tick immediately
      guardedTick();

      intervalId = setInterval(() => {
        guardedTick();
      }, config.schedulerIntervalSec * 1000);

      log(
        `started (interval: ${config.schedulerIntervalSec}s, ` +
          `concurrency: ${config.concurrencyCap}, ` +
          `budget: ${config.budgetMaxTokens.toLocaleString()} tokens/${config.budgetWindowHours}h)`,
      );
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      isRunning = false;
      log("stopping scheduler, killing active sessions...");

      // Kill all active sessions
      const killPromises: Promise<SessionResult>[] = [];
      for (const [invId, sessionHandle] of activeHandles) {
        log(`killing session for invocation ${invId}`);
        killPromises.push(
          killSession(sessionHandle).catch((err) => {
            log(`error killing session ${invId} during shutdown: ${err}`);
            return sessionHandle.done;
          }),
        );
      }

      // We cannot await in a sync function, but the kills are fire-and-forget
      // at shutdown. The process should wait for the promises if needed.
      Promise.all(killPromises).then(() => {
        log("all sessions killed");
      });
    },
  };

  if (!opts?.paused) {
    handle.start();
  }

  return handle;
}

/** Backward-compatible wrapper for createScheduler. */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  return createScheduler(deps);
}
