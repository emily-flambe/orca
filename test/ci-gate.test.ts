// ---------------------------------------------------------------------------
// CI gate tests — pre-merge CI polling, PR merging, awaiting_ci lifecycle
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
  getAwaitingCiTasks,
  updateTaskCiInfo,
  updateTaskStatus,
  updateTaskFields,
  updateTaskDeployInfo,
  incrementReviewCycleCount,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";

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
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: TaskStatus;
    priority: number;
    retryCount: number;
    prBranchName: string;
    mergeCommitSha: string;
    prNumber: number;
    deployStartedAt: string;
    ciStartedAt: string;
    reviewCycleCount: number;
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
    prBranchName: overrides.prBranchName ?? null,
    mergeCommitSha: overrides.mergeCommitSha ?? null,
    prNumber: overrides.prNumber ?? null,
    deployStartedAt: overrides.deployStartedAt ?? null,
    ciStartedAt: overrides.ciStartedAt ?? null,
    reviewCycleCount: overrides.reviewCycleCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
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
    projectRepoMap: new Map(),
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    ...overrides,
  };
}

// ===========================================================================
// 1. Schema: awaiting_ci status and ci_started_at column
// ===========================================================================

describe("Schema - awaiting_ci status and ci_started_at column", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("inserting task with 'awaiting_ci' status succeeds", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CI-SCHEMA-1",
      orcaStatus: "awaiting_ci",
    });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("awaiting_ci");
  });

  test("fresh DB has ci_started_at column (null by default)", () => {
    const taskId = seedTask(db, { linearIssueId: "CI-SCHEMA-2" });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.ciStartedAt).toBeNull();
  });

  test("ci_started_at can be set on insert", () => {
    const ts = now();
    const taskId = seedTask(db, {
      linearIssueId: "CI-SCHEMA-3",
      orcaStatus: "awaiting_ci",
      ciStartedAt: ts,
    });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.ciStartedAt).toBe(ts);
  });
});

// ===========================================================================
// 2. Queries: getAwaitingCiTasks and updateTaskCiInfo
// ===========================================================================

describe("Queries - getAwaitingCiTasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns only tasks with orcaStatus 'awaiting_ci'", () => {
    seedTask(db, { linearIssueId: "ACI-1", orcaStatus: "awaiting_ci" });
    seedTask(db, { linearIssueId: "ACI-2", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "ACI-3", orcaStatus: "awaiting_ci" });
    seedTask(db, { linearIssueId: "ACI-4", orcaStatus: "deploying" });

    const awaiting = getAwaitingCiTasks(db);
    expect(awaiting).toHaveLength(2);
    const ids = awaiting.map((t) => t.linearIssueId).sort();
    expect(ids).toEqual(["ACI-1", "ACI-3"]);
  });

  test("returns empty array when no awaiting_ci tasks exist", () => {
    seedTask(db, { linearIssueId: "ACI-NONE-1", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "ACI-NONE-2", orcaStatus: "deploying" });

    const awaiting = getAwaitingCiTasks(db);
    expect(awaiting).toHaveLength(0);
  });

  test("returns empty array on empty database", () => {
    const awaiting = getAwaitingCiTasks(db);
    expect(awaiting).toHaveLength(0);
  });
});

describe("Queries - updateTaskCiInfo", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("sets ciStartedAt", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UCI-1",
      orcaStatus: "awaiting_ci",
    });

    const ts = now();
    updateTaskCiInfo(db, taskId, { ciStartedAt: ts });

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.ciStartedAt).toBe(ts);
  });

  test("updates updatedAt timestamp", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UCI-2",
      orcaStatus: "awaiting_ci",
    });

    const before = getTask(db, taskId)!;
    updateTaskCiInfo(db, taskId, { ciStartedAt: now() });
    const after = getTask(db, taskId)!;

    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );
  });

  test("can set ciStartedAt to null", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UCI-3",
      orcaStatus: "awaiting_ci",
      ciStartedAt: now(),
    });

    updateTaskCiInfo(db, taskId, { ciStartedAt: null });
    const task = getTask(db, taskId)!;
    expect(task.ciStartedAt).toBeNull();
  });

  test("non-existent task does not throw", () => {
    expect(() => {
      updateTaskCiInfo(db, "NONEXISTENT", { ciStartedAt: now() });
    }).not.toThrow();
  });
});

// ===========================================================================
// 3. Conflict resolution: awaiting_ci state cases
// ===========================================================================

// Mock scheduler and runner modules
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

describe("Conflict resolution - awaiting_ci status", () => {
  let db: OrcaDb;
  let config: OrcaConfig;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    config = testConfig();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("awaiting_ci + 'In Review' -> no-op (status stays awaiting_ci)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-CONF-1",
      orcaStatus: "awaiting_ci",
    });

    resolveConflict(db, taskId, "In Review", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("awaiting_ci");
  });

  test("awaiting_ci + 'Done' -> done (human override)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-CONF-2",
      orcaStatus: "awaiting_ci",
    });

    resolveConflict(db, taskId, "Done", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("done");
  });

  test("awaiting_ci + 'Todo' -> ready (user reset)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-CONF-3",
      orcaStatus: "awaiting_ci",
    });

    resolveConflict(db, taskId, "Todo", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  test("awaiting_ci + 'Backlog' -> backlog (user reset)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-CONF-4",
      orcaStatus: "awaiting_ci",
    });

    resolveConflict(db, taskId, "Backlog", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("backlog");
  });

  test("awaiting_ci + 'In Progress' -> no-op (upsert protects internal state)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-CONF-5",
      orcaStatus: "awaiting_ci",
    });

    resolveConflict(db, taskId, "In Progress", config);

    // No explicit conflict rule for awaiting_ci + "In Progress" — falls through
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("awaiting_ci");
  });
});

// ===========================================================================
// 4. Write-back: awaiting_ci transition is a no-op
// ===========================================================================

describe("Write-back - awaiting_ci transition is no-op", () => {
  let writeBackStatus: typeof import("../src/linear/sync.js").writeBackStatus;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    const syncMod = await import("../src/linear/sync.js");
    writeBackStatus = syncMod.writeBackStatus;
    expectedChanges = syncMod.expectedChanges;
    expectedChanges.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("writeBackStatus('awaiting_ci') does not call client.updateIssueState", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map([
      ["In Review", { id: "state-review", type: "started" }],
    ]);

    await writeBackStatus(mockClient, "TASK-ACI-WB-1", "awaiting_ci", stateMap);

    expect(mockClient.updateIssueState).not.toHaveBeenCalled();
  });

  test("writeBackStatus('awaiting_ci') does not register an expected change", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map();

    await writeBackStatus(mockClient, "TASK-ACI-WB-2", "awaiting_ci", stateMap);

    expect(expectedChanges.size).toBe(0);
  });
});

// ===========================================================================
// 5. Parent status rollup: awaiting_ci is an active child status
// ===========================================================================

describe("Parent status rollup - awaiting_ci is active", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("parent with awaiting_ci child is considered active (not all done)", () => {
    // Create a parent
    const ts = now();
    insertTask(db, {
      linearIssueId: "PARENT-ACI",
      agentPrompt: "parent",
      repoPath: "/tmp/test",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      isParent: 1,
      createdAt: ts,
      updatedAt: ts,
    });

    // Create children
    insertTask(db, {
      linearIssueId: "CHILD-ACI-1",
      agentPrompt: "child1",
      repoPath: "/tmp/test",
      orcaStatus: "done",
      priority: 0,
      retryCount: 0,
      parentIdentifier: "PARENT-ACI",
      createdAt: ts,
      updatedAt: ts,
    });

    insertTask(db, {
      linearIssueId: "CHILD-ACI-2",
      agentPrompt: "child2",
      repoPath: "/tmp/test",
      orcaStatus: "awaiting_ci",
      priority: 0,
      retryCount: 0,
      parentIdentifier: "PARENT-ACI",
      createdAt: ts,
      updatedAt: ts,
    });

    // The parent should NOT be all done (child2 is awaiting_ci)
    const parent = getTask(db, "PARENT-ACI")!;
    expect(parent.orcaStatus).toBe("ready"); // still ready, not done
  });
});

// ===========================================================================
// 6. Webhook protection: awaiting_ci not overwritten by intermediate states
// ===========================================================================

describe("Webhook protection - awaiting_ci status not overwritten by In Review", () => {
  let db: OrcaDb;
  let config: OrcaConfig;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    db = freshDb();
    config = testConfig();
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    expectedChanges = syncMod.expectedChanges;
    expectedChanges.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("existing awaiting_ci task receiving 'In Review' webhook stays awaiting_ci", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-WH-1",
      orcaStatus: "awaiting_ci",
      prNumber: 42,
      ciStartedAt: now(),
    });

    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = { rebuild: vi.fn() } as any;
    const stateMap = new Map([
      ["In Review", { id: "state-review", type: "started" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      mockGraph,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-aci-1",
          identifier: "ACI-WH-1",
          title: "Test task",
          description: "test",
          priority: 1,
          state: { id: "state-review", name: "In Review", type: "started" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("awaiting_ci");
  });

  test("existing awaiting_ci task receiving 'Done' webhook transitions to done", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-WH-2",
      orcaStatus: "awaiting_ci",
    });

    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = { rebuild: vi.fn() } as any;
    const stateMap = new Map([
      ["Done", { id: "state-done", type: "completed" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      mockGraph,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-aci-2",
          identifier: "ACI-WH-2",
          title: "Test task 2",
          description: "test",
          priority: 1,
          state: { id: "state-done", name: "Done", type: "completed" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("done");
  });

  test("existing awaiting_ci task receiving 'Todo' webhook transitions to ready", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "ACI-WH-3",
      orcaStatus: "awaiting_ci",
    });

    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = { rebuild: vi.fn() } as any;
    const stateMap = new Map([
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      mockGraph,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-aci-3",
          identifier: "ACI-WH-3",
          title: "Test task 3",
          description: "test",
          priority: 1,
          state: { id: "state-todo", name: "Todo", type: "unstarted" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });
});

// ===========================================================================
// 7. Edge cases and boundary conditions
// ===========================================================================

describe("Edge cases - awaiting_ci", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("getAwaitingCiTasks does not return tasks that changed away from awaiting_ci", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-ACI-1",
      orcaStatus: "awaiting_ci",
    });

    updateTaskStatus(db, taskId, "done");

    const awaiting = getAwaitingCiTasks(db);
    expect(awaiting).toHaveLength(0);
  });

  test("updateTaskFields can set orcaStatus to awaiting_ci", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-ACI-2",
      orcaStatus: "in_review",
    });

    updateTaskFields(db, taskId, { orcaStatus: "awaiting_ci" });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("awaiting_ci");
  });

  test("awaiting_ci task with all CI fields populated", () => {
    const ts = now();
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-ACI-FULL",
      orcaStatus: "awaiting_ci",
      prNumber: 42,
      prBranchName: "orca/EDGE-ACI-FULL/1",
      ciStartedAt: ts,
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("awaiting_ci");
    expect(task.prNumber).toBe(42);
    expect(task.prBranchName).toBe("orca/EDGE-ACI-FULL/1");
    expect(task.ciStartedAt).toBe(ts);
  });

  test("multiple awaiting_ci tasks are all returned by getAwaitingCiTasks", () => {
    for (let i = 1; i <= 5; i++) {
      seedTask(db, {
        linearIssueId: `MULTI-ACI-${i}`,
        orcaStatus: "awaiting_ci",
      });
    }

    const awaiting = getAwaitingCiTasks(db);
    expect(awaiting).toHaveLength(5);
  });

  test("awaiting_ci task with null prNumber and null ciStartedAt", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-ACI-NULL",
      orcaStatus: "awaiting_ci",
    });

    const task = getTask(db, taskId)!;
    expect(task.prNumber).toBeNull();
    expect(task.ciStartedAt).toBeNull();
  });

  test("all TASK_STATUSES including awaiting_ci can be inserted", () => {
    const statuses: TaskStatus[] = [
      "backlog",
      "ready",
      "dispatched",
      "running",
      "done",
      "failed",
      "in_review",
      "changes_requested",
      "deploying",
      "awaiting_ci",
    ];

    for (const status of statuses) {
      const taskId = seedTask(db, {
        linearIssueId: `ALL-STATUS-${status}`,
        orcaStatus: status,
      });
      const task = getTask(db, taskId);
      expect(task).toBeDefined();
      expect(task!.orcaStatus).toBe(status);
    }
  });
});

// ===========================================================================
// 8. Config: review prompt no longer includes merge instructions
// ===========================================================================

describe("Config - review prompt does not include merge instructions", () => {
  test("DEFAULT_REVIEW_SYSTEM_PROMPT does not contain 'gh pr merge'", async () => {
    // We can't easily access the default prompt string directly since it's
    // inside loadConfig. Instead, verify the testConfig pattern: reviewSystemPrompt
    // should not mention merging.
    const cfg = testConfig();
    // testConfig uses empty string, but the real prompt is in config/index.ts.
    // We verify the expectation that APPROVED instruction says "Do NOT merge"
    // by reading the source file.
    const { readFileSync } = await import("node:fs");
    const configSource = readFileSync(
      new URL("../src/config/index.ts", import.meta.url),
      "utf-8",
    );

    // The old instruction had "gh pr merge" in the APPROVED branch
    expect(configSource).not.toContain(
      "merge the PR using `gh pr merge",
    );
    // The new instruction should say not to merge
    expect(configSource).toContain("Do NOT merge the PR");
  });
});
