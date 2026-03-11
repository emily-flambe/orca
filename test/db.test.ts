// ---------------------------------------------------------------------------
// DB query tests — all exported query functions against in-memory SQLite
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  // Task queries
  insertTask,
  updateTaskStatus,
  incrementRetryCount,
  getDispatchableTasks,
  updateTaskPrBranch,
  updateTaskFixReason,
  incrementMergeAttemptCount,
  incrementStaleSessionRetryCount,
  incrementReviewCycleCount,
  getDeployingTasks,
  getAwaitingCiTasks,
  updateTaskCiInfo,
  updateTaskDeployInfo,
  getTask,
  getAllTasks,
  getChildTasks,
  getParentTasks,
  deleteTask,
  updateTaskFields,
  // Invocation queries
  getInvocation,
  countActiveSessions,
  insertInvocation,
  updateInvocation,
  getInvocationsByTask,
  getLastCompletedImplementInvocation,
  getLastMaxTurnsInvocation,
  getRunningInvocations,
  // Budget queries
  insertBudgetEvent,
  budgetWindowStart,
  sumTokensInWindow,
  sumTokensInWindowRange,
  // Metrics queries
  getInvocationStats,
  getRecentErrors,
  getDailyStats,
  getRecentActivity,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

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
  return `TEST-${++counter}`;
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: TaskStatus;
    priority: number;
    retryCount: number;
    prBranchName: string | null;
    reviewCycleCount: number;
    isParent: number;
    parentIdentifier: string | null;
    mergeCommitSha: string | null;
    prNumber: number | null;
    deployStartedAt: string | null;
    ciStartedAt: string | null;
    fixReason: string | null;
    mergeAttemptCount: number;
    staleSessionRetryCount: number;
    doneAt: string | null;
    projectName: string | null;
    createdAt: string;
    updatedAt: string;
  }> = {},
): string {
  const ts = now();
  const id = overrides.linearIssueId ?? makeTaskId();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "implement the feature",
    repoPath: overrides.repoPath ?? "/tmp/repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    prBranchName: overrides.prBranchName ?? null,
    reviewCycleCount: overrides.reviewCycleCount ?? 0,
    isParent: overrides.isParent ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    mergeCommitSha: overrides.mergeCommitSha ?? null,
    prNumber: overrides.prNumber ?? null,
    deployStartedAt: overrides.deployStartedAt ?? null,
    ciStartedAt: overrides.ciStartedAt ?? null,
    fixReason: overrides.fixReason ?? null,
    mergeAttemptCount: overrides.mergeAttemptCount ?? 0,
    staleSessionRetryCount: overrides.staleSessionRetryCount ?? 0,
    doneAt: overrides.doneAt ?? null,
    projectName: overrides.projectName ?? null,
    createdAt: overrides.createdAt ?? ts,
    updatedAt: overrides.updatedAt ?? ts,
  });
  return id;
}

function seedInvocation(
  db: OrcaDb,
  taskId: string,
  overrides: Partial<{
    startedAt: string;
    endedAt: string | null;
    status: "running" | "completed" | "failed" | "timed_out";
    sessionId: string | null;
    branchName: string | null;
    worktreePath: string | null;
    costUsd: number | null;
    numTurns: number | null;
    outputSummary: string | null;
    logPath: string | null;
    phase: "implement" | "review" | null;
    model: string | null;
  }> = {},
): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: overrides.startedAt ?? now(),
    endedAt: overrides.endedAt ?? null,
    status: overrides.status ?? "running",
    sessionId: overrides.sessionId ?? null,
    branchName: overrides.branchName ?? null,
    worktreePath: overrides.worktreePath ?? null,
    costUsd: overrides.costUsd ?? null,
    numTurns: overrides.numTurns ?? null,
    outputSummary: overrides.outputSummary ?? null,
    logPath: overrides.logPath ?? null,
    phase: overrides.phase ?? "implement",
    model: overrides.model ?? "claude-sonnet-4-6",
  });
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

describe("insertTask / getTask", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("inserted task is retrievable with all fields", () => {
    const ts = now();
    const id = seedTask(db, {
      linearIssueId: "IT-1",
      agentPrompt: "do work",
      repoPath: "/repos/foo",
      orcaStatus: "ready",
      priority: 2,
      retryCount: 1,
      prBranchName: "feat/it-1",
      reviewCycleCount: 1,
      isParent: 0,
      parentIdentifier: null,
      mergeCommitSha: "abc123",
      prNumber: 42,
      deployStartedAt: ts,
      ciStartedAt: ts,
      fixReason: "broke something",
      mergeAttemptCount: 1,
      staleSessionRetryCount: 0,
      doneAt: null,
      projectName: "my-project",
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, id);
    expect(task).toBeDefined();
    expect(task!.linearIssueId).toBe("IT-1");
    expect(task!.agentPrompt).toBe("do work");
    expect(task!.repoPath).toBe("/repos/foo");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.priority).toBe(2);
    expect(task!.retryCount).toBe(1);
    expect(task!.prBranchName).toBe("feat/it-1");
    expect(task!.reviewCycleCount).toBe(1);
    expect(task!.isParent).toBe(0);
    expect(task!.mergeCommitSha).toBe("abc123");
    expect(task!.prNumber).toBe(42);
    expect(task!.fixReason).toBe("broke something");
    expect(task!.mergeAttemptCount).toBe(1);
    expect(task!.projectName).toBe("my-project");
  });

  test("getTask returns undefined for unknown id", () => {
    expect(getTask(db, "NO-SUCH-ID")).toBeUndefined();
  });
});

describe("getAllTasks", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns all tasks", () => {
    expect(getAllTasks(db)).toHaveLength(0);
    seedTask(db);
    seedTask(db);
    expect(getAllTasks(db)).toHaveLength(2);
  });
});

describe("updateTaskStatus", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("updates orcaStatus", () => {
    const id = seedTask(db, { orcaStatus: "ready" });
    updateTaskStatus(db, id, "running");
    expect(getTask(db, id)!.orcaStatus).toBe("running");
  });

  test("sets doneAt when status becomes done", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    const before = Date.now();
    updateTaskStatus(db, id, "done");
    const after = Date.now();
    const task = getTask(db, id)!;
    expect(task.orcaStatus).toBe("done");
    expect(task.doneAt).not.toBeNull();
    const doneAt = new Date(task.doneAt!).getTime();
    expect(doneAt).toBeGreaterThanOrEqual(before);
    expect(doneAt).toBeLessThanOrEqual(after);
  });

  test("clears doneAt when status leaves done", () => {
    const id = seedTask(db, { orcaStatus: "done", doneAt: now() });
    updateTaskStatus(db, id, "ready");
    expect(getTask(db, id)!.doneAt).toBeNull();
  });

  test("updates updatedAt timestamp", () => {
    const ts = "2020-01-01T00:00:00.000Z";
    const id = seedTask(db, { orcaStatus: "ready", createdAt: ts, updatedAt: ts });
    updateTaskStatus(db, id, "running");
    expect(getTask(db, id)!.updatedAt).not.toBe(ts);
  });
});

describe("incrementRetryCount", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("increments retryCount by 1 and resets status to ready", () => {
    const id = seedTask(db, { orcaStatus: "running", retryCount: 2 });
    incrementRetryCount(db, id);
    const task = getTask(db, id)!;
    expect(task.retryCount).toBe(3);
    expect(task.orcaStatus).toBe("ready");
  });

  test("supports custom reset status", () => {
    const id = seedTask(db, { orcaStatus: "running", retryCount: 0 });
    incrementRetryCount(db, id, "failed");
    expect(getTask(db, id)!.orcaStatus).toBe("failed");
  });

  test("clears doneAt", () => {
    const id = seedTask(db, { orcaStatus: "done", doneAt: now() });
    incrementRetryCount(db, id);
    expect(getTask(db, id)!.doneAt).toBeNull();
  });
});

describe("getDispatchableTasks", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns only tasks with matching statuses", () => {
    seedTask(db, { orcaStatus: "ready" });
    seedTask(db, { orcaStatus: "in_review" });
    seedTask(db, { orcaStatus: "done" });

    const dispatchable = getDispatchableTasks(db, ["ready", "in_review"]);
    expect(dispatchable).toHaveLength(2);
    expect(dispatchable.every((t) => ["ready", "in_review"].includes(t.orcaStatus))).toBe(true);
  });

  test("orders by priority ASC then createdAt ASC", () => {
    const ts1 = "2024-01-01T00:00:00.000Z";
    const ts2 = "2024-01-01T01:00:00.000Z";
    const ts3 = "2024-01-01T02:00:00.000Z";
    seedTask(db, { linearIssueId: "D-3", orcaStatus: "ready", priority: 1, createdAt: ts1 });
    seedTask(db, { linearIssueId: "D-1", orcaStatus: "ready", priority: 0, createdAt: ts2 });
    seedTask(db, { linearIssueId: "D-2", orcaStatus: "ready", priority: 0, createdAt: ts3 });

    const tasks = getDispatchableTasks(db, ["ready"]);
    expect(tasks.map((t) => t.linearIssueId)).toEqual(["D-1", "D-2", "D-3"]);
  });

  test("returns empty array when no tasks match", () => {
    seedTask(db, { orcaStatus: "done" });
    expect(getDispatchableTasks(db, ["ready"])).toHaveLength(0);
  });
});

describe("updateTaskPrBranch", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sets prBranchName", () => {
    const id = seedTask(db);
    updateTaskPrBranch(db, id, "orca/feat/1");
    expect(getTask(db, id)!.prBranchName).toBe("orca/feat/1");
  });
});

describe("updateTaskFixReason", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sets fixReason", () => {
    const id = seedTask(db);
    updateTaskFixReason(db, id, "CI failed");
    expect(getTask(db, id)!.fixReason).toBe("CI failed");
  });

  test("clears fixReason with null", () => {
    const id = seedTask(db, { fixReason: "old reason" });
    updateTaskFixReason(db, id, null);
    expect(getTask(db, id)!.fixReason).toBeNull();
  });
});

describe("incrementMergeAttemptCount", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("increments mergeAttemptCount", () => {
    const id = seedTask(db, { mergeAttemptCount: 1 });
    incrementMergeAttemptCount(db, id);
    expect(getTask(db, id)!.mergeAttemptCount).toBe(2);
  });
});

describe("incrementStaleSessionRetryCount", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("increments count and returns new value", () => {
    const id = seedTask(db, { staleSessionRetryCount: 0 });
    const result = incrementStaleSessionRetryCount(db, id);
    expect(result).toBe(1);
    expect(getTask(db, id)!.staleSessionRetryCount).toBe(1);
  });

  test("returns correct count after multiple increments", () => {
    const id = seedTask(db, { staleSessionRetryCount: 2 });
    const result = incrementStaleSessionRetryCount(db, id);
    expect(result).toBe(3);
  });
});

describe("incrementReviewCycleCount", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("increments reviewCycleCount", () => {
    const id = seedTask(db, { reviewCycleCount: 1 });
    incrementReviewCycleCount(db, id);
    expect(getTask(db, id)!.reviewCycleCount).toBe(2);
  });
});

describe("getDeployingTasks / getAwaitingCiTasks", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("getDeployingTasks returns only deploying tasks", () => {
    seedTask(db, { orcaStatus: "deploying" });
    seedTask(db, { orcaStatus: "deploying" });
    seedTask(db, { orcaStatus: "done" });
    expect(getDeployingTasks(db)).toHaveLength(2);
  });

  test("getAwaitingCiTasks returns only awaiting_ci tasks", () => {
    seedTask(db, { orcaStatus: "awaiting_ci" });
    seedTask(db, { orcaStatus: "done" });
    expect(getAwaitingCiTasks(db)).toHaveLength(1);
  });
});

describe("updateTaskCiInfo", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sets ciStartedAt", () => {
    const id = seedTask(db);
    const ts = now();
    updateTaskCiInfo(db, id, { ciStartedAt: ts });
    expect(getTask(db, id)!.ciStartedAt).toBe(ts);
  });

  test("clears ciStartedAt with null", () => {
    const id = seedTask(db, { ciStartedAt: now() });
    updateTaskCiInfo(db, id, { ciStartedAt: null });
    expect(getTask(db, id)!.ciStartedAt).toBeNull();
  });
});

describe("updateTaskDeployInfo", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sets mergeCommitSha, prNumber, deployStartedAt", () => {
    const id = seedTask(db);
    const ts = now();
    updateTaskDeployInfo(db, id, {
      mergeCommitSha: "deadbeef",
      prNumber: 99,
      deployStartedAt: ts,
    });
    const task = getTask(db, id)!;
    expect(task.mergeCommitSha).toBe("deadbeef");
    expect(task.prNumber).toBe(99);
    expect(task.deployStartedAt).toBe(ts);
  });
});

describe("getChildTasks / getParentTasks", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("getChildTasks returns tasks with matching parentIdentifier", () => {
    const parentId = seedTask(db, { linearIssueId: "PARENT-1", isParent: 1 });
    seedTask(db, { linearIssueId: "CHILD-1", parentIdentifier: parentId });
    seedTask(db, { linearIssueId: "CHILD-2", parentIdentifier: parentId });
    seedTask(db, { linearIssueId: "CHILD-3", parentIdentifier: "OTHER-PARENT" });

    const children = getChildTasks(db, parentId);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentIdentifier === parentId)).toBe(true);
  });

  test("getParentTasks returns only tasks with isParent=1", () => {
    seedTask(db, { isParent: 1 });
    seedTask(db, { isParent: 1 });
    seedTask(db, { isParent: 0 });
    expect(getParentTasks(db)).toHaveLength(2);
  });
});

describe("deleteTask", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("deletes task, invocations, and budget events (FK chain)", () => {
    const id = seedTask(db);
    const invId = seedInvocation(db, id, { status: "completed" });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 1.0, inputTokens: 1000, outputTokens: 500, recordedAt: now() });

    deleteTask(db, id);

    expect(getTask(db, id)).toBeUndefined();
    expect(getInvocationsByTask(db, id)).toHaveLength(0);
    // Budget events are also deleted — verify by checking sumTokens returns 0
    expect(sumTokensInWindow(db, new Date(0).toISOString())).toBe(0);
  });

  test("deleting non-existent task is a no-op", () => {
    expect(() => deleteTask(db, "GHOST-99")).not.toThrow();
  });
});

describe("updateTaskFields", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("partially updates task fields", () => {
    const id = seedTask(db, { priority: 0, orcaStatus: "ready" });
    updateTaskFields(db, id, { priority: 3 });
    expect(getTask(db, id)!.priority).toBe(3);
    expect(getTask(db, id)!.orcaStatus).toBe("ready"); // unchanged
  });

  test("sets doneAt when orcaStatus is updated to done", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskFields(db, id, { orcaStatus: "done" });
    expect(getTask(db, id)!.doneAt).not.toBeNull();
  });

  test("clears doneAt when orcaStatus leaves done", () => {
    const id = seedTask(db, { orcaStatus: "done", doneAt: now() });
    updateTaskFields(db, id, { orcaStatus: "failed" });
    expect(getTask(db, id)!.doneAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invocation CRUD
// ---------------------------------------------------------------------------

describe("insertInvocation / getInvocation", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("inserted invocation is retrievable by id", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId, {
      status: "running",
      phase: "implement",
      model: "claude-sonnet-4-6",
    });

    const inv = getInvocation(db, invId);
    expect(inv).toBeDefined();
    expect(inv!.id).toBe(invId);
    expect(inv!.linearIssueId).toBe(taskId);
    expect(inv!.status).toBe("running");
    expect(inv!.phase).toBe("implement");
    expect(inv!.model).toBe("claude-sonnet-4-6");
  });

  test("getInvocation returns undefined for unknown id", () => {
    expect(getInvocation(db, 9999)).toBeUndefined();
  });

  test("returns auto-incremented id", () => {
    const taskId = seedTask(db);
    const id1 = seedInvocation(db, taskId);
    const id2 = seedInvocation(db, taskId);
    expect(id2).toBeGreaterThan(id1);
  });
});

describe("updateInvocation", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("updates status, endedAt, costUsd", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId, { status: "running" });
    const ts = now();
    updateInvocation(db, invId, {
      status: "completed",
      endedAt: ts,
      costUsd: 2.50,
      numTurns: 10,
    });

    const inv = getInvocation(db, invId)!;
    expect(inv.status).toBe("completed");
    expect(inv.endedAt).toBe(ts);
    expect(inv.costUsd).toBeCloseTo(2.50);
    expect(inv.numTurns).toBe(10);
  });

  test("clears sessionId with null", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId, { sessionId: "sess-123" });
    updateInvocation(db, invId, { sessionId: null });
    expect(getInvocation(db, invId)!.sessionId).toBeNull();
  });
});

describe("getInvocationsByTask", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns all invocations for a task", () => {
    const t1 = seedTask(db);
    const t2 = seedTask(db);
    seedInvocation(db, t1);
    seedInvocation(db, t1);
    seedInvocation(db, t2);

    expect(getInvocationsByTask(db, t1)).toHaveLength(2);
    expect(getInvocationsByTask(db, t2)).toHaveLength(1);
  });

  test("returns empty array for task with no invocations", () => {
    const t = seedTask(db);
    expect(getInvocationsByTask(db, t)).toHaveLength(0);
  });
});

describe("countActiveSessions", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("counts only running invocations", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "running" });
    seedInvocation(db, t, { status: "running" });
    seedInvocation(db, t, { status: "completed" });
    seedInvocation(db, t, { status: "failed" });
    expect(countActiveSessions(db)).toBe(2);
  });

  test("returns 0 when no running invocations", () => {
    expect(countActiveSessions(db)).toBe(0);
  });
});

describe("getRunningInvocations", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns only running invocations", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "running" });
    seedInvocation(db, t, { status: "completed" });
    const running = getRunningInvocations(db);
    expect(running).toHaveLength(1);
    expect(running[0]!.status).toBe("running");
  });
});

describe("getLastCompletedImplementInvocation", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns most recent completed implement invocation with sessionId", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "completed",
      phase: "implement",
      sessionId: "old-session",
    });
    const recentId = seedInvocation(db, t, {
      status: "completed",
      phase: "implement",
      sessionId: "new-session",
    });

    const inv = getLastCompletedImplementInvocation(db, t);
    expect(inv).toBeDefined();
    expect(inv!.id).toBe(recentId);
    expect(inv!.sessionId).toBe("new-session");
  });

  test("ignores invocations without sessionId", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "completed",
      phase: "implement",
      sessionId: null,
    });
    expect(getLastCompletedImplementInvocation(db, t)).toBeUndefined();
  });

  test("ignores review phase invocations", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "completed",
      phase: "review",
      sessionId: "review-session",
    });
    expect(getLastCompletedImplementInvocation(db, t)).toBeUndefined();
  });

  test("ignores failed invocations", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: "some-session",
    });
    expect(getLastCompletedImplementInvocation(db, t)).toBeUndefined();
  });

  test("returns undefined when no matching invocations", () => {
    const t = seedTask(db);
    expect(getLastCompletedImplementInvocation(db, t)).toBeUndefined();
  });
});

describe("getLastMaxTurnsInvocation", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns most recent max-turns invocation with sessionId and worktreePath", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: "old-sess",
      worktreePath: "/tmp/wt1",
      outputSummary: "max turns reached",
    });
    const recentId = seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: "new-sess",
      worktreePath: "/tmp/wt2",
      outputSummary: "max turns reached",
    });

    const inv = getLastMaxTurnsInvocation(db, t);
    expect(inv).toBeDefined();
    expect(inv!.id).toBe(recentId);
  });

  test("ignores invocations without 'max turns reached' outputSummary", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: "sess",
      worktreePath: "/tmp/wt",
      outputSummary: "execution error",
    });
    expect(getLastMaxTurnsInvocation(db, t)).toBeUndefined();
  });

  test("ignores invocations without worktreePath", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: "sess",
      worktreePath: null,
      outputSummary: "max turns reached",
    });
    expect(getLastMaxTurnsInvocation(db, t)).toBeUndefined();
  });

  test("ignores invocations without sessionId", () => {
    const t = seedTask(db);
    seedInvocation(db, t, {
      status: "failed",
      phase: "implement",
      sessionId: null,
      worktreePath: "/tmp/wt",
      outputSummary: "max turns reached",
    });
    expect(getLastMaxTurnsInvocation(db, t)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Budget queries
// ---------------------------------------------------------------------------

describe("insertBudgetEvent / sumTokensInWindow", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sums tokens within window", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);
    const recent = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10 hours ago

    insertBudgetEvent(db, { invocationId: invId, costUsd: 3.0, inputTokens: 2000, outputTokens: 1000, recordedAt: recent });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 1.5, inputTokens: 1000, outputTokens: 500, recordedAt: old });

    const windowStart = budgetWindowStart(4); // 4-hour window
    const total = sumTokensInWindow(db, windowStart);
    expect(total).toBe(3000); // only the recent event: 2000 + 1000
  });

  test("returns 0 when no events in window", () => {
    const windowStart = new Date(Date.now() + 1000).toISOString(); // future
    expect(sumTokensInWindow(db, windowStart)).toBe(0);
  });

  test("includes all events when window covers everything", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);
    insertBudgetEvent(db, { invocationId: invId, costUsd: 2.0, inputTokens: 1000, outputTokens: 500, recordedAt: now() });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 3.0, inputTokens: 2000, outputTokens: 1000, recordedAt: now() });

    const windowStart = new Date(0).toISOString();
    expect(sumTokensInWindow(db, windowStart)).toBe(4500); // (1000+500) + (2000+1000)
  });
});

describe("budgetWindowStart", () => {
  test("returns ISO timestamp approximately N hours ago", () => {
    const before = Date.now();
    const windowStart = budgetWindowStart(1);
    const after = Date.now();

    const windowMs = new Date(windowStart).getTime();
    const oneHour = 60 * 60 * 1000;
    expect(windowMs).toBeGreaterThanOrEqual(before - oneHour - 10);
    expect(windowMs).toBeLessThanOrEqual(after - oneHour + 10);
  });
});

describe("sumTokensInWindowRange", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("sums tokens within [start, end) range", () => {
    const taskId = seedTask(db);
    const invId = seedInvocation(db, taskId);

    const t1 = "2024-01-01T00:00:00.000Z";
    const t2 = "2024-01-01T01:00:00.000Z";
    const t3 = "2024-01-01T02:00:00.000Z";
    const t4 = "2024-01-01T03:00:00.000Z";

    insertBudgetEvent(db, { invocationId: invId, costUsd: 1.0, inputTokens: 100, outputTokens: 50, recordedAt: t1 });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 2.0, inputTokens: 200, outputTokens: 100, recordedAt: t2 });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 4.0, inputTokens: 400, outputTokens: 200, recordedAt: t3 });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 8.0, inputTokens: 800, outputTokens: 400, recordedAt: t4 });

    // Range [t2, t4) — should include t2 and t3, exclude t1 and t4
    const total = sumTokensInWindowRange(db, t2, t4);
    expect(total).toBe(900); // (200+100) + (400+200)
  });

  test("returns 0 when no events in range", () => {
    const total = sumTokensInWindowRange(db, "2030-01-01T00:00:00.000Z", "2030-12-31T00:00:00.000Z");
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metrics / aggregate queries
// ---------------------------------------------------------------------------

describe("getInvocationStats", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns empty stats when no invocations", () => {
    const stats = getInvocationStats(db);
    expect(stats.byStatus).toHaveLength(0);
    expect(stats.avgDurationSecs).toBeNull();
    expect(stats.avgTokens).toBeNull();
    expect(stats.totalTokens).toBeNull();
  });

  test("aggregates byStatus counts correctly", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "completed" });
    seedInvocation(db, t, { status: "completed" });
    seedInvocation(db, t, { status: "failed" });
    seedInvocation(db, t, { status: "running" });

    const stats = getInvocationStats(db);
    const completedEntry = stats.byStatus.find((s) => s.status === "completed");
    const failedEntry = stats.byStatus.find((s) => s.status === "failed");
    const runningEntry = stats.byStatus.find((s) => s.status === "running");

    expect(completedEntry?.count).toBe(2);
    expect(failedEntry?.count).toBe(1);
    expect(runningEntry?.count).toBe(1);
  });

  test("computes avgTokens and totalTokens from completed invocations", () => {
    const t = seedTask(db);
    const invId1 = seedInvocation(db, t, { status: "completed", costUsd: 1.0 });
    const invId2 = seedInvocation(db, t, { status: "completed", costUsd: 3.0 });
    seedInvocation(db, t, { status: "failed", costUsd: 10.0 }); // should not count

    // Update invocations with token data
    updateInvocation(db, invId1, { inputTokens: 1000, outputTokens: 500 });
    updateInvocation(db, invId2, { inputTokens: 2000, outputTokens: 1000 });

    const stats = getInvocationStats(db);
    // avg = (1500 + 3000) / 2 = 2250
    expect(stats.avgTokens).toBeCloseTo(2250);
    // total = 1500 + 3000 = 4500
    expect(stats.totalTokens).toBeCloseTo(4500);
  });

  test("computes avgDurationSecs from completed invocations", () => {
    const t = seedTask(db);
    // 60-second invocation
    const start = "2024-01-01T00:00:00.000Z";
    const end = "2024-01-01T00:01:00.000Z";
    seedInvocation(db, t, { status: "completed", startedAt: start, endedAt: end });

    const stats = getInvocationStats(db);
    expect(stats.avgDurationSecs).toBeCloseTo(60, 0);
  });
});

describe("getRecentErrors", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns failed and timed_out invocations ordered by id desc", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "completed" });
    const failId = seedInvocation(db, t, { status: "failed", outputSummary: "exploded" });
    const timedId = seedInvocation(db, t, { status: "timed_out" });

    const errors = getRecentErrors(db);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.id).toBe(timedId); // most recent first
    expect(errors[1]!.id).toBe(failId);
  });

  test("respects limit parameter", () => {
    const t = seedTask(db);
    for (let i = 0; i < 5; i++) {
      seedInvocation(db, t, { status: "failed" });
    }
    expect(getRecentErrors(db, 3)).toHaveLength(3);
  });

  test("returned shape has expected fields", () => {
    const t = seedTask(db);
    const invId = seedInvocation(db, t, { status: "failed", outputSummary: "oops", phase: "implement", costUsd: 0.5 });
    updateInvocation(db, invId, { inputTokens: 1000, outputTokens: 500 });

    const errors = getRecentErrors(db);
    expect(errors[0]).toMatchObject({
      linearIssueId: t,
      status: "failed",
      outputSummary: "oops",
      phase: "implement",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(typeof errors[0]!.id).toBe("number");
    expect(typeof errors[0]!.startedAt).toBe("string");
  });
});

describe("getDailyStats", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns N entries (one per day)", () => {
    const stats = getDailyStats(db, 7);
    expect(stats).toHaveLength(7);
  });

  test("fills missing days with zeros", () => {
    const stats = getDailyStats(db, 3);
    for (const entry of stats) {
      expect(entry.completed).toBe(0);
      expect(entry.failed).toBe(0);
      expect(entry.tokens).toBe(0);
    }
  });

  test("counts completed and failed invocations on correct day", () => {
    const t = seedTask(db);
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTs = todayStart.toISOString();

    seedInvocation(db, t, { status: "completed", startedAt: todayTs, costUsd: 1.0 });
    seedInvocation(db, t, { status: "failed", startedAt: todayTs, costUsd: 0.5 });
    seedInvocation(db, t, { status: "timed_out", startedAt: todayTs });

    const stats = getDailyStats(db, 1);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.completed).toBe(1);
    expect(stats[0]!.failed).toBe(2); // failed + timed_out
  });
});

describe("getRecentActivity", () => {
  let db: OrcaDb;
  beforeEach(() => { db = freshDb(); });

  test("returns invocations ordered by id desc", () => {
    const t = seedTask(db);
    seedInvocation(db, t, { status: "completed" });
    const lastId = seedInvocation(db, t, { status: "running" });

    const activity = getRecentActivity(db);
    expect(activity[0]!.id).toBe(lastId);
  });

  test("respects limit parameter", () => {
    const t = seedTask(db);
    for (let i = 0; i < 5; i++) {
      seedInvocation(db, t, { status: "completed" });
    }
    expect(getRecentActivity(db, 3)).toHaveLength(3);
  });

  test("returned shape has expected fields", () => {
    const t = seedTask(db);
    const invId = seedInvocation(db, t, { status: "completed", phase: "review", costUsd: 1.23 });
    updateInvocation(db, invId, { inputTokens: 800, outputTokens: 400 });

    const [entry] = getRecentActivity(db);
    expect(entry).toBeDefined();
    expect(entry!.linearIssueId).toBe(t);
    expect(entry!.status).toBe("completed");
    expect(entry!.phase).toBe("review");
    expect(entry!.inputTokens).toBe(800);
    expect(entry!.outputTokens).toBe(400);
    expect(typeof entry!.id).toBe("number");
    expect(typeof entry!.startedAt).toBe("string");
  });
});
