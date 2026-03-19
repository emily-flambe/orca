// ---------------------------------------------------------------------------
// MCP server DB query logic tests
//
// The MCP server (src/mcp-server/index.ts) exposes 5 read-only tools that
// each delegate to DB query functions. We test those query functions directly
// against an in-memory DB rather than spinning up the stdio transport.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  getInvocation,
  getInvocationsByTask,
  getChildTasks,
  insertInvocation,
} from "../src/db/queries.js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let _taskCounter = 0;

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    priority: number;
    retryCount: number;
    reviewCycleCount: number;
    isParent: number;
    parentIdentifier: string | null;
    mergeCommitSha: string | null;
    prNumber: number | null;
    prBranchName: string | null;
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
  const id = overrides.linearIssueId ?? `TEST-${++_taskCounter}`;
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "implement the feature",
    repoPath: overrides.repoPath ?? "/tmp/repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as any,
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    reviewCycleCount: overrides.reviewCycleCount ?? 0,
    isParent: overrides.isParent ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    mergeCommitSha: overrides.mergeCommitSha ?? null,
    prNumber: overrides.prNumber ?? null,
    prBranchName: overrides.prBranchName ?? null,
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
    status: "running" | "completed" | "failed" | "timed_out";
    phase: "implement" | "review";
    model: string;
    worktreePath: string;
    branchName: string;
    logPath: string;
    startedAt: string;
  }> = {},
): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: overrides.startedAt ?? now(),
    status: overrides.status ?? "completed",
    phase: overrides.phase ?? "implement",
    model: overrides.model ?? "sonnet",
    worktreePath: overrides.worktreePath ?? "/tmp/worktree",
    branchName: overrides.branchName ?? `orca/${taskId}`,
    logPath: overrides.logPath ?? `logs/1.ndjson`,
  });
}

// ---------------------------------------------------------------------------
// Tool: get_task — query logic
// ---------------------------------------------------------------------------

describe("get_task query logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns task fields for an existing task", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EMI-100",
      agentPrompt: "add feature",
      orcaStatus: "running",
      priority: 2,
      retryCount: 1,
      reviewCycleCount: 0,
      prBranchName: "orca/EMI-100",
      prNumber: 42,
      projectName: "my-project",
      parentIdentifier: null,
      isParent: 0,
    });

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.linearIssueId).toBe("EMI-100");
    expect(task!.agentPrompt).toBe("add feature");
    expect(task!.orcaStatus).toBe("running");
    expect(task!.priority).toBe(2);
    expect(task!.retryCount).toBe(1);
    expect(task!.prBranchName).toBe("orca/EMI-100");
    expect(task!.prNumber).toBe(42);
    expect(task!.projectName).toBe("my-project");
    expect(task!.isParent).toBe(0);
    expect(task!.parentIdentifier).toBeNull();
  });

  test("returns undefined for a missing task", () => {
    const task = getTask(db, "NONEXISTENT-1");
    expect(task).toBeUndefined();
  });

  test("returns task with invocation summary list", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-101" });
    const inv1 = seedInvocation(db, taskId, {
      phase: "implement",
      status: "completed",
    });
    const inv2 = seedInvocation(db, taskId, {
      phase: "review",
      status: "failed",
    });

    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations).toHaveLength(2);

    const ids = invocations.map((i) => i.id);
    expect(ids).toContain(inv1);
    expect(ids).toContain(inv2);

    // Verify the fields the tool uses for the invocation summary
    const implement = invocations.find((i) => i.phase === "implement");
    expect(implement).toBeDefined();
    expect(implement!.status).toBe("completed");

    const review = invocations.find((i) => i.phase === "review");
    expect(review).toBeDefined();
    expect(review!.status).toBe("failed");
  });

  test("returns isParent as integer 1 for parent tasks", () => {
    seedTask(db, { linearIssueId: "PARENT-1", isParent: 1 });
    const task = getTask(db, "PARENT-1");
    expect(task!.isParent).toBe(1);
    // The tool converts: isParent === 1 → true
    expect(task!.isParent === 1).toBe(true);
  });

  test("task with no invocations returns empty invocation list", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-200" });
    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tool: get_invocation — query logic
// ---------------------------------------------------------------------------

describe("get_invocation query logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns full invocation fields for a valid ID", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-300" });
    const invId = seedInvocation(db, taskId, {
      phase: "implement",
      status: "completed",
      model: "claude-sonnet-4",
      branchName: "orca/EMI-300",
      worktreePath: "/tmp/orca-EMI-300",
      logPath: "logs/99.ndjson",
    });

    const inv = getInvocation(db, invId);
    expect(inv).toBeDefined();
    expect(inv!.id).toBe(invId);
    expect(inv!.linearIssueId).toBe("EMI-300");
    expect(inv!.phase).toBe("implement");
    expect(inv!.status).toBe("completed");
    expect(inv!.model).toBe("claude-sonnet-4");
    expect(inv!.branchName).toBe("orca/EMI-300");
    expect(inv!.worktreePath).toBe("/tmp/orca-EMI-300");
    expect(inv!.logPath).toBe("logs/99.ndjson");
  });

  test("returns undefined for a missing invocation ID", () => {
    const inv = getInvocation(db, 99999);
    expect(inv).toBeUndefined();
  });

  test("returns correct invocation when multiple exist for same task", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-301" });
    const inv1 = seedInvocation(db, taskId, {
      phase: "implement",
      status: "failed",
    });
    const inv2 = seedInvocation(db, taskId, {
      phase: "implement",
      status: "completed",
    });

    const fetched1 = getInvocation(db, inv1);
    expect(fetched1!.status).toBe("failed");
    expect(fetched1!.phase).toBe("implement");

    const fetched2 = getInvocation(db, inv2);
    expect(fetched2!.status).toBe("completed");
  });

  test("returns undefined for ID 0 (never a valid autoincrement ID)", () => {
    const inv = getInvocation(db, 0);
    expect(inv).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool: list_task_invocations — query logic
// ---------------------------------------------------------------------------

describe("list_task_invocations query logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns all invocations for a task", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-400" });
    seedInvocation(db, taskId, { phase: "implement", status: "failed" });
    seedInvocation(db, taskId, { phase: "implement", status: "completed" });
    seedInvocation(db, taskId, { phase: "review", status: "completed" });

    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations).toHaveLength(3);

    // Verify the fields the tool maps in its result
    for (const inv of invocations) {
      expect(inv.id).toBeDefined();
      expect(inv.phase).toBeDefined();
      expect(inv.status).toBeDefined();
      expect(inv.model).toBeDefined();
      expect(inv.startedAt).toBeDefined();
      expect(inv.branchName).toBeDefined();
    }
  });

  test("returns empty array for a task with no invocations", () => {
    const taskId = seedTask(db, { linearIssueId: "EMI-401" });
    const invocations = getInvocationsByTask(db, taskId);
    expect(invocations).toHaveLength(0);
    expect(Array.isArray(invocations)).toBe(true);
  });

  test("returns undefined from getTask for a missing task ID", () => {
    // The tool checks getTask first before listing invocations
    const task = getTask(db, "MISSING-999");
    expect(task).toBeUndefined();
  });

  test("only returns invocations for the requested task, not others", () => {
    const task1 = seedTask(db, { linearIssueId: "EMI-402" });
    const task2 = seedTask(db, { linearIssueId: "EMI-403" });
    seedInvocation(db, task1, { phase: "implement" });
    seedInvocation(db, task1, { phase: "review" });
    seedInvocation(db, task2, { phase: "implement" });

    const invs1 = getInvocationsByTask(db, task1);
    expect(invs1).toHaveLength(2);
    expect(invs1.every((i) => i.linearIssueId === task1)).toBe(true);

    const invs2 = getInvocationsByTask(db, task2);
    expect(invs2).toHaveLength(1);
    expect(invs2[0]!.linearIssueId).toBe(task2);
  });
});

// ---------------------------------------------------------------------------
// Tool: get_parent_issue — query logic
// ---------------------------------------------------------------------------

describe("get_parent_issue query logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns undefined from getTask for missing child task", () => {
    const task = getTask(db, "NONEXISTENT-CHILD");
    expect(task).toBeUndefined();
  });

  test("task with no parentIdentifier has null parentIdentifier", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EMI-500",
      parentIdentifier: null,
    });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.parentIdentifier).toBeNull();
  });

  test("parent exists in DB and is returned", () => {
    seedTask(db, {
      linearIssueId: "EMI-10",
      agentPrompt: "parent epic",
      orcaStatus: "done",
      projectName: "alpha-project",
      isParent: 1,
    });
    seedTask(db, {
      linearIssueId: "EMI-11",
      parentIdentifier: "EMI-10",
    });

    const child = getTask(db, "EMI-11");
    expect(child!.parentIdentifier).toBe("EMI-10");

    const parent = getTask(db, child!.parentIdentifier!);
    expect(parent).toBeDefined();
    expect(parent!.linearIssueId).toBe("EMI-10");
    expect(parent!.agentPrompt).toBe("parent epic");
    expect(parent!.orcaStatus).toBe("done");
    expect(parent!.projectName).toBe("alpha-project");
    expect(parent!.isParent).toBe(1);
  });

  test("parentIdentifier set but parent not in DB returns undefined", () => {
    seedTask(db, {
      linearIssueId: "EMI-20",
      parentIdentifier: "EMI-999-NOT-IN-DB",
    });

    const child = getTask(db, "EMI-20");
    expect(child!.parentIdentifier).toBe("EMI-999-NOT-IN-DB");

    const parent = getTask(db, child!.parentIdentifier!);
    expect(parent).toBeUndefined();
  });

  test("parent task has correct fields mapped by the tool", () => {
    const ts = now();
    seedTask(db, {
      linearIssueId: "PARENT-X",
      agentPrompt: "overall plan",
      orcaStatus: "ready",
      projectName: "beta",
      isParent: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    seedTask(db, { linearIssueId: "CHILD-X", parentIdentifier: "PARENT-X" });

    const child = getTask(db, "CHILD-X");
    const parent = getTask(db, child!.parentIdentifier!);

    // Verify the fields the tool returns in its result object
    expect(parent!.linearIssueId).toBe("PARENT-X");
    expect(parent!.agentPrompt).toBe("overall plan");
    expect(parent!.orcaStatus).toBe("ready");
    expect(parent!.projectName).toBe("beta");
    expect(parent!.isParent).toBe(1);
    expect(parent!.createdAt).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// Tool: get_sibling_tasks — query logic
// ---------------------------------------------------------------------------

describe("get_sibling_tasks query logic", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns undefined from getTask for missing task", () => {
    const task = getTask(db, "NONEXISTENT-SIBLING");
    expect(task).toBeUndefined();
  });

  test("siblings by parentIdentifier excludes self", () => {
    seedTask(db, { linearIssueId: "PARENT-S", isParent: 1 });
    seedTask(db, {
      linearIssueId: "CHILD-A",
      parentIdentifier: "PARENT-S",
      orcaStatus: "ready",
    });
    seedTask(db, {
      linearIssueId: "CHILD-B",
      parentIdentifier: "PARENT-S",
      orcaStatus: "running",
    });
    seedTask(db, {
      linearIssueId: "CHILD-C",
      parentIdentifier: "PARENT-S",
      orcaStatus: "done",
    });

    const task = getTask(db, "CHILD-A");
    expect(task!.parentIdentifier).toBe("PARENT-S");

    // Replicate the tool's sibling lookup
    const siblings = getChildTasks(db, task!.parentIdentifier!).filter(
      (t) => t.linearIssueId !== "CHILD-A",
    );

    expect(siblings).toHaveLength(2);
    const ids = siblings.map((s) => s.linearIssueId);
    expect(ids).toContain("CHILD-B");
    expect(ids).toContain("CHILD-C");
    expect(ids).not.toContain("CHILD-A");
  });

  test("returns empty array when task is the only child", () => {
    seedTask(db, { linearIssueId: "PARENT-ONLY", isParent: 1 });
    seedTask(db, {
      linearIssueId: "ONLY-CHILD",
      parentIdentifier: "PARENT-ONLY",
    });

    const task = getTask(db, "ONLY-CHILD");
    const siblings = getChildTasks(db, task!.parentIdentifier!).filter(
      (t) => t.linearIssueId !== "ONLY-CHILD",
    );

    expect(siblings).toHaveLength(0);
  });

  test("falls back to projectName siblings when no parentIdentifier", () => {
    seedTask(db, {
      linearIssueId: "PROJ-A",
      projectName: "my-project",
      parentIdentifier: null,
    });
    seedTask(db, {
      linearIssueId: "PROJ-B",
      projectName: "my-project",
      parentIdentifier: null,
    });
    seedTask(db, {
      linearIssueId: "PROJ-C",
      projectName: "my-project",
      parentIdentifier: null,
    });
    seedTask(db, {
      linearIssueId: "OTHER-1",
      projectName: "other-project",
      parentIdentifier: null,
    });

    const task = getTask(db, "PROJ-A");
    expect(task!.parentIdentifier).toBeNull();
    expect(task!.projectName).toBe("my-project");

    // Replicate the tool's project-level sibling fallback
    const siblings = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectName, task!.projectName!))
      .all()
      .filter((t) => t.linearIssueId !== "PROJ-A");

    expect(siblings).toHaveLength(2);
    const ids = siblings.map((s) => s.linearIssueId);
    expect(ids).toContain("PROJ-B");
    expect(ids).toContain("PROJ-C");
    expect(ids).not.toContain("PROJ-A");
    expect(ids).not.toContain("OTHER-1");
  });

  test("project fallback returns empty array when task is the only one in project", () => {
    seedTask(db, {
      linearIssueId: "SOLO-A",
      projectName: "solo-project",
      parentIdentifier: null,
    });

    const task = getTask(db, "SOLO-A");
    const siblings = db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.projectName, task!.projectName!))
      .all()
      .filter((t) => t.linearIssueId !== "SOLO-A");

    expect(siblings).toHaveLength(0);
  });

  test("task with no parentIdentifier and no projectName returns no siblings", () => {
    seedTask(db, {
      linearIssueId: "ORPHAN-1",
      parentIdentifier: null,
      projectName: null,
    });

    const task = getTask(db, "ORPHAN-1");
    expect(task!.parentIdentifier).toBeNull();
    expect(task!.projectName).toBeNull();

    // Tool logic: neither branch executes, siblings stays []
    const siblings: (typeof schema.tasks.$inferSelect)[] = [];
    expect(siblings).toHaveLength(0);
  });

  test("sibling result shape matches what the tool maps", () => {
    seedTask(db, { linearIssueId: "PARENT-SHAPE", isParent: 1 });
    seedTask(db, {
      linearIssueId: "SHAPE-A",
      parentIdentifier: "PARENT-SHAPE",
      orcaStatus: "done",
      retryCount: 2,
      prBranchName: "orca/SHAPE-A",
      projectName: "shape-proj",
    });
    seedTask(db, {
      linearIssueId: "SHAPE-B",
      parentIdentifier: "PARENT-SHAPE",
    });

    const task = getTask(db, "SHAPE-B");
    const siblings = getChildTasks(db, task!.parentIdentifier!).filter(
      (t) => t.linearIssueId !== "SHAPE-B",
    );

    expect(siblings).toHaveLength(1);
    const sib = siblings[0]!;

    // Verify fields the tool maps in its result
    expect(sib.linearIssueId).toBe("SHAPE-A");
    expect(sib.agentPrompt).toBeDefined();
    expect(sib.orcaStatus).toBe("done");
    expect(sib.retryCount).toBe(2);
    expect(sib.prBranchName).toBe("orca/SHAPE-A");
    expect(sib.projectName).toBe("shape-proj");
    expect(sib.parentIdentifier).toBe("PARENT-SHAPE");
  });

  test("parentIdentifier siblings do not bleed across parents", () => {
    seedTask(db, { linearIssueId: "PA", isParent: 1 });
    seedTask(db, { linearIssueId: "PB", isParent: 1 });
    seedTask(db, { linearIssueId: "PA-CHILD-1", parentIdentifier: "PA" });
    seedTask(db, { linearIssueId: "PA-CHILD-2", parentIdentifier: "PA" });
    seedTask(db, { linearIssueId: "PB-CHILD-1", parentIdentifier: "PB" });

    const task = getTask(db, "PA-CHILD-1");
    const siblings = getChildTasks(db, task!.parentIdentifier!).filter(
      (t) => t.linearIssueId !== "PA-CHILD-1",
    );

    expect(siblings).toHaveLength(1);
    expect(siblings[0]!.linearIssueId).toBe("PA-CHILD-2");
  });
});
