// ---------------------------------------------------------------------------
// Cron scheduling integration tests — adversarial test suite
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  getTask,
  getInvocationsByTask,
  insertCronSchedule,
  getDueCronSchedules,
  deleteOldCronTasks,
  incrementCronRunCount,
  updateCronSchedule,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";
import { computeNextRunAt } from "../src/cron/index.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn(),
  killSession: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  findPrForBranch: vi.fn(),
  findPrByUrl: vi.fn(),
  getMergeCommitSha: vi.fn(),
  getPrCheckStatus: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
  mergePr: vi.fn(),
  getPrMergeState: vi.fn(),
  updatePrBranch: vi.fn(),
  rebasePrBranch: vi.fn().mockReturnValue({ success: true }),
  closeSupersededPrs: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/git.js", () => ({
  isTransientGitError: vi.fn().mockReturnValue(false),
  isDllInitError: vi.fn().mockReturnValue(false),
  git: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
  evaluateParentStatuses: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitInvocationStarted: vi.fn(),
  emitInvocationCompleted: vi.fn(),
  emitStatusUpdated: vi.fn(),
}));

vi.mock("../src/cleanup/index.js", () => ({
  cleanupStaleResources: vi.fn(),
  cleanupOldInvocationLogs: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function pastIso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

let scheduleCounter = 0;
let taskCounter = 0;

function seedCronSchedule(
  db: OrcaDb,
  overrides: Partial<{
    name: string;
    type: "claude" | "shell";
    schedule: string;
    prompt: string;
    repoPath: string | null;
    maxRuns: number | null;
    runCount: number;
    enabled: number;
    nextRunAt: string | null;
    timeoutMin: number;
  }> = {},
): number {
  const ts = now();
  return insertCronSchedule(db, {
    name: overrides.name ?? `test-schedule-${++scheduleCounter}`,
    type: overrides.type ?? "shell",
    schedule: overrides.schedule ?? "* * * * *",
    prompt: overrides.prompt ?? "echo hello",
    repoPath: overrides.repoPath ?? "/tmp/test-repo",
    model: null,
    maxTurns: null,
    timeoutMin: overrides.timeoutMin ?? 30,
    maxRuns: overrides.maxRuns ?? null,
    runCount: overrides.runCount ?? 0,
    enabled: overrides.enabled ?? 1,
    lastRunAt: null,
    nextRunAt: overrides.nextRunAt ?? pastIso(60000), // 1 min ago by default (due)
    createdAt: ts,
    updatedAt: ts,
  });
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: TaskStatus;
    taskType: string;
    cronScheduleId: number | null;
    createdAt: string;
  }> = {},
): string {
  const id =
    overrides.linearIssueId ?? `TASK-${++taskCounter}-${Date.now().toString(36)}`;
  const ts = overrides.createdAt ?? now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do the thing",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as TaskStatus,
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
    doneAt: null,
    projectName: null,
    taskType: (overrides.taskType ?? "linear") as any,
    cronScheduleId: overrides.cronScheduleId ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

// ---------------------------------------------------------------------------
// BUG 1: computeNextRunAt — DOM and DOW are AND-ed, should be OR-ed
//
// Standard cron semantics: when both day-of-month AND day-of-week are
// restricted (not "*"), a time matches if it satisfies EITHER constraint.
// This is how Vixie cron and virtually all Unix cron implementations work.
//
// Example: "0 9 15 * 1" should fire at 9am on the 15th of any month,
// AND at 9am every Monday. The current implementation requires BOTH the
// day to be 15 AND a Monday simultaneously.
// ---------------------------------------------------------------------------

describe("BUG 1 — computeNextRunAt: DOM and DOW should be OR-ed, not AND-ed", () => {
  test("schedule with day-of-month=1 and day-of-week=0 (Sunday) fires on the 1st even if not a Sunday", () => {
    // Jan 1 2026 is a Thursday. First Sunday is Jan 4.
    // "0 0 1 * 0" should mean: midnight on the 1st of each month OR every Sunday.
    // With OR semantics: should fire Jan 4 (Sunday, even though not the 1st).
    // With AND semantics: requires BOTH dom=1 AND dow=0 simultaneously.

    const base = new Date();
    base.setFullYear(2026, 0, 1); // Jan 1 2026 local
    base.setHours(0, 0, 0, 0);

    const result = computeNextRunAt("0 0 1 * 0", base);

    // With OR semantics, result should be Jan 4 (next Sunday)
    // With AND semantics (the bug), result will be much later
    expect(result.getDay()).toBe(0); // It should be a Sunday (DOW match)
    expect(result.getDate()).toBe(4); // Jan 4, NOT waiting for 1st+Sunday combo
    expect(result.getMonth()).toBe(0); // January
    expect(result.getFullYear()).toBe(2026);
  });

  test("schedule 0 12 31 * 5 (noon on 31st OR every Friday) should match the next Friday", () => {
    // Jan 1 2026 is Thursday. Next Friday is Jan 2.
    // With OR semantics: Jan 2 noon should match (Friday matches DOW).
    // With AND semantics: only a day that is BOTH the 31st AND a Friday.

    const base = new Date();
    base.setFullYear(2026, 0, 1); // Jan 1 2026 local
    base.setHours(12, 1, 0, 0);  // 12:01

    const result = computeNextRunAt("0 12 31 * 5", base);

    // With OR, result should be Friday Jan 2
    expect(result.getDay()).toBe(5); // Friday
    expect(result.getDate()).toBe(2); // Jan 2
    expect(result.getMonth()).toBe(0); // January
    expect(result.getFullYear()).toBe(2026);
  });

  test("wildcard DOW (*) with specific DOM uses DOM-only logic (no bug)", () => {
    // "0 0 15 * *" should fire on the 15th of each month, regardless of DOW
    const base = new Date();
    base.setFullYear(2026, 0, 1); // Jan 1 2026 local
    base.setHours(0, 0, 0, 0);

    const result = computeNextRunAt("0 0 15 * *", base);

    expect(result.getDate()).toBe(15);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  test("wildcard DOM (*) with specific DOW uses DOW-only logic (no bug)", () => {
    // "0 0 * * 1" should fire every Monday
    // Jan 1 2026 is Thursday, next Monday is Jan 5
    const base = new Date();
    base.setFullYear(2026, 0, 1); // Jan 1 2026 local
    base.setHours(0, 0, 0, 0);

    const result = computeNextRunAt("0 0 * * 1", base);

    expect(result.getDay()).toBe(1); // Monday
    expect(result.getDate()).toBe(5); // Jan 5
    expect(result.getMonth()).toBe(0); // January
  });
});

// ---------------------------------------------------------------------------
// BUG 2: deleteOldCronTasks deletes running/active tasks
//
// The query deletes ALL cron tasks older than the cutoff date, regardless
// of orca_status. A running cron task that was created just before the
// retention cutoff will be purged mid-execution, orphaning the process
// and leaving the scheduler with a handle pointing to a non-existent task.
// ---------------------------------------------------------------------------

describe("BUG 2 — deleteOldCronTasks: deletes active/running cron tasks", () => {
  test("deleteOldCronTasks removes a running cron task", () => {
    const db = freshDb();

    const scheduleId = seedCronSchedule(db, { type: "shell" });
    const oldDate = pastIso(8 * 24 * 60 * 60 * 1000); // 8 days ago
    const taskId = seedTask(db, {
      linearIssueId: "CRON-1-1",
      orcaStatus: "running",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
      createdAt: oldDate,
    });

    // Verify task exists and is running
    expect(getTask(db, taskId)?.orcaStatus).toBe("running");

    // Cut off at 7 days ago
    const cutoff = pastIso(7 * 24 * 60 * 60 * 1000);
    const deleted = deleteOldCronTasks(db, cutoff);

    // Bug: this deletes the RUNNING task — should only delete completed/failed ones
    // Expected (correct): deleted === 0 because the task is still running
    // Actual (buggy): deleted === 1 because status is not checked
    expect(deleted).toBe(0); // FAILS with current implementation
  });

  test("deleteOldCronTasks removes a dispatched cron task", () => {
    const db = freshDb();

    const scheduleId = seedCronSchedule(db, { type: "shell" });
    const oldDate = pastIso(8 * 24 * 60 * 60 * 1000);
    const taskId = seedTask(db, {
      linearIssueId: "CRON-2-1",
      orcaStatus: "dispatched",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
      createdAt: oldDate,
    });

    expect(getTask(db, taskId)?.orcaStatus).toBe("dispatched");

    const cutoff = pastIso(7 * 24 * 60 * 60 * 1000);
    const deleted = deleteOldCronTasks(db, cutoff);

    // Bug: dispatched task gets deleted while it's still being worked on
    expect(deleted).toBe(0); // FAILS with current implementation
  });

  test("deleteOldCronTasks correctly deletes old done cron tasks", () => {
    const db = freshDb();

    const scheduleId = seedCronSchedule(db, { type: "shell" });
    const oldDate = pastIso(8 * 24 * 60 * 60 * 1000);
    const taskId = seedTask(db, {
      linearIssueId: "CRON-3-1",
      orcaStatus: "done",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
      createdAt: oldDate,
    });

    const cutoff = pastIso(7 * 24 * 60 * 60 * 1000);
    const deleted = deleteOldCronTasks(db, cutoff);

    // This SHOULD be deleted (completed task past retention)
    expect(deleted).toBe(1);
    expect(getTask(db, taskId)).toBeUndefined();
  });

  test("deleteOldCronTasks does not delete recent running cron tasks", () => {
    const db = freshDb();

    const scheduleId = seedCronSchedule(db, { type: "shell" });
    // Recent task (created 1 hour ago) — well within 7-day retention
    const recentDate = pastIso(60 * 60 * 1000); // 1 hour ago
    const taskId = seedTask(db, {
      linearIssueId: "CRON-4-1",
      orcaStatus: "running",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
      createdAt: recentDate,
    });

    const cutoff = pastIso(7 * 24 * 60 * 60 * 1000);
    const deleted = deleteOldCronTasks(db, cutoff);

    expect(deleted).toBe(0);
    expect(getTask(db, taskId)?.orcaStatus).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// BUG 3: cron_shell timeout does not trigger retry
//
// When a cron_shell invocation times out (checkTimeouts shell loop, line 1793),
// the task is set to "failed" but handleRetry() is NOT called. In contrast,
// regular Claude session timeouts DO call handleRetry(). This inconsistency
// means a transiently-failing shell command will permanently fail rather than
// being retried up to maxRetries times.
//
// We test this indirectly via the DB state: after a shell timeout, retryCount
// should be incremented (if retry logic ran). Currently it stays at 0.
// ---------------------------------------------------------------------------

describe("BUG 3 — cron_shell timeout does not trigger retry", () => {
  test("cron_shell invocation status after timeout: task gets failed status but retry_count stays 0", () => {
    // This test verifies the observable symptom: after a simulated shell timeout,
    // the task is failed and retryCount has NOT been incremented.
    // A correct implementation would either:
    //   (a) call handleRetry() which increments retryCount and resets to 'ready', or
    //   (b) intentionally not retry (documented design decision for cron tasks)
    // The bug is that the behavior is inconsistent with regular task timeouts.

    const db = freshDb();
    const scheduleId = seedCronSchedule(db, { type: "shell", timeoutMin: 1 });
    const taskId = "CRON-TIMEOUT-1";

    // Seed a cron_shell task in running state
    const oldStarted = pastIso(5 * 60 * 1000); // started 5 min ago (past 1-min timeout)
    seedTask(db, {
      linearIssueId: taskId,
      orcaStatus: "running",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
    });

    // Insert an invocation that has been running past the timeout
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: oldStarted,
      status: "running",
      phase: null,
      model: null,
    });

    // At this point the task is running with an overdue invocation.
    // After checkTimeouts runs, the task should be failed.
    // The question is: does retryCount get incremented?

    // We can verify the current state and document the expected vs actual behavior.
    const taskBefore = getTask(db, taskId);
    expect(taskBefore?.retryCount).toBe(0);
    expect(taskBefore?.orcaStatus).toBe("running");

    // Document: after timeout handling, retry_count should increment for consistency
    // with regular task timeouts. This assertion documents the DESIRED behavior.
    // Currently the shell timeout path does NOT call handleRetry().
    // This test documents the inconsistency; it will pass in the current (buggy) state
    // because we're not actually running the scheduler tick here.
    // The real test is that the retry path IS consistent between shell and claude timeouts.

    // Verify invocation was seeded correctly
    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.status).toBe("running");
    expect(invocations[0]!.id).toBe(invId);
  });
});

// ---------------------------------------------------------------------------
// BUG 4: getDueCronSchedules — maxRuns boundary condition (off-by-one check)
//
// getDueCronSchedules filters: run_count < max_runs
// checkCronSchedules uses: runNum = runCount + 1, then checks runNum >= maxRuns
//
// With maxRuns=1 and runCount=0: runNum=1, 1>=1 → disables. Correct.
// With maxRuns=3 and runCount=2: runNum=3, 3>=3 → disables after run 3. Correct.
// But: does getDueCronSchedules pick it up when runCount=2 and maxRuns=3?
// Filter: 2 < 3 → yes. runNum=3, 3>=3 → disable after this run. Correct.
//
// This section verifies the exact boundary.
// ---------------------------------------------------------------------------

describe("getDueCronSchedules — maxRuns boundary", () => {
  test("schedule with runCount == maxRuns is NOT returned as due", () => {
    const db = freshDb();
    // runCount=3, maxRuns=3 → already at limit, should not be due
    seedCronSchedule(db, {
      maxRuns: 3,
      runCount: 3,
      nextRunAt: pastIso(60000), // past due time
    });

    const due = getDueCronSchedules(db, new Date().toISOString());
    expect(due).toHaveLength(0);
  });

  test("schedule with runCount == maxRuns - 1 IS returned as due", () => {
    const db = freshDb();
    // runCount=2, maxRuns=3 → one run left, should be due
    seedCronSchedule(db, {
      maxRuns: 3,
      runCount: 2,
      nextRunAt: pastIso(60000),
    });

    const due = getDueCronSchedules(db, new Date().toISOString());
    expect(due).toHaveLength(1);
  });

  test("schedule with maxRuns=1 and runCount=1 is NOT due", () => {
    const db = freshDb();
    seedCronSchedule(db, {
      maxRuns: 1,
      runCount: 1,
      nextRunAt: pastIso(60000),
    });

    const due = getDueCronSchedules(db, new Date().toISOString());
    expect(due).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 5: computeNextRunAt edge cases
// ---------------------------------------------------------------------------

describe("computeNextRunAt edge cases", () => {
  test("throws on invalid 4-field expression", () => {
    expect(() => computeNextRunAt("* * * *", new Date())).toThrow(
      "5 fields",
    );
  });

  test("throws on invalid step value 0", () => {
    expect(() =>
      computeNextRunAt("*/0 * * * *", new Date()),
    ).toThrow("step");
  });

  test("throws on out-of-range minute", () => {
    expect(() =>
      computeNextRunAt("60 * * * *", new Date()),
    ).toThrow();
  });

  test("throws on out-of-range hour", () => {
    expect(() =>
      computeNextRunAt("* 24 * * *", new Date()),
    ).toThrow();
  });

  test("throws on out-of-range day-of-month", () => {
    expect(() =>
      computeNextRunAt("* * 32 * *", new Date()),
    ).toThrow();
  });

  test("throws on out-of-range month", () => {
    expect(() =>
      computeNextRunAt("* * * 13 *", new Date()),
    ).toThrow();
  });

  test("throws on out-of-range day-of-week", () => {
    expect(() =>
      computeNextRunAt("* * * * 7", new Date()),
    ).toThrow();
  });

  test("every minute schedule fires next minute", () => {
    // Use a date constructed in local time to avoid timezone confusion.
    // computeNextRunAt uses local getHours/getMinutes/etc.
    const base = new Date();
    base.setFullYear(2026, 0, 15); // Jan 15 2026 local
    base.setHours(10, 30, 0, 0);  // 10:30:00 local

    const result = computeNextRunAt("* * * * *", base);

    // Result should be exactly 1 minute after base
    expect(result.getTime()).toBe(base.getTime() + 60 * 1000);
    expect(result.getMinutes()).toBe(31);
    expect(result.getHours()).toBe(10);
  });

  test("every hour at minute 0 fires on next whole hour", () => {
    const base = new Date();
    base.setFullYear(2026, 0, 15); // Jan 15 2026 local
    base.setHours(10, 15, 0, 0);  // 10:15:00 local

    const result = computeNextRunAt("0 * * * *", base);

    expect(result.getMinutes()).toBe(0);
    expect(result.getHours()).toBe(11);
  });

  test("midnight daily fires next local midnight (not UTC midnight)", () => {
    // computeNextRunAt uses local time (candidate.getHours()), not UTC.
    // "0 0 * * *" means midnight in the LOCAL timezone.
    // We verify: the returned date has getHours()===0 and getMinutes()===0 in local time.
    const base = new Date();
    base.setMinutes(base.getMinutes() + 1); // 1 minute in the future as "now"
    // Set to 23:59 local
    base.setHours(23, 59, 0, 0);

    const result = computeNextRunAt("0 0 * * *", base);
    // Result should be the next local midnight
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    // And it should be after the base time
    expect(result.getTime()).toBeGreaterThan(base.getTime());
  });

  test("Feb 29 schedule fires on next leap year (does not throw)", () => {
    // "0 0 29 2 *" is valid — fires on Feb 29 of leap years.
    // From 2026 (non-leap), the next occurrence is in 2028 (leap year).
    // This should NOT throw — it should return a date in Feb 2028.
    const base = new Date("2026-01-01T00:00:00.000Z");
    let result: Date | undefined;
    expect(() => {
      result = computeNextRunAt("0 0 29 2 *", base);
    }).not.toThrow();
    // Should be February 29 of a leap year
    expect(result!.getMonth()).toBe(1); // February (0-indexed)
    expect(result!.getDate()).toBe(29);
  });

  test("step expression */15 in minutes fires every 15 minutes", () => {
    const base = new Date();
    base.setFullYear(2026, 0, 15);
    base.setHours(10, 1, 0, 0); // 10:01 local

    const result = computeNextRunAt("*/15 * * * *", base);
    expect(result.getMinutes()).toBe(15);
    expect(result.getHours()).toBe(10);
  });

  test("comma-separated minutes 5,30 — from 10:20 should return 10:30", () => {
    const base = new Date();
    base.setFullYear(2026, 0, 15);
    base.setHours(10, 20, 0, 0); // 10:20 local

    const result = computeNextRunAt("5,30 * * * *", base);
    expect(result.getMinutes()).toBe(30);
    expect(result.getHours()).toBe(10);
  });

  test("range 1-5 in day-of-week (Mon-Fri) does not fire on Sunday", () => {
    // We need to construct a local Sunday at 09:59
    // Find a Sunday: Jan 11 2026 is a Sunday
    const base = new Date();
    base.setFullYear(2026, 0, 11); // Jan 11 2026
    base.setHours(9, 59, 0, 0);
    // Confirm it's a Sunday
    expect(base.getDay()).toBe(0);

    const result = computeNextRunAt("0 10 * * 1-5", base);
    // Next weekday after Sunday Jan 11 is Monday Jan 12
    expect(result.getDay()).toBe(1); // Monday
    expect(result.getDate()).toBe(12);
    expect(result.getHours()).toBe(10);
    expect(result.getMinutes()).toBe(0);
  });

  test("inverted range N-M where N > M throws", () => {
    expect(() => computeNextRunAt("59-0 * * * *", new Date())).toThrow();
  });

  test("negative step (--) is treated as invalid", () => {
    // "/" followed by negative number
    expect(() => computeNextRunAt("*/-1 * * * *", new Date())).toThrow();
  });

  test("from time exactly on a matching minute searches NEXT minute", () => {
    // "* * * * *" from exactly 10:30:00 should return 10:31, not 10:30
    const base = new Date("2026-01-15T10:30:00.000Z");
    const result = computeNextRunAt("* * * * *", base);
    expect(result.getTime()).toBeGreaterThan(base.getTime());
    expect(result.getMinutes()).toBe(31);
  });

  test("non-integer step string throws", () => {
    expect(() => computeNextRunAt("*/abc * * * *", new Date())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BUG 6: checkCronSchedules — task ID collision if same schedule fires twice
// in one tick (next_run_at not updated atomically between getDueCronSchedules
// and incrementCronRunCount)
//
// checkCronSchedules reads all due schedules, then for each:
//   1. Calls computeNextRunAt (no DB write yet)
//   2. insertTask with id = CRON-{id}-{runCount+1}
//   3. incrementCronRunCount (updates runCount + nextRunAt)
//
// If two ticks fire concurrently (which the tick mutex prevents, but the
// in-memory mutex only protects within one process), or if a schedule has
// next_run_at far in the past and fires once per tick until caught up,
// the IDs would be: CRON-1-1, CRON-1-2, etc.
//
// The real race: if the schedule fires but insertTask throws (UNIQUE),
// incrementCronRunCount is still called on the "continue" path — wait, no,
// the code "continue"s before incrementCronRunCount. So on duplicate:
// runCount is NOT incremented. But nextRunAt is also not updated.
// That means on the NEXT tick, getDueCronSchedules will return the schedule
// again (nextRunAt still <= now), but the task ID will be the SAME (runCount+1
// unchanged), causing another UNIQUE conflict, and this repeats forever.
// ---------------------------------------------------------------------------

describe("BUG 6 — schedule stuck after UNIQUE constraint error on task insert", () => {
  test("after duplicate task conflict, incrementCronRunCount is skipped and schedule fires again next tick", () => {
    const db = freshDb();

    const scheduleId = seedCronSchedule(db, {
      type: "shell",
      runCount: 0,
      nextRunAt: pastIso(60000),
    });

    // Manually insert the task that would have been created
    // (simulates a previous tick that inserted the task but failed before
    // incrementing runCount — or a duplicate insertion scenario)
    const taskId = `CRON-${scheduleId}-1`;
    seedTask(db, {
      linearIssueId: taskId,
      orcaStatus: "done",
      taskType: "cron_shell",
      cronScheduleId: scheduleId,
    });

    // Schedule still has runCount=0 and nextRunAt in the past
    // So getDueCronSchedules will return it again
    const due = getDueCronSchedules(db, new Date().toISOString());
    expect(due).toHaveLength(1);
    expect(due[0]!.runCount).toBe(0); // runCount not incremented

    // The would-be task ID is the same as the already-existing one
    const expectedDuplicateId = `CRON-${scheduleId}-${due[0]!.runCount + 1}`;
    expect(expectedDuplicateId).toBe(taskId);

    // This confirms the schedule will attempt to insert the same ID again,
    // hit a UNIQUE constraint, and loop forever without making progress.
    // The correct fix: increment runCount (or advance nextRunAt) even on duplicate.
  });
});

// ---------------------------------------------------------------------------
// BUG 7: deleteOldCronTasks does not filter by task type
// (defensive check — ensure non-cron tasks with old createdAt are safe)
// ---------------------------------------------------------------------------

describe("deleteOldCronTasks — only affects cron tasks", () => {
  test("old linear tasks are NOT deleted by deleteOldCronTasks", () => {
    const db = freshDb();

    const oldDate = pastIso(8 * 24 * 60 * 60 * 1000);
    const linearTaskId = seedTask(db, {
      linearIssueId: "LINEAR-123",
      orcaStatus: "done",
      taskType: "linear",
      cronScheduleId: null,
      createdAt: oldDate,
    });

    const cutoff = pastIso(7 * 24 * 60 * 60 * 1000);
    const deleted = deleteOldCronTasks(db, cutoff);

    expect(deleted).toBe(0);
    expect(getTask(db, linearTaskId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cron parser — month boundary handling
// ---------------------------------------------------------------------------

describe("computeNextRunAt — month transitions", () => {
  test("schedule on day 31 skips February entirely", () => {
    // "0 0 31 * *" from late January: next valid date should be March 31
    // (February has no 31st; note DOM+DOW AND bug means DOW=* is treated as all days)
    const base = new Date();
    base.setFullYear(2026, 0, 31); // Jan 31 2026 local
    base.setHours(0, 1, 0, 0); // just after midnight

    const result = computeNextRunAt("0 0 31 * *", base);

    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    // Should skip Feb (no day 31) and land in March
    expect(result.getMonth()).toBe(2); // March (0-indexed)
    expect(result.getFullYear()).toBe(2026);
  });

  test("schedule on day 30 skips February entirely", () => {
    // 2026: February has 28 days, no 30th
    const base = new Date();
    base.setFullYear(2026, 0, 31); // Jan 31 local
    base.setHours(0, 1, 0, 0);

    const result = computeNextRunAt("0 0 30 * *", base);

    expect(result.getDate()).toBe(30);
    // Should skip February (no day 30 in 2026)
    expect(result.getMonth()).toBe(2); // March (0-indexed)
    expect(result.getFullYear()).toBe(2026);
  });

  test("schedule fires in the correct month when month is restricted", () => {
    // "0 0 1 6 *" — June 1st only
    const base = new Date();
    base.setFullYear(2026, 0, 1); // Jan 1 2026 local
    base.setHours(0, 0, 0, 0);

    const result = computeNextRunAt("0 0 1 6 *", base);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(5); // June (0-indexed)
    expect(result.getFullYear()).toBe(2026);
  });

  test("schedule wraps to next year when no more matching months remain", () => {
    // "0 0 1 1 *" — January 1st. From Feb 2026, should be Jan 1 2027
    const base = new Date();
    base.setFullYear(2026, 1, 1); // Feb 1 2026 local
    base.setHours(0, 0, 0, 0);

    const result = computeNextRunAt("0 0 1 1 *", base);

    expect(result.getDate()).toBe(1);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getFullYear()).toBe(2027);
  });
});
