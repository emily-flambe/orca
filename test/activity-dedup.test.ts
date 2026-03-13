// ---------------------------------------------------------------------------
// Adversarial tests for getRecentActivity deduplication logic
// Testing edge cases the implementer likely missed
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateTaskStatus,
  getRecentActivity,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Helpers (duplicated from db.test.ts to keep tests self-contained)
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let counter = 0;
function makeTaskId(): string {
  return `ACT-${++counter}`;
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    orcaStatus: TaskStatus;
    retryCount: number;
  }> = {},
): string {
  const ts = now();
  const id = overrides.linearIssueId ?? makeTaskId();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "implement the feature",
    repoPath: "/tmp/repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: 0,
    retryCount: overrides.retryCount ?? 0,
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
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function seedInvocation(
  db: OrcaDb,
  taskId: string,
  overrides: Partial<{
    status: "running" | "completed" | "failed" | "timed_out";
    phase: "implement" | "review" | null;
  }> = {},
): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    endedAt: null,
    status: overrides.status ?? "running",
    sessionId: null,
    branchName: null,
    worktreePath: null,
    costUsd: null,
    numTurns: null,
    outputSummary: null,
    logPath: null,
    phase: overrides.phase ?? "implement",
    model: "claude-sonnet-4-6",
  });
}

// ---------------------------------------------------------------------------
// BUG 1: Deduplication — ticket with multiple invocations must appear once
// ---------------------------------------------------------------------------

describe("getRecentActivity — deduplication (one row per ticket)", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("ticket with multiple invocations appears exactly once", () => {
    // This is the core acceptance criterion: one row per Linear ticket.
    // The existing test only checks ordering, not actual deduplication count.
    const t = seedTask(db);
    seedInvocation(db, t, { status: "failed" });
    seedInvocation(db, t, { status: "failed" });
    seedInvocation(db, t, { status: "running" }); // latest

    const activity = getRecentActivity(db);
    // Should be 1 row, not 3
    expect(activity).toHaveLength(1);
  });

  test("latest invocation id is chosen when multiple exist", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "failed" });
    seedInvocation(db, t, { status: "failed" });
    const latestId = seedInvocation(db, t, { status: "running" });

    const [entry] = getRecentActivity(db);
    expect(entry!.id).toBe(latestId);
  });

  test("limit counts unique tickets, not invocations", () => {
    // 3 tickets, 2 invocations each = 6 total rows without dedup
    // limit=2 should return exactly 2 tickets, not 2 invocations
    const t1 = seedTask(db);
    seedInvocation(db, t1, { status: "failed" });
    seedInvocation(db, t1, { status: "completed" });

    const t2 = seedTask(db);
    seedInvocation(db, t2, { status: "failed" });
    seedInvocation(db, t2, { status: "running" });

    const t3 = seedTask(db);
    seedInvocation(db, t3, { status: "completed" });
    seedInvocation(db, t3, { status: "completed" });

    const activity = getRecentActivity(db, 2);
    expect(activity).toHaveLength(2);
    // Ensure each linearIssueId is unique
    const ids = activity.map((e) => e.linearIssueId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: timed_out invocations from a non-failed task should show as "retrying"
// ---------------------------------------------------------------------------

describe("getRecentActivity — timed_out should show as retrying when task is alive", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("timed_out latest invocation with task status=ready shows as retrying, not timed_out", () => {
    // Scenario: task timed out, was reset to "ready" for retry
    // Expected: show "retrying" (task is still alive, just timed out temporarily)
    // Actual: the CASE expression only maps invocations.status='failed' to 'retrying'
    //         timed_out falls through to ELSE and returns raw "timed_out"
    const t = seedTask(db, { orcaStatus: "ready" });
    seedInvocation(db, t, { status: "timed_out" });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    // A timed_out invocation whose task is still alive (ready) should show as retrying
    expect(entry!.status).toBe("retrying");
  });

  test("timed_out latest invocation with task status=failed shows as failed", () => {
    // Task permanently failed after timeout — should show failed, not timed_out
    const t = seedTask(db, { orcaStatus: "failed" });
    seedInvocation(db, t, { status: "timed_out" });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// BUG 3: Orphaned invocation (task deleted from tasks table)
// The leftJoin means tasks.orcaStatus is NULL.
// CASE: "WHEN invocations.status = 'failed' AND tasks.orcaStatus != 'failed'"
// In SQL, NULL != 'failed' evaluates to NULL (not TRUE), so the AND short-circuits.
// A failed orphaned invocation hits ELSE and returns raw "failed" — happens to be
// acceptable, but the 'retrying' branch silently fails for this case.
// ---------------------------------------------------------------------------

describe("getRecentActivity — orphaned invocations (no matching task row)", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("orphaned failed invocation still appears in activity feed with status=failed", () => {
    // Insert invocation directly bypassing FK by using a task that then gets deleted.
    // We can't actually delete the task while the FK constraint holds in better-sqlite3,
    // but we can verify the query handles null task rows correctly if they existed.
    // Instead, test with a task that has orcaStatus=null which can't happen via schema
    // but simulates orphan behavior.

    // Practical test: a failed invocation whose task has orcaStatus != 'failed'
    // should show 'retrying', not 'failed'.
    const t = seedTask(db, { orcaStatus: "ready" }); // task is alive (was reset)
    seedInvocation(db, t, { status: "failed" });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    // Task is still alive (status=ready), so this failed invocation should be "retrying"
    expect(entry!.status).toBe("retrying");
  });

  test("failed invocation where task orcaStatus is dispatched (mid-retry) shows retrying", () => {
    // Task failed, was reset to dispatched for another attempt
    const t = seedTask(db, { orcaStatus: "dispatched" });
    seedInvocation(db, t, { status: "failed" });

    const [entry] = getRecentActivity(db);
    expect(entry!.status).toBe("retrying");
  });
});

// ---------------------------------------------------------------------------
// BUG 4: Permanently failed task with timed_out invocation
// tasks.orcaStatus = 'failed', invocations.status = 'timed_out'
// The CASE first checks tasks.orcaStatus = 'failed' → returns 'failed'. Correct.
// But verify the correct WHEN fires, not ELSE.
// ---------------------------------------------------------------------------

describe("getRecentActivity — permanently failed task with timed_out invocation", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("permanently failed task with timed_out invocation shows as failed", () => {
    const t = seedTask(db, { orcaStatus: "failed" });
    seedInvocation(db, t, { status: "timed_out" });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
  });

  test("permanently failed task with completed invocation (unusual) shows as failed", () => {
    // Edge case: task orca_status=failed but latest invocation is completed
    // (e.g., completed but gate 2 failed, retries exhausted, marked failed)
    // tasks.orcaStatus='failed' is checked first, so result should be 'failed'
    const t = seedTask(db, { orcaStatus: "failed" });
    seedInvocation(db, t, { status: "completed" });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    // The CASE first checks tasks.orcaStatus='failed' so this should return 'failed'
    // not 'completed'
    expect(entry!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// BUG 5: Ordering — most recent invocation across ALL tickets, not just per-ticket
// ---------------------------------------------------------------------------

describe("getRecentActivity — global ordering by most recent invocation id", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("tickets ordered by their latest invocation id descending", () => {
    const t1 = seedTask(db);
    const inv1 = seedInvocation(db, t1, { status: "completed" }); // id=1

    const t2 = seedTask(db);
    const inv2 = seedInvocation(db, t2, { status: "running" }); // id=2

    const t3 = seedTask(db);
    const inv3 = seedInvocation(db, t3, { status: "completed" }); // id=3

    // Add another invocation to t1 — making t1's latest id=4 (highest)
    const inv4 = seedInvocation(db, t1, { status: "running" }); // id=4

    const activity = getRecentActivity(db);
    expect(activity).toHaveLength(3);
    // t1 has latest id=4, t3 has id=3, t2 has id=2
    expect(activity[0]!.linearIssueId).toBe(t1.valueOf());
    expect(activity[0]!.id).toBe(inv4);
    expect(activity[1]!.linearIssueId).toBe(t3.valueOf());
    expect(activity[2]!.linearIssueId).toBe(t2.valueOf());
  });
});

// ---------------------------------------------------------------------------
// BUG 6: running status — should pass through unchanged regardless of task status
// ---------------------------------------------------------------------------

describe("getRecentActivity — running invocations", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("running invocation with task orcaStatus=running shows as running", () => {
    const t = seedTask(db, { orcaStatus: "running" });
    seedInvocation(db, t, { status: "running" });

    const [entry] = getRecentActivity(db);
    expect(entry!.status).toBe("running");
  });

  test("running invocation with task orcaStatus=dispatched shows as running", () => {
    // Task is dispatched, invocation is running — should still show running
    const t = seedTask(db, { orcaStatus: "dispatched" });
    seedInvocation(db, t, { status: "running" });

    const [entry] = getRecentActivity(db);
    // CASE checks tasks.orcaStatus='failed' first (no), then invocations.status='running' → 'running'
    expect(entry!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// BUG 7: Empty DB edge case
// ---------------------------------------------------------------------------

describe("getRecentActivity — empty database", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("returns empty array when no invocations", () => {
    expect(getRecentActivity(db)).toEqual([]);
  });

  test("returns empty array with explicit limit when no invocations", () => {
    expect(getRecentActivity(db, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG 8: Task with in_review orcaStatus and latest invocation=completed
// Should show 'completed' (the review completed, task moved to in_review)
// ---------------------------------------------------------------------------

describe("getRecentActivity — in_review task state", () => {
  let db: OrcaDb;
  beforeEach(() => {
    db = freshDb();
  });

  test("completed invocation with task in in_review shows as completed", () => {
    const t = seedTask(db, { orcaStatus: "in_review" });
    seedInvocation(db, t, { status: "completed", phase: "implement" });

    const [entry] = getRecentActivity(db);
    expect(entry!.status).toBe("completed");
  });

  test("failed review invocation where task is changes_requested shows as retrying", () => {
    // Review phase failed (unusual) but task is still alive
    const t = seedTask(db, { orcaStatus: "changes_requested" });
    seedInvocation(db, t, { status: "failed", phase: "review" });

    const [entry] = getRecentActivity(db);
    // Task is not permanently failed (orcaStatus != 'failed')
    // So this should show 'retrying'
    expect(entry!.status).toBe("retrying");
  });
});
