// ---------------------------------------------------------------------------
// Parent/child issue support tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  getAllTasks,
  getChildTasks,
  getParentTasks,
  updateTaskStatus,
  getDispatchableTasks,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

// Mock scheduler + runner so resolveConflict imports don't fail
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
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

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    projectRepoMap: new Map(),
    projectNameMap: new Map(),
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    ...overrides,
  };
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    priority: number;
    retryCount: number;
    parentIdentifier: string | null;
    isParent: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as any,
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    isParent: overrides.isParent ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

// ===========================================================================
// DB schema: parent_identifier and is_parent columns
// ===========================================================================

describe("DB schema - parent/child columns", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("parent_identifier and is_parent columns exist on fresh DB", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "PARENT-1",
      agentPrompt: "parent task",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      parentIdentifier: null,
      isParent: 1,
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "PARENT-1");
    expect(task).toBeDefined();
    expect(task!.isParent).toBe(1);
    expect(task!.parentIdentifier).toBeNull();
  });

  test("child task has parentIdentifier set", () => {
    seedTask(db, { linearIssueId: "PARENT-2", isParent: 1 });
    seedTask(db, { linearIssueId: "CHILD-1", parentIdentifier: "PARENT-2" });

    const child = getTask(db, "CHILD-1");
    expect(child).toBeDefined();
    expect(child!.parentIdentifier).toBe("PARENT-2");
    expect(child!.isParent).toBe(0);
  });

  test("isParent defaults to 0", () => {
    seedTask(db, { linearIssueId: "NORMAL-1" });
    const task = getTask(db, "NORMAL-1");
    expect(task!.isParent).toBe(0);
  });
});

// ===========================================================================
// Query helpers: getChildTasks and getParentTasks
// ===========================================================================

describe("Query helpers - getChildTasks and getParentTasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("getChildTasks returns children of a parent", () => {
    seedTask(db, { linearIssueId: "P-1", isParent: 1 });
    seedTask(db, { linearIssueId: "C-1", parentIdentifier: "P-1" });
    seedTask(db, { linearIssueId: "C-2", parentIdentifier: "P-1" });
    seedTask(db, { linearIssueId: "OTHER-1" }); // not a child

    const children = getChildTasks(db, "P-1");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.linearIssueId).sort()).toEqual(["C-1", "C-2"]);
  });

  test("getChildTasks returns empty array when no children", () => {
    seedTask(db, { linearIssueId: "P-2", isParent: 1 });
    expect(getChildTasks(db, "P-2")).toHaveLength(0);
  });

  test("getParentTasks returns all parent tasks", () => {
    seedTask(db, { linearIssueId: "P-A", isParent: 1 });
    seedTask(db, { linearIssueId: "P-B", isParent: 1 });
    seedTask(db, { linearIssueId: "NORMAL" });

    const parents = getParentTasks(db);
    expect(parents).toHaveLength(2);
    expect(parents.map((p) => p.linearIssueId).sort()).toEqual(["P-A", "P-B"]);
  });

  test("getParentTasks returns empty array when no parents", () => {
    seedTask(db, { linearIssueId: "NORMAL-1" });
    seedTask(db, { linearIssueId: "NORMAL-2" });
    expect(getParentTasks(db)).toHaveLength(0);
  });
});

// ===========================================================================
// buildPrompt: parent context enrichment
// ===========================================================================

describe("buildPrompt - parent context", () => {
  let buildPrompt: typeof import("../src/linear/sync.js").buildPrompt;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    buildPrompt = syncMod.buildPrompt;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("child with parent context includes parent section", () => {
    const issue = {
      id: "uuid-1",
      identifier: "CHILD-1",
      title: "Implement login",
      description: "Add OAuth flow",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "t1",
      projectId: "p1",
      relations: [],
      inverseRelations: [],
      parentId: "PARENT-1",
      parentTitle: "Auth System Overhaul",
      parentDescription: "Redesign the entire auth system for SSO support",
      childIds: [],
    };

    const prompt = buildPrompt(issue);
    expect(prompt).toContain("## Parent Issue");
    expect(prompt).toContain("**Auth System Overhaul**");
    expect(prompt).toContain("Redesign the entire auth system");
    expect(prompt).toContain("## This Issue");
    expect(prompt).toContain("Implement login");
    expect(prompt).toContain("Add OAuth flow");
  });

  test("child with null parentDescription omits it gracefully", () => {
    const issue = {
      id: "uuid-2",
      identifier: "CHILD-2",
      title: "Add button",
      description: "",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "t1",
      projectId: "p1",
      relations: [],
      inverseRelations: [],
      parentId: "PARENT-2",
      parentTitle: "UI Redesign",
      parentDescription: null,
      childIds: [],
    };

    const prompt = buildPrompt(issue);
    expect(prompt).toContain("## Parent Issue");
    expect(prompt).toContain("**UI Redesign**");
    expect(prompt).toContain("## This Issue");
  });

  test("issue without parent returns plain prompt", () => {
    const issue = {
      id: "uuid-3",
      identifier: "SOLO-1",
      title: "Fix bug",
      description: "The button is broken",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "t1",
      projectId: "p1",
      relations: [],
      inverseRelations: [],
      parentId: null,
      parentTitle: null,
      parentDescription: null,
      childIds: [],
    };

    const prompt = buildPrompt(issue);
    expect(prompt).not.toContain("## Parent Issue");
    expect(prompt).toBe("Fix bug\n\nThe button is broken");
  });
});

// ===========================================================================
// evaluateParentStatuses
// ===========================================================================

describe("evaluateParentStatuses", () => {
  let db: OrcaDb;
  let evaluateParentStatuses: typeof import("../src/linear/sync.js").evaluateParentStatuses;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    evaluateParentStatuses = syncMod.evaluateParentStatuses;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockClient() {
    return {
      updateIssueState: vi.fn().mockResolvedValue(true),
      createComment: vi.fn().mockResolvedValue(true),
      createAttachment: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
    } as any;
  }

  const stateMap = new Map([
    ["Todo", { id: "s-todo", type: "unstarted" }],
    ["In Progress", { id: "s-progress", type: "started" }],
    ["Done", { id: "s-done", type: "completed" }],
  ]);

  test("parent transitions to done when all children are done", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "running" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "CHILD-B", parentIdentifier: "PARENT", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "CHILD-C", parentIdentifier: "PARENT", orcaStatus: "done" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    const parent = getTask(db, "PARENT");
    expect(parent!.orcaStatus).toBe("done");
    expect(client.updateIssueState).toHaveBeenCalledWith("PARENT", "s-done");
  });

  test("parent transitions to running when any child is active", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "running" });
    seedTask(db, { linearIssueId: "CHILD-B", parentIdentifier: "PARENT", orcaStatus: "ready" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    const parent = getTask(db, "PARENT");
    expect(parent!.orcaStatus).toBe("running");
    expect(client.updateIssueState).toHaveBeenCalledWith("PARENT", "s-progress");
  });

  test("parent stays running when some children are done and some active", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "running" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "CHILD-B", parentIdentifier: "PARENT", orcaStatus: "in_review" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    const parent = getTask(db, "PARENT");
    // Not all done, parent is already running — no change
    expect(parent!.orcaStatus).toBe("running");
  });

  test("parent with no children is skipped", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "ready" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    const parent = getTask(db, "PARENT");
    expect(parent!.orcaStatus).toBe("ready");
    expect(client.updateIssueState).not.toHaveBeenCalled();
  });

  test("evaluates only specified parentIds when provided", async () => {
    seedTask(db, { linearIssueId: "P-1", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "C-1", parentIdentifier: "P-1", orcaStatus: "running" });

    seedTask(db, { linearIssueId: "P-2", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "C-2", parentIdentifier: "P-2", orcaStatus: "running" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap, ["P-1"]);

    // P-1 should be updated
    expect(getTask(db, "P-1")!.orcaStatus).toBe("running");
    // P-2 should NOT be updated (not in parentIds)
    expect(getTask(db, "P-2")!.orcaStatus).toBe("ready");
  });

  test("parent already done is not updated again", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "done" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "done" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    expect(client.updateIssueState).not.toHaveBeenCalled();
  });

  test("child in_review counts as active for parent", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "in_review" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    expect(getTask(db, "PARENT")!.orcaStatus).toBe("running");
  });

  test("child deploying counts as active for parent", async () => {
    seedTask(db, { linearIssueId: "PARENT", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "CHILD-A", parentIdentifier: "PARENT", orcaStatus: "deploying" });

    const client = mockClient();
    await evaluateParentStatuses(db, client, stateMap);

    expect(getTask(db, "PARENT")!.orcaStatus).toBe("running");
  });
});

// ===========================================================================
// fullSync: parent/child field population
// ===========================================================================

describe("fullSync - parent/child fields", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeMockClient(issues: any[]) {
    return {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;
  }

  function makeIssue(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Test issue",
      description: "Test description",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      projectId: "proj-1",
      projectName: "Test Project",
      relations: [],
      inverseRelations: [],
      parentId: null,
      parentTitle: null,
      parentDescription: null,
      childIds: [],
      ...overrides,
    };
  }

  test("parent issue gets isParent=1 after sync", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const parentIssue = makeIssue({
      identifier: "EMI-36",
      childIds: ["EMI-37", "EMI-38"],
    });
    const client = makeMockClient([parentIssue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-36");
    expect(task).toBeDefined();
    expect(task!.isParent).toBe(1);
  });

  test("child issue gets parentIdentifier after sync", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const childIssue = makeIssue({
      identifier: "EMI-37",
      parentId: "EMI-36",
      parentTitle: "Tracking Ticket",
      parentDescription: "Parent description here",
    });
    const client = makeMockClient([childIssue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-37");
    expect(task).toBeDefined();
    expect(task!.parentIdentifier).toBe("EMI-36");
    expect(task!.isParent).toBe(0);
  });

  test("child issue prompt includes parent context", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const childIssue = makeIssue({
      identifier: "EMI-37",
      title: "Implement feature X",
      description: "Do the thing",
      parentId: "EMI-36",
      parentTitle: "Feature Epic",
      parentDescription: "Overall plan for feature",
    });
    const client = makeMockClient([childIssue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-37");
    expect(task!.agentPrompt).toContain("## Parent Issue");
    expect(task!.agentPrompt).toContain("**Feature Epic**");
    expect(task!.agentPrompt).toContain("## This Issue");
    expect(task!.agentPrompt).toContain("Implement feature X");
  });

  test("normal issue (no parent, no children) has isParent=0", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const issue = makeIssue({ identifier: "EMI-99" });
    const client = makeMockClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-99");
    expect(task!.isParent).toBe(0);
    expect(task!.parentIdentifier).toBeNull();
  });
});

// ===========================================================================
// Dispatch filtering: parent tasks skipped
// ===========================================================================

describe("Dispatch filtering - parent tasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("parent task with isParent=1 is in dispatchable query but should be filtered", () => {
    seedTask(db, { linearIssueId: "PARENT-1", isParent: 1, orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "CHILD-1", parentIdentifier: "PARENT-1", orcaStatus: "ready" });

    const candidates = getDispatchableTasks(db, ["ready"]);
    // Both appear in the query (DB doesn't filter isParent)
    expect(candidates).toHaveLength(2);

    // Scheduler's filter: skip isParent
    const dispatchable = candidates.filter((t) => !t.isParent);
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]!.linearIssueId).toBe("CHILD-1");
  });

  test("parent with 0 children and isParent=0 is dispatchable", () => {
    // Edge case: parent had children removed, isParent reset to 0
    seedTask(db, { linearIssueId: "FORMER-PARENT", isParent: 0, orcaStatus: "ready" });

    const candidates = getDispatchableTasks(db, ["ready"]);
    const dispatchable = candidates.filter((t) => !t.isParent);
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]!.linearIssueId).toBe("FORMER-PARENT");
  });
});
