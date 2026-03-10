// ---------------------------------------------------------------------------
// deploy-interrupt-resume.test.ts
//
// Adversarial tests for the deploy-interrupt worktree preservation feature.
// These tests are written to expose bugs in the implementation.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateInvocation,
  getLastDeployInterruptedInvocation,
  getInvocationsByTask,
  clearImplementSessionIds,
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

let counter = 0;
function makeTaskId(): string {
  return `DEPLTEST-${++counter}`;
}

function seedTask(db: OrcaDb, id?: string): string {
  const taskId = id ?? makeTaskId();
  const ts = now();
  insertTask(db, {
    linearIssueId: taskId,
    agentPrompt: "implement the feature",
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
    createdAt: ts,
    updatedAt: ts,
  });
  return taskId;
}

function seedDeployInterruptedInvocation(
  db: OrcaDb,
  taskId: string,
  overrides: Partial<{
    worktreePath: string | null;
    branchName: string | null;
    sessionId: string | null;
    worktreePreserved: number;
    outputSummary: string | null;
    phase: "implement" | "review";
  }> = {},
): number {
  const id = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    endedAt: now(),
    status: "failed",
    sessionId: overrides.sessionId ?? "sess-abc123",
    branchName: overrides.branchName ?? "orca/DEPLTEST-1/42",
    worktreePath: overrides.worktreePath ?? "/tmp/worktrees/repo-DEPLTEST-1",
    costUsd: 0.05,
    numTurns: 10,
    outputSummary: overrides.outputSummary ?? "interrupted_by_deploy",
    logPath: "logs/42.ndjson",
    phase: overrides.phase ?? "implement",
    model: "claude-sonnet-4-6",
  });
  // Set worktreePreserved (insertInvocation doesn't expose this field)
  if (overrides.worktreePreserved !== undefined) {
    updateInvocation(db, id, {
      worktreePreserved: overrides.worktreePreserved,
    });
  } else {
    updateInvocation(db, id, { worktreePreserved: 1 });
  }
  return id;
}

// ---------------------------------------------------------------------------
// BUG 1: getLastDeployInterruptedInvocation does NOT filter by task ID
// correctly when multiple tasks exist.
//
// The query should ONLY return invocations for the specific taskId argument.
// If it leaks cross-task data it is a correctness bug.
// ---------------------------------------------------------------------------

describe("getLastDeployInterruptedInvocation — task ID isolation", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("does not return deploy-interrupted invocations from a DIFFERENT task", () => {
    const taskA = seedTask(db, "TASK-A");
    const taskB = seedTask(db, "TASK-B");

    // Only task A has a deploy-interrupted invocation
    seedDeployInterruptedInvocation(db, taskA, {
      worktreePath: "/tmp/worktrees/repo-TASK-A",
    });

    // Querying for task B should return undefined
    const result = getLastDeployInterruptedInvocation(db, taskB);
    expect(result).toBeUndefined();
  });

  test("returns the invocation for the correct task when both tasks have one", () => {
    const taskA = seedTask(db, "TASK-AA");
    const taskB = seedTask(db, "TASK-BB");

    seedDeployInterruptedInvocation(db, taskA, {
      worktreePath: "/tmp/worktrees/repo-TASK-AA",
    });
    seedDeployInterruptedInvocation(db, taskB, {
      worktreePath: "/tmp/worktrees/repo-TASK-BB",
    });

    const resultA = getLastDeployInterruptedInvocation(db, taskA);
    const resultB = getLastDeployInterruptedInvocation(db, taskB);

    expect(resultA?.worktreePath).toBe("/tmp/worktrees/repo-TASK-AA");
    expect(resultB?.worktreePath).toBe("/tmp/worktrees/repo-TASK-BB");
  });
});

// ---------------------------------------------------------------------------
// BUG 2: getLastDeployInterruptedInvocation returns stale invocations
// from OLD deploys where worktreePreserved=1 was never cleared.
//
// After the new instance resumes from a deploy-interrupted worktree, the
// worktreePreserved flag on the old invocation is never reset to 0.
// On a SECOND deploy interruption, the query will correctly return the most
// recent interrupted invocation. BUT if the task completes successfully after
// the first resume and then gets re-queued (e.g., for a fix), it will still
// pick up the OLD preserved worktree (which no longer exists on disk).
//
// The scheduler guards against this by calling existsSync(), but the query
// itself has no mechanism to mark a preserved worktree as "consumed".
// The real bug is that there is no state transition to clear worktreePreserved
// after a successful worktree reuse, meaning the system relies entirely on
// existsSync() for correctness — a fragile disk-based guard.
// ---------------------------------------------------------------------------

describe("getLastDeployInterruptedInvocation — stale worktree not cleared after reuse", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("still returns old deploy-interrupted invocation after task has new completed invocation", () => {
    const taskId = seedTask(db);

    // Simulate old deploy-interrupted invocation (already resumed once)
    const oldInterruptedId = seedDeployInterruptedInvocation(db, taskId, {
      worktreePath: "/tmp/worktrees/repo-OLD",
      branchName: "orca/DEPLTEST/1",
    });

    // Simulate new successful invocation AFTER the resume (task completed implement)
    const successId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      endedAt: now(),
      status: "completed",
      sessionId: "sess-newone",
      branchName: "orca/DEPLTEST/1",
      worktreePath: "/tmp/worktrees/repo-OLD", // same worktree was reused
      costUsd: 0.1,
      numTurns: 25,
      outputSummary: "success",
      logPath: "logs/2.ndjson",
      phase: "implement",
      model: "claude-sonnet-4-6",
    });

    // Even though the task was completed, the OLD invocation still has worktreePreserved=1
    // getLastDeployInterruptedInvocation will STILL return it on the next dispatch
    // (e.g., if the task is re-queued for a fix after review)
    const result = getLastDeployInterruptedInvocation(db, taskId);

    // This SHOULD be undefined (the worktree was already used), but the
    // implementation never clears worktreePreserved after reuse.
    // This test proves the stale state persists — the result is non-null
    // even though the worktree was already consumed by the resume dispatch.
    expect(result).toBeDefined();
    expect(result!.id).toBe(oldInterruptedId);
    // The old preserved invocation is still returned — worktreePreserved was never cleared.
    // This is the bug: the fix phase could try to reuse a worktree that was already consumed.
  });
});

// ---------------------------------------------------------------------------
// BUG 3: getLastDeployInterruptedInvocation does NOT filter on invocation
// status — it will return a "failed" invocation that was NOT interrupted by
// a deploy but happens to have outputSummary="interrupted_by_deploy" due to
// data corruption or manual DB editing. More importantly, it means any
// invocation manually given this outputSummary would be picked up.
//
// This is a defense-in-depth concern, but the primary structural bug is that
// the query has NO check that status='failed' (even though it should always be
// 'failed' when worktreePreserved=1 — it could theoretically be 'timed_out').
// ---------------------------------------------------------------------------

describe("getLastDeployInterruptedInvocation — no status filter", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns timed_out invocation with interrupted_by_deploy summary (no status filter)", () => {
    const taskId = seedTask(db);

    // Create a timed_out invocation with the magic outputSummary string
    // (edge case: what if a timeout races with the shutdown handler?)
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      endedAt: now(),
      status: "timed_out",
      sessionId: "sess-timedout",
      branchName: "orca/DEPLTEST/99",
      worktreePath: "/tmp/worktrees/repo-TIMEDOUT",
      costUsd: 0.05,
      numTurns: 100,
      outputSummary: "interrupted_by_deploy",
      logPath: "logs/99.ndjson",
      phase: "implement",
      model: "claude-sonnet-4-6",
    });
    updateInvocation(db, invId, { worktreePreserved: 1 });

    // The query should NOT return timed_out invocations — only status=failed ones.
    const result = getLastDeployInterruptedInvocation(db, taskId);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG 4: The shutdown handler in cli/index.ts calls clearImplementSessionIds()
// for ALL running invocations — including deploy-interrupted ones.
//
// This test proves that after calling clearImplementSessionIds(), the
// invocation that was marked as deploy-interrupted still has its sessionId
// cleared, which (while not fatal for the worktree resume path which uses
// worktreePath/branchName) demonstrates that the function's blanket application
// is broader than intended.
//
// More importantly: what if the shutdown handler is called BEFORE the
// worktreePreserved flag is set? The current code structure is:
//   1. updateInvocation(..., { worktreePreserved: 1 })
//   2. clearImplementSessionIds(...)   <-- clears sessionId from this SAME invocation
//
// The deploy-interrupted invocation has its sessionId cleared immediately,
// meaning the invocation record shows worktreePreserved=1 but sessionId=null.
// getLastDeployInterruptedInvocation does NOT require sessionId to be set, so
// this is technically OK for the worktree path. But it's inconsistent with the
// analogous max-turns invocation which REQUIRES sessionId to be non-null.
// ---------------------------------------------------------------------------

describe("clearImplementSessionIds blanket clears deploy-interrupted invocations", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("clearImplementSessionIds clears sessionId from deploy-interrupted invocation", () => {
    const taskId = seedTask(db);

    const invId = seedDeployInterruptedInvocation(db, taskId, {
      sessionId: "sess-deploy-123",
      worktreePath: "/tmp/worktrees/repo-DEPLOY",
    });

    // Verify sessionId is set before clearing
    const before = getInvocationsByTask(db, taskId).find(
      (i) => i.id === invId,
    )!;
    expect(before.sessionId).toBe("sess-deploy-123");
    expect(before.worktreePreserved).toBe(1);

    // Simulate what shutdown handler does after preserving worktree
    clearImplementSessionIds(db, taskId);

    // After clearing, sessionId is null but worktreePreserved=1 is intact
    const after = getInvocationsByTask(db, taskId).find((i) => i.id === invId)!;
    expect(after.sessionId).toBeNull();
    // worktreePreserved is still 1 — so the query can still find it
    expect(after.worktreePreserved).toBe(1);
    // outputSummary is still correct
    expect(after.outputSummary).toBe("interrupted_by_deploy");

    // The deploy-interrupted invocation is still findable — this is OK for
    // worktree resume. But the session cannot be resumed (sessionId is null).
    // This means a deploy-interrupted task loses its Claude session context
    // entirely, which may not be intended — the worktree is preserved but
    // the conversation history is gone.
    const found = getLastDeployInterruptedInvocation(db, taskId);
    expect(found).toBeDefined();
    expect(found!.sessionId).toBeNull(); // session is GONE even though worktree is preserved
  });
});

// ---------------------------------------------------------------------------
// BUG 5: A review or fix phase session running during drain is NOT preserved.
//
// The shutdown handler at cli/index.ts line 361 only preserves the worktree
// for `phase === "implement"` sessions. Review/fix sessions during drain are
// cleaned up normally. This means if a review session was running when the
// drain happened, it will be lost and the task will restart from scratch.
//
// This is a design limitation, but it is worth documenting: the deploy
// interruption ONLY benefits implement-phase sessions, not review sessions.
// Tasks in "in_review" or "changes_requested" that were running during drain
// will have their sessions killed and worktrees removed, forcing a full restart.
// ---------------------------------------------------------------------------

describe("shutdown handler — review phase sessions are NOT preserved during drain", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("review-phase invocation during drain gets worktreePreserved=0 (not preserved)", () => {
    const taskId = seedTask(db);

    // Simulate a review-phase invocation that was running during drain
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      endedAt: null,
      status: "running",
      sessionId: "sess-review",
      branchName: "orca/DEPLTEST/5",
      worktreePath: "/tmp/worktrees/repo-REVIEW",
      costUsd: null,
      numTurns: null,
      outputSummary: null,
      logPath: "logs/5.ndjson",
      phase: "review",
      model: "claude-haiku",
    });

    // Simulate what the shutdown handler does for a draining review session:
    // it goes to the else branch (not implement phase) and removes the worktree
    updateInvocation(db, invId, {
      status: "failed",
      endedAt: now(),
      outputSummary: "interrupted by shutdown",
      // worktreePreserved stays 0 (default)
    });

    // Review-phase invocation has worktreePreserved=0 — not preserved
    const inv = getInvocationsByTask(db, taskId).find((i) => i.id === invId)!;
    expect(inv.worktreePreserved).toBe(0);
    expect(inv.outputSummary).toBe("interrupted by shutdown");

    // getLastDeployInterruptedInvocation will NOT find this review-phase inv
    // (filtered out by phase=implement), confirming review sessions are not resumable.
    const result = getLastDeployInterruptedInvocation(db, taskId);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG 6: getLastDeployInterruptedInvocation can pick up an invocation from
// a PREVIOUS deploy cycle that was NEVER resumed (e.g., because the worktree
// was already deleted by the OS or a cleanup process), even after the task
// has been re-dispatched and completed successfully.
//
// Scenario:
//   Deploy 1: task interrupted, worktree preserved → worktreePreserved=1
//   New instance: worktree MISSING on disk (e.g., OS cleaned /tmp)
//   Scheduler logs "deploy-interrupted worktree is missing" and does fresh dispatch
//   Task completes successfully
//   Deploy 2: task interrupted again → NEW invocation with worktreePreserved=1
//   Scheduler finds BOTH old and new interrupted invocations
//
// The query correctly returns the MOST RECENT one (orderBy desc id),
// so the new one wins. This is actually correct behavior. BUT the old stale
// invocation with worktreePreserved=1 remains in DB indefinitely — polluting
// queries and potentially causing confusion.
// ---------------------------------------------------------------------------

describe("getLastDeployInterruptedInvocation — picks most recent when multiple exist", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns the MOST RECENT deploy-interrupted invocation, not the oldest", () => {
    const taskId = seedTask(db);

    // Older deploy-interrupted invocation (worktree no longer exists)
    const oldId = seedDeployInterruptedInvocation(db, taskId, {
      worktreePath: "/tmp/worktrees/repo-OLD-DEPLOY1",
    });

    // Newer deploy-interrupted invocation (from a second deploy cycle)
    const newId = seedDeployInterruptedInvocation(db, taskId, {
      worktreePath: "/tmp/worktrees/repo-NEW-DEPLOY2",
    });

    const result = getLastDeployInterruptedInvocation(db, taskId);
    expect(result).toBeDefined();
    // Should return the NEWER invocation
    expect(result!.id).toBe(newId);
    expect(result!.worktreePath).toBe("/tmp/worktrees/repo-NEW-DEPLOY2");
    // NOT the older one
    expect(result!.id).not.toBe(oldId);
  });
});

// ---------------------------------------------------------------------------
// BUG 7: The `fix` phase stored in invocations uses phase="implement"
// (because fix dispatches use phase="implement" with an existing branch).
// This means if a REVIEW or FIX invocation happens to be interrupted
// (shouldn't happen — drain blocks new impl dispatch), the phase filter
// in getLastDeployInterruptedInvocation won't help.
//
// Separate issue: the phase enum in schema.ts ONLY allows "implement"|"review",
// but the dispatch logic uses phase="implement" for fix-phase sessions too.
// If the fix phase is ever changed to use phase="fix", the getLastDeployInterrupted
// query's phase filter of "implement" would inadvertently exclude fix-phase sessions.
// ---------------------------------------------------------------------------

describe("schema — phase enum does not include fix", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("invocation schema only accepts implement and review as phase values", () => {
    const taskId = seedTask(db);

    // This should work — "implement" is valid
    expect(() => {
      insertInvocation(db, {
        linearIssueId: taskId,
        startedAt: now(),
        endedAt: null,
        status: "running",
        sessionId: null,
        branchName: null,
        worktreePath: null,
        costUsd: null,
        numTurns: null,
        outputSummary: null,
        logPath: null,
        phase: "implement",
        model: "claude-sonnet-4-6",
      });
    }).not.toThrow();

    // The schema has no "fix" phase — fix sessions are stored as "implement"
    // This is confirmed by scheduler/index.ts line 2299:
    //   "fix phase uses implement with existing branch"
    // If this assumption ever changes, getLastDeployInterruptedInvocation's
    // phase filter would need updating too.
    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations[0]!.phase).toBe("implement");
  });
});

// ---------------------------------------------------------------------------
// BUG 8: The migration 11 sentinel checks invocations.worktree_preserved,
// but the CREATE_INVOCATIONS statement already includes worktree_preserved.
// On a FRESH database, worktree_preserved is created inline in CREATE_INVOCATIONS.
// On an OLD database, migration 11 adds it via ALTER TABLE.
//
// The migration sentinel is `!hasColumn(sqlite, 'invocations', 'worktree_preserved')`.
// This is CORRECT for an existing DB. But what if someone runs the migration
// on a DB where the column exists with a DIFFERENT default? The migration
// unconditionally adds NOT NULL DEFAULT 0 — SQLite ALTER TABLE ADD COLUMN
// will set existing rows to 0, which is the correct behavior.
//
// However: what happens if a future migration (e.g., migration 12) uses the
// same sentinel number? The numbering is sequential and there are no checks
// for duplicate migration numbers. This is a latent conflict risk.
// ---------------------------------------------------------------------------

describe("migration 11 — worktree_preserved column added correctly", () => {
  test("fresh in-memory db has worktree_preserved column with default 0", () => {
    const db = freshDb();
    const taskId = "MIGR-TEST-1";
    const ts = now();
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: "test",
      repoPath: "/tmp",
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
      createdAt: ts,
      updatedAt: ts,
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: ts,
      endedAt: null,
      status: "running",
      sessionId: null,
      branchName: null,
      worktreePath: null,
      costUsd: null,
      numTurns: null,
      outputSummary: null,
      logPath: null,
      phase: "implement",
      model: "claude-sonnet-4-6",
    });

    const invs = getInvocationsByTask(db, taskId);
    expect(invs).toHaveLength(1);
    // worktreePreserved should default to 0
    expect(invs[0]!.worktreePreserved).toBe(0);
  });

  test("updateInvocation can set worktreePreserved to 1", () => {
    const db = freshDb();
    const taskId = "MIGR-TEST-2";
    const ts = now();
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: "test",
      repoPath: "/tmp",
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
      createdAt: ts,
      updatedAt: ts,
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: ts,
      endedAt: null,
      status: "running",
      sessionId: null,
      branchName: null,
      worktreePath: null,
      costUsd: null,
      numTurns: null,
      outputSummary: null,
      logPath: null,
      phase: "implement",
      model: "claude-sonnet-4-6",
    });

    updateInvocation(db, invId, {
      status: "failed",
      endedAt: ts,
      outputSummary: "interrupted_by_deploy",
      worktreePreserved: 1,
    });

    const invs = getInvocationsByTask(db, taskId);
    expect(invs[0]!.worktreePreserved).toBe(1);
    expect(invs[0]!.outputSummary).toBe("interrupted_by_deploy");
  });
});

// ---------------------------------------------------------------------------
// BUG 9 (CRITICAL): After the new instance starts and dispatches the
// deploy-resumed task, the scheduler NEVER clears worktreePreserved=1 on the
// OLD invocation. This means on EVERY subsequent dispatch of this task
// (including review dispatches, fix dispatches, etc.), getLastDeployInterrupted
// Invocation() will STILL return the old interrupted invocation.
//
// The scheduler's dispatch logic at lines 243-261 of scheduler/index.ts checks
// `resumeWorktreePath == null` before calling getLastDeployInterrupted, so it
// only applies to fresh implement phases. But IF the worktree was consumed
// (isDeployResume=true path was taken), on the NEXT implement dispatch for this
// task, existsSync() is the ONLY guard preventing it from trying to reuse the
// old (now-consumed) worktree again.
//
// If the worktree directory still exists on disk (e.g., cleanup hasn't run yet),
// existsSync() returns true and the scheduler will try to reuse an already-used
// worktree — potentially causing git errors or data corruption.
// ---------------------------------------------------------------------------

describe("CRITICAL: worktreePreserved never cleared after worktree reuse", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("after a deploy-resume dispatch, old invocation still has worktreePreserved=1", () => {
    const taskId = seedTask(db);

    // Simulate: deploy interrupted, worktree preserved
    const interruptedId = seedDeployInterruptedInvocation(db, taskId, {
      worktreePath: "/tmp/worktrees/repo-TASK",
      branchName: "orca/TASK/1",
    });

    // Verify preserved
    const beforeResume = getInvocationsByTask(db, taskId).find(
      (i) => i.id === interruptedId,
    )!;
    expect(beforeResume.worktreePreserved).toBe(1);

    // Simulate: new instance creates a new invocation and REUSES the worktree
    // (the scheduler's isDeployResume path at scheduler/index.ts lines 328-335)
    // The new invocation record:
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      endedAt: null,
      status: "running",
      sessionId: "sess-new",
      branchName: "orca/TASK/1", // same branch, reused worktree
      worktreePath: "/tmp/worktrees/repo-TASK", // SAME worktree path
      costUsd: null,
      numTurns: null,
      outputSummary: null,
      logPath: "logs/resume.ndjson",
      phase: "implement",
      model: "claude-sonnet-4-6",
    });

    // At this point, the OLD invocation STILL has worktreePreserved=1
    // The scheduler never clears it after reuse.
    const afterResume = getInvocationsByTask(db, taskId).find(
      (i) => i.id === interruptedId,
    )!;
    expect(afterResume.worktreePreserved).toBe(1); // BUG: should be 0 after reuse

    // On the NEXT implement dispatch (e.g., after task was reset to ready),
    // getLastDeployInterruptedInvocation will STILL return the old invocation.
    const staleResult = getLastDeployInterruptedInvocation(db, taskId);
    expect(staleResult).toBeDefined();
    expect(staleResult!.id).toBe(interruptedId); // old invocation returned again!
    // The only guard is existsSync(prevInv.worktreePath) in the scheduler.
    // If the worktree directory still exists, it will be reused a SECOND TIME.
  });
});
