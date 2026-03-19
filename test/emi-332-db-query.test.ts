// ---------------------------------------------------------------------------
// DB-level adversarial tests for EMI-332 countZeroCostFailuresSince query
//
// Uses a real in-memory SQLite database to prove the query behavior, not mocks.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  countZeroCostFailuresSince,
  budgetWindowStart,
} from "../src/db/queries.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let taskCounter = 0;

function seedTask(db: OrcaDb): string {
  const id = `DB-TEST-${++taskCounter}`;
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test",
    repoPath: "/tmp/repo",
    orcaStatus: "ready",
    priority: 0,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    isParent: 0,
    parentIdentifier: null,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    fixReason: null,
    mergeAttemptCount: 0,
    staleSessionRetryCount: 0,
    doneAt: null,
    projectName: null,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

function seedInvocationWithBudgetEvent(
  db: OrcaDb,
  taskId: string,
  invStatus: "completed" | "failed",
  costUsd: number,
): void {
  const invId = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    endedAt: now(),
    status: invStatus,
    sessionId: null,
    branchName: null,
    worktreePath: null,
    costUsd,
    numTurns: 5,
    outputSummary: null,
    logPath: null,
    phase: "implement",
    model: "claude-sonnet-4-6",
  });
  insertBudgetEvent(db, {
    invocationId: invId,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    recordedAt: now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("countZeroCostFailuresSince — real DB query", () => {
  let db: OrcaDb;
  let windowStart: string;

  beforeEach(() => {
    db = freshDb();
    windowStart = budgetWindowStart(4); // 4-hour window
  });

  test("does NOT count $0 budget events from SUCCESSFUL (completed) invocations", () => {
    const taskId = seedTask(db);

    // 5 completed (success) invocations that happen to cost $0
    for (let i = 0; i < 5; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "completed", 0);
    }

    const count = countZeroCostFailuresSince(db, windowStart);

    // Correctly returns 0 — no failed invocations, so circuit breaker does not trip.
    expect(count).toBe(0);
  });

  test("counts $0 budget events from FAILED invocations (expected behavior)", () => {
    const taskId = seedTask(db);

    // 3 failed invocations at $0 cost (actual failures)
    for (let i = 0; i < 3; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "failed", 0);
    }

    const count = countZeroCostFailuresSince(db, windowStart);
    expect(count).toBe(3);
  });

  test("distinguishes between failed and completed — only counts failed", () => {
    const taskId = seedTask(db);

    // 2 completed (success), 3 failed
    for (let i = 0; i < 2; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "completed", 0);
    }
    for (let i = 0; i < 3; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "failed", 0);
    }

    const count = countZeroCostFailuresSince(db, windowStart);

    // Returns 3 — only failed invocations are counted.
    expect(count).toBe(3);
  });

  test("non-zero cost events are NOT counted", () => {
    const taskId = seedTask(db);

    // 10 successful invocations with real cost
    for (let i = 0; i < 10; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "completed", 0.05);
    }
    // 10 failed invocations with real cost
    for (let i = 0; i < 10; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "failed", 0.01);
    }

    const count = countZeroCostFailuresSince(db, windowStart);
    // Non-zero cost events are correctly excluded
    expect(count).toBe(0);
  });

  test("events outside the window are excluded", () => {
    const taskId = seedTask(db);

    // Insert a $0 event with a timestamp 5 hours ago (outside 4h window)
    const oldTimestamp = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: oldTimestamp,
      endedAt: oldTimestamp,
      status: "failed",
      sessionId: null,
      branchName: null,
      worktreePath: null,
      costUsd: 0,
      numTurns: 1,
      outputSummary: null,
      logPath: null,
      phase: "implement",
      model: "claude-sonnet-4-6",
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      recordedAt: oldTimestamp, // outside the window
    });

    const count = countZeroCostFailuresSince(db, windowStart);
    // Correctly excluded by time window
    expect(count).toBe(0);
  });

  test("fresh system with zero events returns 0", () => {
    const count = countZeroCostFailuresSince(db, windowStart);
    expect(count).toBe(0);
  });

  test("5 review sessions at $0 cost (all successful) do NOT trip the circuit breaker", () => {
    // Realistic scenario: 5 quick review sessions that complete at $0 cost.
    // These are perfectly healthy sessions — the reviewer exited quickly.
    // The circuit breaker must NOT fire for successful sessions.
    const taskId = seedTask(db);

    for (let i = 0; i < 5; i++) {
      seedInvocationWithBudgetEvent(db, taskId, "completed", 0);
    }

    const count = countZeroCostFailuresSince(db, windowStart);

    // count = 0 — no failures, so circuit breaker stays off.
    expect(count).toBe(0);
  });
});
