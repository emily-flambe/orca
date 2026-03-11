// PR lifecycle gates verified
import { isDraining } from "../deploy.js";
import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import {
  countActiveSessions,
  getAllTasks,
  getDispatchableTasks,
  getLastCompletedImplementInvocation,
  getLastDeployInterruptedInvocation,
  getLastMaxTurnsInvocation,
  getRunningInvocations,
  getTask,
  incrementRetryCount,
  insertBudgetEvent,
  insertInvocation,
  insertTask,
  sumCostInWindow,
  budgetWindowStart,
  updateInvocation,
  updateTaskStatus,
  updateTaskFixReason,
  claimTaskForDispatch,
  getDueCronSchedules,
  incrementCronRunCount,
  deleteOldCronTasks,
  updateCronSchedule,
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
import { spawnShellCommand, type ShellHandle } from "../runner/shell.js";
import { computeNextRunAt } from "../cron/index.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createWorktree,
  removeWorktree,
  WorktreeLockedError,
} from "../worktree/index.js";
import { isTransientGitError, isDllInitError } from "../git.js";
import {
  cleanupStaleResources,
  cleanupOldInvocationLogs,
} from "../cleanup/index.js";
import type { DependencyGraph } from "../linear/graph.js";
import type { LinearClient, WorkflowStateMap } from "../linear/client.js";
import { writeBackStatus, evaluateParentStatuses } from "../linear/sync.js";
import { onImplementSuccess, type Gate2State } from "./gates/gate2.js";
// mergeAndFinalize is called indirectly via ci-gate.ts and deploy-gate.ts
import { checkPrCi, type CiGateState } from "./gates/ci-gate.js";
import { checkDeployments, type DeployGateState } from "./gates/deploy-gate.js";
import {
  onSessionFailure,
  type FailureClassifierState,
} from "./phases/failure-classifier.js";
import {
  onReviewSuccess,
  type ReviewResultParserState,
} from "./phases/review-result-parser.js";

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
 * Active shell handles keyed by invocation ID.
 * Used for cron_shell tasks that run a raw shell command.
 */
export const shellHandles = new Map<number, ShellHandle>();

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
  let isDeployResume = false;
  let deployResumedInvocationId: number | undefined;

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

  // Detect deploy-interrupted worktree resume (fresh implement phase only)
  if (
    phase === "implement" &&
    task.orcaStatus !== "changes_requested" &&
    resumeWorktreePath == null
  ) {
    const prevInv = getLastDeployInterruptedInvocation(db, taskId);
    if (prevInv && prevInv.worktreePath && existsSync(prevInv.worktreePath)) {
      resumeWorktreePath = prevInv.worktreePath;
      resumeBranchName = prevInv.branchName ?? undefined;
      isDeployResume = true;
      deployResumedInvocationId = prevInv.id;
      log(
        `deploy-interrupted worktree found for task ${taskId}: ${resumeWorktreePath}`,
      );
    } else if (prevInv) {
      log(
        `deploy-interrupted worktree for task ${taskId} is missing (${prevInv.worktreePath}) — fresh dispatch`,
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
        : isDeployResume
          ? `Resuming after deploy interruption (invocation #${invocationId}, worktree preserved)`
          : isResume
            ? `Resuming session (invocation #${invocationId}, session ${resumeSessionId})`
            : `Dispatched for implementation (invocation #${invocationId})`;
  client.createComment(taskId, dispatchComment).catch((err) => {
    log(`comment failed on dispatch for task ${taskId}: ${err}`);
  });

  // Cron shell tasks: run command directly without a worktree
  if (task.taskType === "cron_shell") {
    updateTaskStatus(db, taskId, "running");
    updateInvocation(db, invocationId, { logPath });

    const shellHandle = spawnShellCommand({
      command: task.agentPrompt,
      cwd: task.repoPath,
      invocationId,
      projectRoot: process.cwd(),
    });

    shellHandles.set(invocationId, shellHandle);
    emitInvocationStarted({ taskId, invocationId });
    log(`dispatched cron_shell task ${taskId} as invocation ${invocationId}`);

    shellHandle.done
      .then((result) => {
        shellHandles.delete(invocationId);
        const success = result.exitCode === 0;
        updateInvocation(db, invocationId, {
          endedAt: new Date().toISOString(),
          status: success ? "completed" : "failed",
          outputSummary: result.outputSummary,
        });
        updateTaskStatus(db, taskId, success ? "done" : "failed");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);
        emitInvocationCompleted({
          taskId,
          invocationId,
          status: success ? "completed" : "failed",
          costUsd: 0,
        });
        log(
          `cron_shell task ${taskId} completed: ${success ? "done" : "failed"} (exit ${result.exitCode})`,
        );
      })
      .catch((err) => {
        shellHandles.delete(invocationId);
        log(`cron_shell task ${taskId} completion error: ${err}`);
        updateInvocation(db, invocationId, {
          endedAt: new Date().toISOString(),
          status: "failed",
          outputSummary: `completion error: ${err}`,
        });
        updateTaskStatus(db, taskId, "failed");
        const updatedTask = getTask(db, taskId);
        if (updatedTask) emitTaskUpdated(updatedTask);
      });

    return;
  }

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

      if (err instanceof WorktreeLockedError) {
        log(
          `worktree locked for task ${taskId} — skipping this tick (no retry burned): ${err.message}`,
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
          outputSummary: `worktree locked (skipped tick, no retry burned): ${err.message}`,
        });
        emitTaskUpdated(getTask(db, taskId)!);
        return;
      }

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
  } else if (isDeployResume) {
    // Deploy-interrupted resume: worktree is preserved, pick up where left off
    agentPrompt = `Previous session was interrupted by a deploy. The worktree at ${worktreeResult.worktreePath} contains its in-progress work. Check \`git log --oneline -10\`, \`git status\`, and \`gh pr list --head ${worktreeResult.branchName}\` to understand what was already done. Continue from where it left off — complete the implementation, commit, push, and open a PR if not already done.\n\nIMPORTANT: This worktree is pre-configured with branch \`${worktreeResult.branchName}\`. You MUST push on this branch — do NOT create a new branch.`;
    systemPrompt = config.implementSystemPrompt || undefined;
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

  // Clear the deploy-interrupted flag so it's not reused again
  if (deployResumedInvocationId != null) {
    updateInvocation(db, deployResumedInvocationId, { worktreePreserved: 0 });
  }

  log(
    `${isDeployResume ? "resumed after deploy" : isResume ? "resumed" : "dispatched"} task ${taskId} as invocation ${invocationId} ` +
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

  // Cron tasks use simple done/failed lifecycle — no Gate 2, review, CI, or deploy
  const cronCheckTask = getTask(db, taskId);
  if (
    cronCheckTask?.taskType === "cron_claude" ||
    cronCheckTask?.taskType === "cron_shell"
  ) {
    const success = result.subtype === "success";
    updateInvocation(db, invocationId, {
      endedAt: new Date().toISOString(),
      status: success ? "completed" : "failed",
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      outputSummary: result.outputSummary,
      sessionId: handle.sessionId,
    });
    if (result.costUsd != null && result.costUsd > 0) {
      insertBudgetEvent(db, {
        invocationId,
        costUsd: result.costUsd,
        recordedAt: new Date().toISOString(),
      });
    }
    updateTaskStatus(db, taskId, success ? "done" : "failed");
    // Clean up worktree if one was created
    if (worktreePath) {
      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal for cron task ${taskId}: ${err}`);
      }
    }
    const updatedCronTask = getTask(db, taskId);
    if (updatedCronTask) emitTaskUpdated(updatedCronTask);
    emitInvocationCompleted({
      taskId,
      invocationId,
      status: success ? "completed" : "failed",
      costUsd: result.costUsd ?? 0,
    });
    emitCurrentStatus(db, config);
    log(`cron task ${taskId} completed: ${success ? "done" : "failed"}`);
    return;
  }

  const isSuccess = result.subtype === "success";
  const invocationStatus = isSuccess ? "completed" : "failed";

  // 1. Update invocation
  updateInvocation(db, invocationId, {
    endedAt: new Date().toISOString(),
    status: invocationStatus,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    outputSummary: result.outputSummary,
    sessionId: handle.sessionId,
  });

  // 2. Insert budget event if cost > 0
  if (result.costUsd != null && result.costUsd > 0) {
    insertBudgetEvent(db, {
      invocationId,
      costUsd: result.costUsd,
      recordedAt: new Date().toISOString(),
    });
  }

  log(
    `session complete: task=${taskId} invocation=${invocationId} status=${invocationStatus} ` +
      `cost=$${result.costUsd != null ? result.costUsd.toFixed(4) : "unknown"} turns=${result.numTurns ?? "unknown"}`,
  );

  // Emit task updated + invocation completed events
  emitTaskUpdated(getTask(db, taskId)!);
  emitInvocationCompleted({
    taskId,
    invocationId,
    status: invocationStatus,
    costUsd: result.costUsd ?? 0,
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

  const failureClassifierState: FailureClassifierState = {
    rateLimitCooldowns,
    terminalWriteBackTasks,
  };

  if (isSuccess) {
    if (phase === "implement") {
      const gate2State: Gate2State = { terminalWriteBackTasks };
      onImplementSuccess(
        deps,
        gate2State,
        taskId,
        invocationId,
        worktreePath,
        result,
        (
          _deps,
          _taskId,
          _invocationId,
          _worktreePath,
          _result,
          _phase,
          _isFixPhase,
        ) =>
          onSessionFailure(
            _deps,
            failureClassifierState,
            _taskId,
            _invocationId,
            _worktreePath,
            _result,
            _phase,
            _isFixPhase,
            handleRetry,
          ),
      );
    } else {
      const reviewState: ReviewResultParserState = {
        noMarkerRetryCounts,
        terminalWriteBackTasks,
      };
      try {
        await onReviewSuccess(
          deps,
          reviewState,
          taskId,
          invocationId,
          worktreePath,
          result,
          handleRetry,
        );
      } catch (err) {
        log(`onReviewSuccess error for task ${taskId}: ${err}`);
      }
    }
  } else {
    onSessionFailure(
      deps,
      failureClassifierState,
      taskId,
      invocationId,
      worktreePath,
      result,
      phase,
      isFixPhase,
      handleRetry,
    );
  }

  // Evaluate parent status if this task is a child
  triggerParentEval(deps, taskId);
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
  const costInWindow = sumCostInWindow(
    db,
    budgetWindowStart(config.budgetWindowHours),
  );
  emitStatusUpdated({
    activeSessions,
    queuedTasks,
    costInWindow,
    budgetLimit: config.budgetMaxCostUsd,
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

  // Also check shell handles for timeout
  for (const [invId, shellHandle] of shellHandles) {
    const runningInv = running.find((r) => r.id === invId);
    if (!runningInv) continue;
    const startedAt = new Date(runningInv.startedAt).getTime();
    if (startedAt + timeoutMs < now) {
      log(
        `shell invocation ${invId} timed out (task ${runningInv.linearIssueId})`,
      );
      shellHandle.process.kill("SIGTERM");
      shellHandles.delete(invId);
      updateInvocation(db, invId, {
        status: "timed_out",
        endedAt: new Date().toISOString(),
      });
      updateTaskStatus(db, runningInv.linearIssueId, "failed");
      const timedOutTask = getTask(db, runningInv.linearIssueId);
      if (timedOutTask) emitTaskUpdated(timedOutTask);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron schedule dispatch
// ---------------------------------------------------------------------------

function checkCronSchedules(deps: SchedulerDeps): void {
  const { db, config } = deps;
  const now = new Date();
  const nowIso = now.toISOString();

  const due = getDueCronSchedules(db, nowIso);
  for (const schedule of due) {
    const runNum = schedule.runCount + 1;
    const taskId = `CRON-${schedule.id}-${runNum}`;

    // Compute next run time
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRunAt(schedule.schedule, now);
    } catch (err) {
      log(
        `cron schedule ${schedule.id} (${schedule.name}): invalid schedule "${schedule.schedule}": ${err}`,
      );
      // Disable the schedule to prevent log spam
      updateCronSchedule(db, schedule.id, { enabled: 0 });
      continue;
    }

    // Insert task
    let insertFailed = false;
    try {
      insertTask(db, {
        linearIssueId: taskId,
        agentPrompt: schedule.prompt,
        repoPath: schedule.repoPath ?? config.defaultCwd ?? process.cwd(),
        orcaStatus: "ready",
        taskType: schedule.type === "shell" ? "cron_shell" : "cron_claude",
        cronScheduleId: schedule.id,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    } catch (err: unknown) {
      // Duplicate key: this run was already created. Still advance the
      // schedule so it doesn't re-fire on the next tick.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("unique")) {
        log(
          `cron schedule ${schedule.id}: task ${taskId} already exists — advancing schedule`,
        );
        insertFailed = true;
      } else {
        log(
          `cron schedule ${schedule.id}: failed to insert task ${taskId}: ${err}`,
        );
        continue;
      }
    }

    // Increment run count and update next_run_at (always, even on duplicate)
    incrementCronRunCount(db, schedule.id, nextRunAt);

    // Auto-disable if maxRuns reached
    if (schedule.maxRuns != null && runNum >= schedule.maxRuns) {
      updateCronSchedule(db, schedule.id, { enabled: 0, nextRunAt: null });
      log(
        `cron schedule ${schedule.id} (${schedule.name}): reached maxRuns ${schedule.maxRuns}, disabling`,
      );
    }

    if (!insertFailed) {
      // Emit event for newly created task
      const newTask = getTask(db, taskId);
      if (newTask) emitTaskUpdated(newTask);

      log(
        `cron schedule ${schedule.id} (${schedule.name}): created task ${taskId} (run ${runNum})`,
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

/** Last poll time per task ID, for throttling deploy checks. */
const deployPollTimes = new Map<string, number>();

/** Last poll time per task ID, for throttling CI checks. */
const ciPollTimes = new Map<string, number>();

/** Last time cleanup ran (epoch ms), for throttling. */
let lastCleanupTime = 0;

// checkDeployments, checkPrCi, and mergeAndFinalize are imported from the gates modules above.

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
    const deployGateState: DeployGateState = {
      deployPollTimes,
      terminalWriteBackTasks,
    };
    await checkDeployments(
      deps,
      deployGateState,
      triggerParentEval,
      isOrcaProjectTask,
      triggerSelfDeploy,
    );

    // Check awaiting_ci tasks (poll PR checks, merge when CI passes)
    const ciGateState: CiGateState = { ciPollTimes, terminalWriteBackTasks };
    await checkPrCi(
      deps,
      ciGateState,
      triggerParentEval,
      isOrcaProjectTask,
      triggerSelfDeploy,
    );

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
        const retentionCutoff = new Date(
          now - config.cronRetentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const pruned = deleteOldCronTasks(db, retentionCutoff);
        if (pruned > 0) {
          log(`pruned ${pruned} old cron task instances`);
        }
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

    // Check cron schedules and create task instances for due schedules
    checkCronSchedules(deps);
  }

  // 1. Count active sessions
  const active = countActiveSessions(db);
  if (active >= config.concurrencyCap) {
    return;
  }

  // 2. Check budget
  const cost = sumCostInWindow(db, budgetWindowStart(config.budgetWindowHours));
  if (cost >= config.budgetMaxCostUsd) {
    log(
      `budget exhausted: $${cost.toFixed(4)} used of $${config.budgetMaxCostUsd} limit`,
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
      if (t.taskType === "cron_claude" || t.taskType === "cron_shell") {
        return true; // cron tasks don't go through the Linear dependency graph
      }
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
          `budget: $${config.budgetMaxCostUsd}/${config.budgetWindowHours}h)`,
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

      // Kill all shell handles
      for (const [invId, shellHandle] of shellHandles) {
        log(`killing shell process for invocation ${invId}`);
        shellHandle.process.kill("SIGTERM");
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
