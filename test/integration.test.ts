import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getAllTasks,
  getTask,
  updateTaskStatus,
  incrementRetryCount,
  insertInvocation,
  insertBudgetEvent,
  sumCostInWindow,
  countActiveSessions,
  getReadyTasks,
} from "../src/db/queries.js";
import { spawnSession, killSession, type SessionHandle } from "../src/runner/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory database for each test. */
function freshDb(): OrcaDb {
  return createDb(":memory:");
}

/** ISO timestamp for "now". */
function now(): string {
  return new Date().toISOString();
}

/** Insert a minimal valid task and return its ID. */
function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: "ready" | "dispatched" | "running" | "done" | "failed";
    priority: number;
    retryCount: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

/**
 * Insert a task + invocation so we can reference the invocation ID
 * (needed for budget_events foreign key).
 */
function seedInvocationForBudget(db: OrcaDb, taskId: string): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    status: "completed",
  });
}

// ---------------------------------------------------------------------------
// 9.1  Add task via DB and verify
// ---------------------------------------------------------------------------

describe("9.1 - Add task via DB and verify", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("insertTask stores all fields and getAllTasks returns them", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "TASK-1",
      agentPrompt: "fix the bug",
      repoPath: "/repos/myapp",
      orcaStatus: "ready",
      priority: 2,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });

    const tasks = getAllTasks(db);
    expect(tasks).toHaveLength(1);

    const task = tasks[0]!;
    expect(task.linearIssueId).toBe("TASK-1");
    expect(task.agentPrompt).toBe("fix the bug");
    expect(task.repoPath).toBe("/repos/myapp");
    expect(task.orcaStatus).toBe("ready");
    expect(task.priority).toBe(2);
    expect(task.retryCount).toBe(0);
    expect(task.createdAt).toBe(ts);
    expect(task.updatedAt).toBe(ts);
  });

  test("getTask retrieves a specific task by ID", () => {
    seedTask(db, { linearIssueId: "A" });
    seedTask(db, { linearIssueId: "B" });

    const a = getTask(db, "A");
    expect(a).toBeDefined();
    expect(a!.linearIssueId).toBe("A");

    const missing = getTask(db, "Z");
    expect(missing).toBeUndefined();
  });

  test("defaults: orca_status='ready', retry_count=0", () => {
    const ts = now();
    // Insert with only the required fields, relying on defaults where possible
    insertTask(db, {
      linearIssueId: "DEFAULT-CHECK",
      agentPrompt: "test defaults",
      repoPath: "/tmp/r",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "DEFAULT-CHECK");
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.retryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9.2  Runner: spawnSession with mock claude script
// ---------------------------------------------------------------------------

describe("9.2 - Runner spawns mock claude session through full lifecycle", () => {
  let tmpDir: string;
  let mockScript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-test-"));

    // Create a mock "claude" Node.js script that emits stream-json lines.
    // Uses Node.js instead of bash so tests work cross-platform (including Windows).
    // Does NOT call process.exit() — letting Node drain stdout naturally avoids
    // the buffering race where exit kills the process before the pipe flushes.
    mockScript = join(tmpDir, "mock-claude.js");
    writeFileSync(
      mockScript,
      [
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"test-123"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.05,num_turns:3,result:"done"}) + "\\n");',
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("spawnSession parses init and result messages correctly", async () => {
    const handle = spawnSession({
      agentPrompt: "test prompt",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: 42,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [mockScript],
    });

    const result = await handle.done;

    expect(result.subtype).toBe("success");
    expect(result.costUsd).toBe(0.05);
    expect(result.numTurns).toBe(3);
    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toBe("done");

    // session_id should have been captured
    expect(handle.sessionId).toBe("test-123");
  });

  test("log file is created", async () => {
    const handle = spawnSession({
      agentPrompt: "log test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: 99,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [mockScript],
    });

    await handle.done;

    const logPath = join(tmpDir, "logs", "99.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9.3  Timeout enforcement / killSession
// ---------------------------------------------------------------------------

describe("9.3 - Timeout enforcement via killSession", () => {
  let tmpDir: string;
  let sleepScript: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-test-kill-"));

    // A mock claude Node.js script that stays alive for 60 s.
    // Uses setTimeout to keep the event loop open (cross-platform).
    sleepScript = join(tmpDir, "mock-claude-sleep.js");
    writeFileSync(
      sleepScript,
      [
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"sleepy"}) + "\\n");',
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("killSession terminates a long-running process", async () => {
    const handle = spawnSession({
      agentPrompt: "hang forever",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: 200,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [sleepScript],
    });

    // Give the script a moment to start and emit the init line
    await new Promise((r) => setTimeout(r, 300));

    // Kill the session
    const result = await killSession(handle);

    // The process was killed, so exitCode should be null (signal kill) or non-zero
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);

    // Subtype should indicate an error since no result message was emitted
    expect(result.subtype).toBe("process_error");
  }, 20_000); // generous timeout: killSession has a 5s grace before SIGKILL
});

// ---------------------------------------------------------------------------
// 9.4  Retry logic
// ---------------------------------------------------------------------------

describe("9.4 - Retry logic", () => {
  let db: OrcaDb;
  const maxRetries = 3;

  beforeEach(() => {
    db = freshDb();
  });

  test("incrementRetryCount resets status to ready and bumps count", () => {
    const taskId = seedTask(db, { linearIssueId: "RETRY-1", retryCount: 0 });

    // Simulate failure
    updateTaskStatus(db, taskId, "failed");
    let task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("failed");
    expect(task.retryCount).toBe(0);

    // First retry
    incrementRetryCount(db, taskId);
    task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(1);
  });

  test("retries up to maxRetries, then stays failed", () => {
    const taskId = seedTask(db, { linearIssueId: "RETRY-EXHAUST" });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Simulate failure
      updateTaskStatus(db, taskId, "failed");
      const task = getTask(db, taskId)!;

      if (task.retryCount < maxRetries) {
        incrementRetryCount(db, taskId);
        const updated = getTask(db, taskId)!;
        expect(updated.orcaStatus).toBe("ready");
        expect(updated.retryCount).toBe(attempt + 1);
      }
    }

    // Now fail one more time -- retryCount is at maxRetries
    updateTaskStatus(db, taskId, "failed");
    const finalTask = getTask(db, taskId)!;
    expect(finalTask.retryCount).toBe(maxRetries);
    expect(finalTask.orcaStatus).toBe("failed");

    // Should NOT retry because retryCount >= maxRetries
    // (Mirrors the scheduler's handleRetry logic)
    if (finalTask.retryCount < maxRetries) {
      incrementRetryCount(db, taskId);
    }

    const afterCheck = getTask(db, taskId)!;
    expect(afterCheck.orcaStatus).toBe("failed");
    expect(afterCheck.retryCount).toBe(maxRetries);
  });

  test("getReadyTasks returns tasks reset by incrementRetryCount", () => {
    const taskId = seedTask(db, { linearIssueId: "RETRY-QUEUE" });
    updateTaskStatus(db, taskId, "failed");

    // No ready tasks (it's failed)
    expect(getReadyTasks(db)).toHaveLength(0);

    // Retry resets to ready
    incrementRetryCount(db, taskId);
    const ready = getReadyTasks(db);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.linearIssueId).toBe("RETRY-QUEUE");
  });
});

// ---------------------------------------------------------------------------
// 9.5  Budget enforcement
// ---------------------------------------------------------------------------

describe("9.5 - Budget enforcement", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("sumCostInWindow returns correct total for recent events", () => {
    const taskId = seedTask(db, { linearIssueId: "BUDGET-1" });
    const invId = seedInvocationForBudget(db, taskId);

    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 1.5,
      recordedAt: now(),
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 2.0,
      recordedAt: now(),
    });

    // Window start = 1 hour ago
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const total = sumCostInWindow(db, windowStart);
    expect(total).toBeCloseTo(3.5);
  });

  test("events outside the window are excluded", () => {
    const taskId = seedTask(db, { linearIssueId: "BUDGET-2" });
    const invId = seedInvocationForBudget(db, taskId);

    // Old event: 5 hours ago
    const oldTimestamp = new Date(
      Date.now() - 5 * 60 * 60 * 1000,
    ).toISOString();
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 100.0,
      recordedAt: oldTimestamp,
    });

    // Recent event
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0.5,
      recordedAt: now(),
    });

    // Window = 4 hours
    const windowStart = new Date(
      Date.now() - 4 * 60 * 60 * 1000,
    ).toISOString();
    const total = sumCostInWindow(db, windowStart);

    // Only the recent 0.5 should be counted, not the old 100.0
    expect(total).toBeCloseTo(0.5);
  });

  test("sumCostInWindow returns 0 when no events exist", () => {
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const total = sumCostInWindow(db, windowStart);
    expect(total).toBe(0);
  });

  test("budget check logic: dispatch blocked when cost >= max", () => {
    const budgetMaxCostUsd = 10.0;
    const budgetWindowHours = 4;

    const taskId = seedTask(db, { linearIssueId: "BUDGET-BLOCK" });
    const invId = seedInvocationForBudget(db, taskId);

    // Insert events totaling $10.50 (over budget)
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 7.0,
      recordedAt: now(),
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 3.5,
      recordedAt: now(),
    });

    // Replicate the scheduler tick's budget check
    const windowStart = new Date(
      Date.now() - budgetWindowHours * 60 * 60 * 1000,
    ).toISOString();
    const cost = sumCostInWindow(db, windowStart);

    // Budget is exhausted: cost ($10.50) >= max ($10.00)
    expect(cost).toBeGreaterThanOrEqual(budgetMaxCostUsd);

    // Ready tasks exist but should NOT be dispatched
    const readyTasks = getReadyTasks(db);
    expect(readyTasks.length).toBeGreaterThan(0);

    // The tick would return early here -- this is the guard condition
    const shouldSkipDispatch = cost >= budgetMaxCostUsd;
    expect(shouldSkipDispatch).toBe(true);
  });

  test("budget check logic: dispatch allowed when cost < max", () => {
    const budgetMaxCostUsd = 10.0;
    const budgetWindowHours = 4;

    const taskId = seedTask(db, { linearIssueId: "BUDGET-OK" });
    const invId = seedInvocationForBudget(db, taskId);

    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 2.0,
      recordedAt: now(),
    });

    const windowStart = new Date(
      Date.now() - budgetWindowHours * 60 * 60 * 1000,
    ).toISOString();
    const cost = sumCostInWindow(db, windowStart);

    expect(cost).toBeLessThan(budgetMaxCostUsd);

    const shouldSkipDispatch = cost >= budgetMaxCostUsd;
    expect(shouldSkipDispatch).toBe(false);
  });

  test("concurrency cap blocks dispatch when active sessions >= cap", () => {
    const concurrencyCap = 2;
    const taskId = seedTask(db, { linearIssueId: "CONC-1" });

    // Seed "running" invocations to simulate active sessions
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });

    const active = countActiveSessions(db);
    expect(active).toBe(2);
    expect(active >= concurrencyCap).toBe(true);
  });
});
