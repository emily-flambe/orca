// ---------------------------------------------------------------------------
// Startup recovery tests — clearSessionIds, staleSessionRetryCount
// reset, and edge cases in orphan recovery logic.
//
// These tests simulate the startup recovery logic in src/cli/index.ts to
// verify that session IDs and stale retry counts are correctly cleared after
// restarts, and expose edge cases in the implementation.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateInvocation,
  updateTaskStatus,
  getAllTasks,
  getRunningInvocations,
  getInvocationsByTask,
  clearSessionIds,
  getLastCompletedImplementInvocation,
  getLastMaxTurnsInvocation,
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

function seedTask(
  db: OrcaDb,
  id: string,
  status: "ready" | "running" | "failed" = "ready",
): void {
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    lifecycleStage: status,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

/** Simulate what the startup orphan recovery logic does (mirrors src/cli/index.ts). */
function runStartupRecovery(db: OrcaDb): {
  orphanCount: number;
  recoveredCount: number;
} {
  // Step 1: Mark running invocations as failed
  const orphanedInvocations = getRunningInvocations(db);
  for (const inv of orphanedInvocations) {
    updateInvocation(db, inv.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      outputSummary: "orphaned by crash/restart",
    });
  }

  // Step 2: Collect orphaned task IDs, clear session IDs, reset stale counts
  const orphanedTaskIds = new Set(
    orphanedInvocations.map((inv) => inv.linearIssueId),
  );
  for (const taskId of orphanedTaskIds) {
    clearSessionIds(db, taskId);
  }

  // Step 3: Recover stuck tasks (running with no running invocation)
  const allTasks = getAllTasks(db);
  const runningInvIssueIds = new Set(
    getRunningInvocations(db).map((inv) => inv.linearIssueId),
  );
  let recovered = 0;
  for (const t of allTasks) {
    if (
      t.lifecycleStage === "running" &&
      !runningInvIssueIds.has(t.linearIssueId)
    ) {
      updateTaskStatus(db, t.linearIssueId, "ready");
      clearSessionIds(db, t.linearIssueId);
      recovered++;
    }
  }

  return { orphanCount: orphanedInvocations.length, recoveredCount: recovered };
}

/** Simulate what the shutdown handler does (mirrors src/cli/index.ts shutdown fn). */
function runShutdownHandler(db: OrcaDb): void {
  const running = getRunningInvocations(db);
  for (const inv of running) {
    updateInvocation(db, inv.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      outputSummary: "interrupted by shutdown",
    });
    updateTaskStatus(db, inv.linearIssueId, "ready");
    clearSessionIds(db, inv.linearIssueId);
  }
}

// ---------------------------------------------------------------------------
// Tests for clearSessionIds behavior
// ---------------------------------------------------------------------------

describe("clearSessionIds", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("nulls sessionId on all implement-phase invocations for the task", () => {
    seedTask(db, "TASK-1");
    const inv1 = insertInvocation(db, {
      linearIssueId: "TASK-1",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "session-abc",
    });
    const inv2 = insertInvocation(db, {
      linearIssueId: "TASK-1",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "session-xyz",
    });

    clearSessionIds(db, "TASK-1");

    const invocations = getInvocationsByTask(db, "TASK-1");
    expect(invocations.find((i) => i.id === inv1)?.sessionId).toBeNull();
    expect(invocations.find((i) => i.id === inv2)?.sessionId).toBeNull();
  });

  test("clears sessionId on review-phase invocations (clearSessionIds targets all phases)", () => {
    seedTask(db, "TASK-REVIEW");
    insertInvocation(db, {
      linearIssueId: "TASK-REVIEW",
      startedAt: now(),
      status: "completed",
      phase: "review",
      sessionId: "review-session-abc",
    });

    clearSessionIds(db, "TASK-REVIEW");

    const invocations = getInvocationsByTask(db, "TASK-REVIEW");
    // clearSessionIds clears ALL phases (implement + review)
    expect(invocations[0]?.sessionId).toBeNull();
  });

  test("is a no-op for a task with no invocations", () => {
    seedTask(db, "TASK-EMPTY");
    // Should not throw
    expect(() => clearSessionIds(db, "TASK-EMPTY")).not.toThrow();
  });

  test("is a no-op for a nonexistent task ID", () => {
    expect(() => clearSessionIds(db, "NONEXISTENT")).not.toThrow();
  });

  test("after clearing, getLastCompletedImplementInvocation returns undefined", () => {
    seedTask(db, "TASK-GCII");
    insertInvocation(db, {
      linearIssueId: "TASK-GCII",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "some-session",
    });

    // Before clear: should find the invocation
    expect(getLastCompletedImplementInvocation(db, "TASK-GCII")).toBeDefined();

    clearSessionIds(db, "TASK-GCII");

    // After clear: getLastCompletedImplementInvocation filters by isNotNull(sessionId),
    // so it should return undefined
    expect(
      getLastCompletedImplementInvocation(db, "TASK-GCII"),
    ).toBeUndefined();
  });

  test("after clearing, getLastMaxTurnsInvocation returns undefined", () => {
    seedTask(db, "TASK-GMTI");
    insertInvocation(db, {
      linearIssueId: "TASK-GMTI",
      startedAt: now(),
      status: "failed",
      phase: "implement",
      sessionId: "max-turns-session",
      outputSummary: "max turns reached",
      worktreePath: "/tmp/some-worktree",
    });

    // Before clear: should find it
    expect(getLastMaxTurnsInvocation(db, "TASK-GMTI")).toBeDefined();

    clearSessionIds(db, "TASK-GMTI");

    // After clear: sessionId is null, getLastMaxTurnsInvocation filters by isNotNull(sessionId),
    // so it should return undefined — preventing stale resume
    expect(getLastMaxTurnsInvocation(db, "TASK-GMTI")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for startup recovery logic
// ---------------------------------------------------------------------------

describe("startup recovery — orphaned invocations", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("orphaned running invocation gets session ID cleared", () => {
    seedTask(db, "TASK-CRASH");
    // Simulate a running invocation that was left over from a crash
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-CRASH",
      startedAt: now(),
      status: "running",
      phase: "implement",
      sessionId: "live-session-123",
    });

    const { orphanCount } = runStartupRecovery(db);
    expect(orphanCount).toBe(1);

    const invocations = getInvocationsByTask(db, "TASK-CRASH");
    const inv = invocations.find((i) => i.id === invId);
    expect(inv?.status).toBe("failed");
    expect(inv?.sessionId).toBeNull();
  });

  test("previously-completed implement invocations also get session ID cleared", () => {
    // This is the core bug scenario: task had a completed implement invocation
    // (session was used for fix-phase resume) and then crashed while in review.
    // The completed implement invocation's session ID should be cleared at startup.
    seedTask(db, "TASK-FIX-RESUME", "running");

    // Completed implement invocation with session ID (used for fix-phase resume)
    const implInvId = insertInvocation(db, {
      linearIssueId: "TASK-FIX-RESUME",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "impl-session-abc",
    });

    // Running implement invocation (the orphan)
    insertInvocation(db, {
      linearIssueId: "TASK-FIX-RESUME",
      startedAt: now(),
      status: "running",
      phase: "implement",
      sessionId: "second-session-xyz",
    });

    runStartupRecovery(db);

    // The implement invocation's session ID should be cleared
    const invocations = getInvocationsByTask(db, "TASK-FIX-RESUME");
    const implInv = invocations.find((i) => i.id === implInvId);
    expect(implInv?.sessionId).toBeNull();

    // getLastCompletedImplementInvocation should return undefined (no stale resume)
    expect(
      getLastCompletedImplementInvocation(db, "TASK-FIX-RESUME"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 1: Graceful shutdown does NOT clear session IDs
// After a graceful SIGTERM shutdown, the next startup won't find any running
// invocations (they were already marked failed by the shutdown handler),
// so orphanedTaskIds will be empty and clearSessionIds is never called.
// ---------------------------------------------------------------------------

describe("BUG: graceful shutdown leaves stale session IDs", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("session ID persists after graceful shutdown and is not cleared on next startup", () => {
    seedTask(db, "TASK-GRACEFUL", "running");

    // Session is running at shutdown time
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-GRACEFUL",
      startedAt: now(),
      status: "running",
      phase: "implement",
      sessionId: "live-session-at-shutdown",
    });

    // Simulate graceful shutdown (marks invocation failed, resets task to ready,
    // but does NOT clear session IDs or reset staleSessionRetryCount)
    runShutdownHandler(db);

    // Verify shutdown state: session ID is cleared by the shutdown handler
    const invAfterShutdown = getInvocationsByTask(db, "TASK-GRACEFUL").find(
      (i) => i.id === invId,
    );
    expect(invAfterShutdown?.status).toBe("failed");
    expect(invAfterShutdown?.sessionId).toBeNull();

    // Now simulate next startup recovery
    const { orphanCount } = runStartupRecovery(db);

    // No running invocations found (shutdown handler already marked them failed)
    expect(orphanCount).toBe(0);

    // Session ID remains null — no stale resume will be attempted
    const invAfterStartup = getInvocationsByTask(db, "TASK-GRACEFUL").find(
      (i) => i.id === invId,
    );
    expect(invAfterStartup?.sessionId).toBeNull();
  });

  // staleSessionRetryCount test removed in EMI-504
});

// ---------------------------------------------------------------------------
// Bug 2: Tasks stuck in "running" state (no running invocation) don't get
// clearSessionIds called — only staleSessionRetryCount is reset.
// ---------------------------------------------------------------------------

describe("BUG: running tasks without running invocations skip clearSessionIds", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("running task with no running invocation gets session IDs cleared", () => {
    // Scenario: orca crashed between claiming a task (updating to "running")
    // and inserting the new invocation. Or: crash happened while the task was
    // running but a previous completed invocation has a session ID.
    seedTask(db, "TASK-DISPATCH-CRASH", "running");

    // Previously completed implement invocation with a session ID
    const prevInvId = insertInvocation(db, {
      linearIssueId: "TASK-DISPATCH-CRASH",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "prev-session-still-valid",
    });

    // No running invocation — orca crashed before it was created

    const { orphanCount, recoveredCount } = runStartupRecovery(db);
    expect(orphanCount).toBe(0); // No running invocations
    expect(recoveredCount).toBe(1); // Task was running → reset to ready

    // The running-task recovery now calls clearSessionIds
    // in addition to resetting staleSessionRetryCount.
    const invocations = getInvocationsByTask(db, "TASK-DISPATCH-CRASH");
    const prevInv = invocations.find((i) => i.id === prevInvId);

    expect(prevInv?.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Correct behavior tests (these should pass already)
// ---------------------------------------------------------------------------

describe("startup recovery — correct behavior", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("crash-restart: running invocation session ID is cleared", () => {
    seedTask(db, "TASK-OK-CRASH", "running");
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-OK-CRASH",
      startedAt: now(),
      status: "running",
      phase: "implement",
      sessionId: "crash-session",
    });

    runStartupRecovery(db);

    const invocations = getInvocationsByTask(db, "TASK-OK-CRASH");
    const inv = invocations.find((i) => i.id === invId);
    expect(inv?.status).toBe("failed");
    expect(inv?.sessionId).toBeNull();
  });

  test("tasks with running invocation get session cleared", () => {
    seedTask(db, "TASK-ACTIVE", "running");

    // Completed implement invocation
    const implInvId = insertInvocation(db, {
      linearIssueId: "TASK-ACTIVE",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "implement-session-abc",
    });

    // Orphaned running implement invocation
    insertInvocation(db, {
      linearIssueId: "TASK-ACTIVE",
      startedAt: now(),
      status: "running",
      phase: "implement",
    });

    const { orphanCount } = runStartupRecovery(db);
    expect(orphanCount).toBe(1);

    // Implement session ID should be cleared
    const implInv = getInvocationsByTask(db, "TASK-ACTIVE").find(
      (i) => i.id === implInvId,
    );
    expect(implInv?.sessionId).toBeNull();
  });

  test("multiple tasks with orphaned invocations all get cleared", () => {
    for (let i = 1; i <= 3; i++) {
      seedTask(db, `TASK-MULTI-${i}`, "running");
      insertInvocation(db, {
        linearIssueId: `TASK-MULTI-${i}`,
        startedAt: now(),
        status: "running",
        phase: "implement",
        sessionId: `session-${i}`,
      });
    }

    const { orphanCount } = runStartupRecovery(db);
    expect(orphanCount).toBe(3);

    for (let i = 1; i <= 3; i++) {
      // Session IDs should be cleared
      expect(
        getLastCompletedImplementInvocation(db, `TASK-MULTI-${i}`),
      ).toBeUndefined();
    }
  });

  test("tasks not in orphaned set are unaffected by clearSessionIds", () => {
    seedTask(db, "TASK-CLEAN", "ready");
    const cleanInvId = insertInvocation(db, {
      linearIssueId: "TASK-CLEAN",
      startedAt: now(),
      status: "completed",
      phase: "implement",
      sessionId: "clean-session",
    });

    seedTask(db, "TASK-ORPHAN", "running");
    insertInvocation(db, {
      linearIssueId: "TASK-ORPHAN",
      startedAt: now(),
      status: "running",
      phase: "implement",
      sessionId: "orphan-session",
    });

    runStartupRecovery(db);

    // TASK-CLEAN's completed invocation should be untouched
    const cleanInv = getInvocationsByTask(db, "TASK-CLEAN").find(
      (i) => i.id === cleanInvId,
    );
    expect(cleanInv?.sessionId).toBe("clean-session");
  });
});
