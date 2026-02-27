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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  db: OrcaDb,
  config: OrcaConfig,
  task: ReturnType<typeof getReadyTasks>[number],
): Promise<void> {
  const taskId = task.linearIssueId;

  // 1. Mark task as dispatched
  updateTaskStatus(db, taskId, "dispatched");

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
      db, config, taskId, invocationId, handle, result,
      worktreeResult.worktreePath,
    );
  });
}

// ---------------------------------------------------------------------------
// Session completion handler (6.6)
// ---------------------------------------------------------------------------

function onSessionComplete(
  db: OrcaDb,
  config: OrcaConfig,
  taskId: string,
  invocationId: number,
  handle: SessionHandle,
  result: SessionResult,
  worktreePath: string,
): void {
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
    handleRetry(db, config, taskId);
  }
}

// ---------------------------------------------------------------------------
// Retry logic (6.5)
// ---------------------------------------------------------------------------

function handleRetry(db: OrcaDb, config: OrcaConfig, taskId: string): void {
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
  } else {
    log(
      `task ${taskId} exhausted all retries (${config.maxRetries}), leaving as failed`,
    );
  }
}

// ---------------------------------------------------------------------------
// Timeout check (6.4)
// ---------------------------------------------------------------------------

function checkTimeouts(db: OrcaDb, config: OrcaConfig): void {
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
      handleRetry(db, config, inv.linearIssueId);
    }
  }
}

// ---------------------------------------------------------------------------
// Tick (6.2)
// ---------------------------------------------------------------------------

async function tick(db: OrcaDb, config: OrcaConfig): Promise<void> {
  // 6.4 - Check for timed-out invocations first
  checkTimeouts(db, config);

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

  // 6. Pick first and dispatch
  const task = readyTasks[0]!;
  await dispatch(db, config, task);
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
export function startScheduler(db: OrcaDb, config: OrcaConfig): SchedulerHandle {
  let ticking = false;

  async function guardedTick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await tick(db, config);
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
