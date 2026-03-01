// PR lifecycle gates verified
import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import {
  countActiveSessions,
  getAllTasks,
  getDeployingTasks,
  getDispatchableTasks,
  getInvocationsByTask,
  getRunningInvocations,
  getTask,
  incrementRetryCount,
  incrementReviewCycleCount,
  insertBudgetEvent,
  insertInvocation,
  sumCostInWindow,
  updateInvocation,
  updateTaskDeployInfo,
  updateTaskPrBranch,
  updateTaskStatus,
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
import { createWorktree, removeWorktree } from "../worktree/index.js";
import { findPrForBranch, getMergeCommitSha, getWorkflowRunStatus } from "../github/index.js";
import { cleanupStaleResources } from "../cleanup/index.js";
import type { DependencyGraph } from "../linear/graph.js";
import type { LinearClient } from "../linear/client.js";
import type { WorkflowStateMap } from "../linear/client.js";
import { writeBackStatus } from "../linear/sync.js";

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
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Active session handles keyed by invocation ID.
 * Exported so the CLI shutdown handler can iterate and kill them.
 */
export const activeHandles = new Map<number, SessionHandle>();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/scheduler] ${message}`);
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

  // Guard: re-read task from DB and verify it's still in a dispatchable state.
  // Between the tick() query and this dispatch() call, a completion handler or
  // webhook could have changed the task's status (e.g. to "done").
  const freshTask = getTask(db, taskId);
  if (!freshTask) {
    log(`dispatch aborted: task ${taskId} no longer exists`);
    return;
  }
  const dispatchableStatuses = new Set<TaskStatus>(["ready", "in_review", "changes_requested"]);
  if (!dispatchableStatuses.has(freshTask.orcaStatus)) {
    log(`dispatch aborted: task ${taskId} is now "${freshTask.orcaStatus}" (no longer dispatchable)`);
    return;
  }

  // Guard: ensure no running invocation already exists for this task.
  const runningInvs = getRunningInvocations(db);
  const alreadyRunning = runningInvs.some((inv) => inv.linearIssueId === taskId);
  if (alreadyRunning) {
    log(`dispatch aborted: task ${taskId} already has a running invocation`);
    return;
  }

  // 1. Mark task as dispatched
  updateTaskStatus(db, taskId, "dispatched");
  emitTaskUpdated(getTask(db, taskId)!);

  // Write-back on dispatch: implement/fix → "In Progress", review → skip (already "In Review")
  if (phase === "implement") {
    writeBackStatus(client, taskId, "dispatched", stateMap).catch((err) => {
      log(`write-back failed on dispatch for task ${taskId}: ${err}`);
    });
  }

  // 2. Insert invocation record with phase
  const now = new Date().toISOString();
  const invocationId = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now,
    status: "running",
    phase,
  });

  const logPath = `logs/${invocationId}.ndjson`;

  // 3. Determine worktree base ref
  const useExistingBranch = phase === "review" || (phase === "implement" && task.orcaStatus === "changes_requested");
  const baseRef = useExistingBranch && task.prBranchName ? task.prBranchName : undefined;

  // 4. Create worktree
  let worktreeResult: { worktreePath: string; branchName: string };
  try {
    worktreeResult = createWorktree(task.repoPath, taskId, invocationId, { baseRef });
  } catch (err) {
    log(`worktree creation failed for task ${taskId}: ${err}`);
    updateTaskStatus(db, taskId, "failed");
    updateInvocation(db, invocationId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      outputSummary: `worktree creation failed: ${err}`,
    });
    emitTaskUpdated(getTask(db, taskId)!);
    handleRetry(deps, taskId);
    return;
  }

  // 5. Build agent prompt and system prompt based on phase
  let agentPrompt = task.agentPrompt;
  let systemPrompt: string | undefined;
  let maxTurns = config.defaultMaxTurns;

  const disallowedTools = config.disallowedTools
    ? config.disallowedTools.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  if (phase === "review") {
    const prRef = task.prNumber ? `#${task.prNumber}` : "on this branch";
    agentPrompt = `${task.agentPrompt}\n\nReview PR ${prRef}. The PR branch is checked out in your working directory.`;
    systemPrompt = config.reviewSystemPrompt || undefined;
    maxTurns = config.reviewMaxTurns;
  } else if (useExistingBranch) {
    // Fix phase (implement on changes_requested)
    agentPrompt = `${task.agentPrompt}\n\nFix issues from code review.`;
    systemPrompt = config.fixSystemPrompt || undefined;
  } else {
    // Normal implement
    systemPrompt = config.appendSystemPrompt || undefined;
  }

  // 6. Spawn session
  const handle = spawnSession({
    agentPrompt,
    worktreePath: worktreeResult.worktreePath,
    maxTurns,
    invocationId,
    projectRoot: process.cwd(),
    claudePath: config.claudePath,
    appendSystemPrompt: systemPrompt,
    disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
  });

  // 7. Update task to running
  updateTaskStatus(db, taskId, "running");

  // 8. Update invocation with worktree details
  updateInvocation(db, invocationId, {
    branchName: worktreeResult.branchName,
    worktreePath: worktreeResult.worktreePath,
    logPath,
  });

  // 9. Store handle
  activeHandles.set(invocationId, handle);
  emitInvocationStarted({ taskId, invocationId });

  log(
    `dispatched task ${taskId} as invocation ${invocationId} ` +
      `(phase: ${phase}, branch: ${worktreeResult.branchName})`,
  );

  // 10. Attach completion handler
  attachCompletionHandler(deps, taskId, invocationId, handle, worktreeResult.worktreePath, phase);
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
): void {
  handle.done.then((result) => {
    onSessionComplete(deps, taskId, invocationId, handle, result, worktreePath, phase);
  }).catch((err) => {
    log(`completion handler error for invocation ${invocationId} (task ${taskId}): ${err}`);
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
      log(`cleanup also failed for invocation ${invocationId}: ${cleanupErr}`);
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
): Promise<void> {
  const { db, config, client, stateMap } = deps;

  // Remove from active handles
  activeHandles.delete(invocationId);

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
    const terminalStatuses = new Set<TaskStatus>(["done", "failed", "deploying"]);
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
    onSessionFailure(deps, taskId, invocationId, worktreePath, result);
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
  const { db, config, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) return;

  // Get branch name from the invocation record
  const invocations = getInvocationsByTask(db, taskId);
  const thisInv = invocations.find((inv) => inv.id === invocationId);
  const branchName = thisInv?.branchName ?? task.prBranchName;

  // Hard gate: branch name is required
  if (!branchName) {
    const gateSummary = "Post-implementation gate failed: no branch name found on invocation or task";
    log(`task ${taskId}: ${gateSummary} — treating as failure`);
    updateInvocation(db, invocationId, { status: "failed", outputSummary: gateSummary });
    onSessionFailure(deps, taskId, invocationId, worktreePath, result);
    return;
  }

  // Hard gate: PR must exist
  const prInfo = findPrForBranch(branchName, task.repoPath);
  if (!prInfo.exists) {
    const gateSummary = `Post-implementation gate failed: no PR found for branch ${branchName}`;
    log(`task ${taskId}: ${gateSummary} — treating as failure`);
    updateInvocation(db, invocationId, { status: "failed", outputSummary: gateSummary });
    onSessionFailure(deps, taskId, invocationId, worktreePath, result);
    return;
  }

  // Store the PR branch name and PR number on the task
  updateTaskPrBranch(db, taskId, branchName);
  if (prInfo.number != null) {
    updateTaskDeployInfo(db, taskId, { prNumber: prInfo.number });
  }

  // Attach PR link to Linear issue (fire-and-forget)
  if (prInfo.url) {
    client.createAttachment(task.linearIssueId, prInfo.url, "Pull Request").catch((err) => {
      log(`failed to attach PR link to Linear issue ${taskId}: ${err}`);
    });
  }

  // Transition to in_review
  updateTaskStatus(db, taskId, "in_review");
  emitTaskUpdated(getTask(db, taskId)!);

  // Write-back "In Review"
  writeBackStatus(client, taskId, "in_review", stateMap).catch((err) => {
    log(`write-back failed on implement success for task ${taskId}: ${err}`);
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
    // Hard gate: verify PR is actually merged before proceeding
    let prMerged = false;
    if (task.prBranchName) {
      const prInfo = findPrForBranch(task.prBranchName, task.repoPath);
      prMerged = prInfo.merged === true;
    }

    if (!prMerged) {
      log(`task ${taskId}: REVIEW_RESULT:APPROVED but PR is not merged — leaving as in_review`);
      updateTaskStatus(db, taskId, "in_review");
      emitTaskUpdated(getTask(db, taskId)!);

      try {
        removeWorktree(worktreePath);
      } catch (err) {
        log(`worktree removal failed for invocation ${invocationId}: ${err}`);
      }
      return;
    }

    // PR is confirmed merged — clean up worktree and proceed
    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }

    if (config.deployStrategy === "github_actions") {
      // Look up PR number and merge commit SHA
      let prNumber: number | undefined;
      let mergeCommitSha: string | null = null;

      if (task.prBranchName) {
        const prInfo = findPrForBranch(task.prBranchName, task.repoPath);
        prNumber = prInfo.number;
      }

      if (prNumber) {
        mergeCommitSha = await getMergeCommitSha(prNumber, task.repoPath);
      }

      const now = new Date().toISOString();
      updateTaskDeployInfo(db, taskId, {
        mergeCommitSha,
        prNumber: prNumber ?? null,
        deployStartedAt: now,
      });
      updateTaskStatus(db, taskId, "deploying");
      emitTaskUpdated(getTask(db, taskId)!);

      log(
        `task ${taskId} review approved → deploying ` +
          `(PR #${prNumber ?? "?"}, SHA: ${mergeCommitSha ?? "unknown"})`,
      );
    } else {
      // deploy_strategy = "none" — go straight to done
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);

      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on review approved for task ${taskId}: ${err}`);
      });

      log(`task ${taskId} review approved → done (invocation ${invocationId})`);
    }
  } else if (changesRequested) {
    if (task.reviewCycleCount < config.maxReviewCycles) {
      // Increment cycle count and send back for fixes
      incrementReviewCycleCount(db, taskId);
      updateTaskStatus(db, taskId, "changes_requested");
      emitTaskUpdated(getTask(db, taskId)!);

      writeBackStatus(client, taskId, "changes_requested", stateMap).catch((err) => {
        log(`write-back failed on changes requested for task ${taskId}: ${err}`);
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
    // No review result marker found — treat as review failure, retry review
    log(`task ${taskId}: review completed but no REVIEW_RESULT marker found — retrying review`);
    updateTaskStatus(db, taskId, "in_review");
    emitTaskUpdated(getTask(db, taskId)!);

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
): void {
  const { db } = deps;

  updateTaskStatus(db, taskId, "failed");
  emitTaskUpdated(getTask(db, taskId)!);

  log(
    `task ${taskId} failed (invocation ${invocationId}, ` +
      `subtype: ${result.subtype}, summary: ${result.outputSummary})`,
  );

  // Clean up worktree so retries start fresh
  try {
    removeWorktree(worktreePath);
  } catch (err) {
    log(`worktree removal on failure for invocation ${invocationId}: ${err}`);
  }

  // Retry logic
  handleRetry(deps, taskId);
}

// ---------------------------------------------------------------------------
// Status emission helper
// ---------------------------------------------------------------------------

function emitCurrentStatus(db: OrcaDb, config: OrcaConfig): void {
  const activeSessions = countActiveSessions(db);
  const allTasks = getAllTasks(db);
  const queuedTasks = allTasks.filter(
    (t) => t.orcaStatus === "ready" || t.orcaStatus === "in_review" || t.orcaStatus === "changes_requested",
  ).length;
  const windowStart = new Date(
    Date.now() - config.budgetWindowHours * 60 * 60 * 1000,
  ).toISOString();
  const costInWindow = sumCostInWindow(db, windowStart);
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

function handleRetry(deps: SchedulerDeps, taskId: string): void {
  const { db, config, client, stateMap } = deps;
  const task = getTask(db, taskId);
  if (!task) {
    log(`retry: task ${taskId} not found`);
    return;
  }

  if (task.retryCount < config.maxRetries) {
    incrementRetryCount(db, taskId);
    log(
      `task ${taskId} queued for retry (attempt ${task.retryCount + 1}/${config.maxRetries})`,
    );

    // Write-back on retry (fire-and-forget)
    writeBackStatus(client, taskId, "retry", stateMap).catch((err) => {
      log(`write-back failed on retry for task ${taskId}: ${err}`);
    });
  } else {
    log(
      `task ${taskId} exhausted all retries (${config.maxRetries}), leaving as failed`,
    );

    // Write-back on permanent failure (fire-and-forget)
    writeBackStatus(client, taskId, "failed_permanent", stateMap).catch((err) => {
      log(`write-back failed on permanent failure for task ${taskId}: ${err}`);
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
    log(`invocation ${invId}: process already exited (code ${exitCode}) but handle still active — forcing cleanup`);
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
      handleRetry(deps, inv.linearIssueId);
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
      handleRetry(deps, inv.linearIssueId);
    }
  }
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

        writeBackStatus(client, taskId, "failed_permanent", stateMap).catch((err) => {
          log(`write-back failed on deploy timeout for task ${taskId}: ${err}`);
        });

        log(`task ${taskId} deploy timed out after ${config.deployTimeoutMin}min`);
        continue;
      }
    }

    // Defensive: no SHA means we can't monitor — mark done with warning
    if (!task.mergeCommitSha) {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy (no SHA) for task ${taskId}: ${err}`);
      });

      log(`task ${taskId} deploying → done (no merge commit SHA, skipping CI check)`);
      continue;
    }

    // Poll GitHub Actions
    const status = await getWorkflowRunStatus(task.mergeCommitSha, task.repoPath);

    if (status === "success") {
      updateTaskStatus(db, taskId, "done");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
        log(`write-back failed on deploy success for task ${taskId}: ${err}`);
      });

      log(`task ${taskId} deploy succeeded → done (SHA: ${task.mergeCommitSha})`);
    } else if (status === "failure") {
      updateTaskStatus(db, taskId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      deployPollTimes.delete(taskId);

      writeBackStatus(client, taskId, "failed_permanent", stateMap).catch((err) => {
        log(`write-back failed on deploy failure for task ${taskId}: ${err}`);
      });

      log(`task ${taskId} deploy failed → failed (SHA: ${task.mergeCommitSha})`);
    }
    // "pending", "in_progress", "no_runs" → skip, poll again next interval
  }
}

// ---------------------------------------------------------------------------
// Tick — multi-phase dispatch
// ---------------------------------------------------------------------------

async function tick(deps: SchedulerDeps): Promise<void> {
  const { db, config, graph } = deps;

  // Check for timed-out invocations first
  checkTimeouts(deps);

  // Check deploying tasks (non-blocking per-task polling)
  await checkDeployments(deps);

  // Periodic cleanup of stale branches and orphaned worktrees
  const cleanupIntervalMs = config.cleanupIntervalMin * 60 * 1000;
  const now = Date.now();
  if (now - lastCleanupTime >= cleanupIntervalMs) {
    lastCleanupTime = now;
    try {
      cleanupStaleResources({ db, config });
    } catch (err) {
      log(`cleanup error: ${err}`);
    }
  }

  // 1. Count active sessions
  const active = countActiveSessions(db);
  if (active >= config.concurrencyCap) {
    return;
  }

  // 2. Check budget
  const windowStart = new Date(
    Date.now() - config.budgetWindowHours * 60 * 60 * 1000,
  ).toISOString();
  const cost = sumCostInWindow(db, windowStart);
  if (cost >= config.budgetMaxCostUsd) {
    log("budget exhausted");
    return;
  }

  // 3. Get tasks in dispatchable states: ready, in_review, changes_requested
  const candidateStatuses: TaskStatus[] = ["ready", "in_review", "changes_requested"];
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
  const tasksWithRunningInv = new Set(runningInvs.map((inv) => inv.linearIssueId));

  const dispatchable = candidates.filter((t) => {
    if (!t.agentPrompt) return false;
    if (tasksWithRunningInv.has(t.linearIssueId)) return false;
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

  const getPriority = (id: string): number =>
    getTask(db, id)?.priority ?? 0;

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
 *
 * @returns A handle with a `stop()` method that clears the interval and
 *          kills all active sessions.
 */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { config } = deps;
  let ticking = false;

  async function guardedTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await tick(deps);
    } catch (err) {
      log(`tick error: ${err}`);
    } finally {
      ticking = false;
    }
  }

  // Run first tick immediately
  guardedTick();

  const intervalId = setInterval(
    () => { guardedTick(); },
    config.schedulerIntervalSec * 1000,
  );

  log(
    `started (interval: ${config.schedulerIntervalSec}s, ` +
      `concurrency: ${config.concurrencyCap}, ` +
      `budget: $${config.budgetMaxCostUsd}/${config.budgetWindowHours}h)`,
  );

  return {
    stop() {
      clearInterval(intervalId);
      log("stopping scheduler, killing active sessions...");

      // Kill all active sessions
      const killPromises: Promise<SessionResult>[] = [];
      for (const [invId, handle] of activeHandles) {
        log(`killing session for invocation ${invId}`);
        killPromises.push(
          killSession(handle).catch((err) => {
            log(`error killing session ${invId} during shutdown: ${err}`);
            return handle.done;
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
}
