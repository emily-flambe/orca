import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import {
  countActiveSessions,
  getReadyTasks,
  getRunningInvocations,
  getTask,
  incrementRetryCount,
  insertBudgetEvent,
  insertInvocation,
  sumCostInWindow,
  updateInvocation,
  updateTaskStatus,
} from "../db/queries.js";
import {
  spawnSession,
  killSession,
  type SessionHandle,
  type SessionResult,
} from "../runner/index.js";
import { createWorktree, removeWorktree } from "../worktree/index.js";
import type { DependencyGraph } from "../linear/graph.js";
import type { LinearClient } from "../linear/client.js";
import type { WorkflowStateMap } from "../linear/client.js";
import { writeBackStatus } from "../linear/sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  deps: SchedulerDeps,
  task: ReturnType<typeof getReadyTasks>[number],
): Promise<void> {
  const { db, config, client, stateMap } = deps;
  const taskId = task.linearIssueId;

  // 1. Mark task as dispatched
  updateTaskStatus(db, taskId, "dispatched");

  // 8.4 Write-back on dispatch (fire-and-forget)
  writeBackStatus(client, taskId, "dispatched", stateMap).catch((err) => {
    log(`write-back failed on dispatch for task ${taskId}: ${err}`);
  });

  // 2. Insert invocation record
  const now = new Date().toISOString();
  const invocationId = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now,
    status: "running",
  });

  const logPath = `logs/${invocationId}.ndjson`;

  // 3. Create worktree
  let worktreeResult: { worktreePath: string; branchName: string };
  try {
    worktreeResult = createWorktree(task.repoPath, taskId, invocationId);
  } catch (err) {
    log(`worktree creation failed for task ${taskId}: ${err}`);
    updateTaskStatus(db, taskId, "failed");
    updateInvocation(db, invocationId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      outputSummary: `worktree creation failed: ${err}`,
    });
    return;
  }

  // 4. Spawn session
  const disallowedTools = config.disallowedTools
    ? config.disallowedTools.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const handle = spawnSession({
    agentPrompt: task.agentPrompt,
    worktreePath: worktreeResult.worktreePath,
    maxTurns: config.defaultMaxTurns,
    invocationId,
    projectRoot: process.cwd(),
    claudePath: config.claudePath,
    appendSystemPrompt: config.appendSystemPrompt || undefined,
    disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
  });

  // 5. Update task to running
  updateTaskStatus(db, taskId, "running");

  // 6. Update invocation with worktree details
  updateInvocation(db, invocationId, {
    branchName: worktreeResult.branchName,
    worktreePath: worktreeResult.worktreePath,
    logPath,
  });

  // 7. Store handle
  activeHandles.set(invocationId, handle);

  log(
    `dispatched task ${taskId} as invocation ${invocationId} ` +
      `(branch: ${worktreeResult.branchName})`,
  );

  // 8. Attach completion handler
  handle.done.then((result) => {
    onSessionComplete(
      deps, taskId, invocationId, handle, result,
      worktreeResult.worktreePath,
    );
  });
}

// ---------------------------------------------------------------------------
// Session completion handler (6.6)
// ---------------------------------------------------------------------------

function onSessionComplete(
  deps: SchedulerDeps,
  taskId: string,
  invocationId: number,
  handle: SessionHandle,
  result: SessionResult,
  worktreePath: string,
): void {
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

  if (isSuccess) {
    // 3. Success: mark task done, remove worktree
    updateTaskStatus(db, taskId, "done");

    // 8.5 Write-back on success (fire-and-forget)
    writeBackStatus(client, taskId, "done", stateMap).catch((err) => {
      log(`write-back failed on completion for task ${taskId}: ${err}`);
    });

    try {
      removeWorktree(worktreePath);
    } catch (err) {
      log(`worktree removal failed for invocation ${invocationId}: ${err}`);
    }

    log(
      `task ${taskId} completed successfully (invocation ${invocationId}, ` +
        `cost: $${result.costUsd ?? "unknown"}, turns: ${result.numTurns ?? "unknown"})`,
    );
  } else {
    // 4. Failure: mark task failed, preserve worktree, attempt retry
    updateTaskStatus(db, taskId, "failed");

    log(
      `task ${taskId} failed (invocation ${invocationId}, ` +
        `subtype: ${result.subtype}, summary: ${result.outputSummary})`,
    );

    // 5. Retry logic
    handleRetry(deps, taskId);
  }
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

    // 8.5 Write-back on retry (fire-and-forget)
    writeBackStatus(client, taskId, "retry", stateMap).catch((err) => {
      log(`write-back failed on retry for task ${taskId}: ${err}`);
    });
  } else {
    log(
      `task ${taskId} exhausted all retries (${config.maxRetries}), leaving as failed`,
    );

    // 8.5 Write-back on permanent failure (fire-and-forget)
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
// Tick (6.2)
// ---------------------------------------------------------------------------

async function tick(deps: SchedulerDeps): Promise<void> {
  const { db, config, graph } = deps;

  // 6.4 - Check for timed-out invocations first
  checkTimeouts(deps);

  // 1. Count active sessions
  const active = countActiveSessions(db);
  if (active >= config.concurrencyCap) {
    return;
  }

  // 3. Check budget
  const windowStart = new Date(
    Date.now() - config.budgetWindowHours * 60 * 60 * 1000,
  ).toISOString();
  const cost = sumCostInWindow(db, windowStart);
  if (cost >= config.budgetMaxCostUsd) {
    log("budget exhausted");
    return;
  }

  // 5. Get ready tasks
  const readyTasks = getReadyTasks(db);
  if (readyTasks.length === 0) {
    return;
  }

  // 8.3 Skip tasks with empty agent_prompt
  // 8.1 Filter blocked tasks via dependency graph
  const getStatus = (id: string): string | undefined =>
    getTask(db, id)?.orcaStatus;

  const dispatchable = readyTasks.filter((t) => {
    if (!t.agentPrompt) return false;
    return graph.isDispatchable(t.linearIssueId, getStatus);
  });

  if (dispatchable.length === 0) {
    return;
  }

  // 8.2 Sort by effective priority (ascending), tiebreak by created_at
  const getPriority = (id: string): number =>
    getTask(db, id)?.priority ?? 0;

  dispatchable.sort((a, b) => {
    const aPrio = graph.computeEffectivePriority(a.linearIssueId, getPriority);
    const bPrio = graph.computeEffectivePriority(b.linearIssueId, getPriority);
    if (aPrio !== bPrio) return aPrio - bPrio;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });

  // 6. Pick first and dispatch
  const task = dispatchable[0]!;
  await dispatch(deps, task);
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
