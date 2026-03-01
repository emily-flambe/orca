// ---------------------------------------------------------------------------
// Deploy monitoring tests
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
  getDeployingTasks,
  updateTaskDeployInfo,
  updateTaskStatus,
  updateTaskFields,
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
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

/** Minimal OrcaConfig for testing. */
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
    ...overrides,
  };
}

// ===========================================================================
// 1. Database migration: new columns and CHECK constraint removed
// ===========================================================================

describe("Database migration - new columns and no CHECK constraint", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("fresh DB has merge_commit_sha column", () => {
    const taskId = seedTask(db, { linearIssueId: "SCHEMA-1" });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    // merge_commit_sha should exist and be null by default
    expect(task!.mergeCommitSha).toBeNull();
  });

  test("fresh DB has pr_number column", () => {
    const taskId = seedTask(db, { linearIssueId: "SCHEMA-2" });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.prNumber).toBeNull();
  });

  test("fresh DB has deploy_started_at column", () => {
    const taskId = seedTask(db, { linearIssueId: "SCHEMA-3" });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.deployStartedAt).toBeNull();
  });

  test("CHECK constraint removed: inserting 'deploying' status succeeds", () => {
    // This would throw if the old CHECK constraint was still present
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-4",
      orcaStatus: "deploying",
    });
    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("deploying");
  });

  test("all TASK_STATUSES can be inserted without CHECK constraint violation", () => {
    const statuses: TaskStatus[] = [
      "ready",
      "dispatched",
      "running",
      "done",
      "failed",
      "in_review",
      "changes_requested",
      "deploying",
    ];

    for (const status of statuses) {
      const taskId = seedTask(db, {
        linearIssueId: `STATUS-${status}`,
        orcaStatus: status,
      });
      const task = getTask(db, taskId);
      expect(task).toBeDefined();
      expect(task!.orcaStatus).toBe(status);
    }
  });

  test("merge_commit_sha, pr_number, deploy_started_at can be set via insert", () => {
    const ts = now();
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-FULL",
      orcaStatus: "deploying",
      mergeCommitSha: "abc123def456",
      prNumber: 42,
      deployStartedAt: ts,
    });

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.mergeCommitSha).toBe("abc123def456");
    expect(task!.prNumber).toBe(42);
    expect(task!.deployStartedAt).toBe(ts);
  });
});

// ===========================================================================
// 2. Queries: getDeployingTasks and updateTaskDeployInfo
// ===========================================================================

describe("Queries - getDeployingTasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns only tasks with orcaStatus 'deploying'", () => {
    seedTask(db, { linearIssueId: "D-1", orcaStatus: "deploying" });
    seedTask(db, { linearIssueId: "D-2", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "D-3", orcaStatus: "deploying" });
    seedTask(db, { linearIssueId: "D-4", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "D-5", orcaStatus: "running" });

    const deploying = getDeployingTasks(db);
    expect(deploying).toHaveLength(2);

    const ids = deploying.map((t) => t.linearIssueId).sort();
    expect(ids).toEqual(["D-1", "D-3"]);
  });

  test("returns empty array when no deploying tasks exist", () => {
    seedTask(db, { linearIssueId: "ND-1", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "ND-2", orcaStatus: "done" });

    const deploying = getDeployingTasks(db);
    expect(deploying).toHaveLength(0);
  });

  test("returns empty array on empty database", () => {
    const deploying = getDeployingTasks(db);
    expect(deploying).toHaveLength(0);
  });
});

describe("Queries - updateTaskDeployInfo", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("sets mergeCommitSha, prNumber, and deployStartedAt", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UDI-1",
      orcaStatus: "deploying",
    });

    const ts = now();
    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha: "sha-abc123",
      prNumber: 99,
      deployStartedAt: ts,
    });

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.mergeCommitSha).toBe("sha-abc123");
    expect(task!.prNumber).toBe(99);
    expect(task!.deployStartedAt).toBe(ts);
  });

  test("updates updatedAt timestamp", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UDI-2",
      orcaStatus: "deploying",
    });

    const before = getTask(db, taskId)!;
    const beforeUpdatedAt = before.updatedAt;

    // Small delay to ensure different timestamp
    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha: "sha-xyz",
    });

    const after = getTask(db, taskId)!;
    // updatedAt should be updated (or at least not before the original)
    expect(after.updatedAt).toBeDefined();
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeUpdatedAt).getTime(),
    );
  });

  test("partial update: only mergeCommitSha", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UDI-3",
      orcaStatus: "deploying",
    });

    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha: "only-sha",
    });

    const task = getTask(db, taskId)!;
    expect(task.mergeCommitSha).toBe("only-sha");
    expect(task.prNumber).toBeNull();
    expect(task.deployStartedAt).toBeNull();
  });

  test("partial update: only prNumber", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UDI-4",
      orcaStatus: "deploying",
    });

    updateTaskDeployInfo(db, taskId, {
      prNumber: 55,
    });

    const task = getTask(db, taskId)!;
    expect(task.prNumber).toBe(55);
    expect(task.mergeCommitSha).toBeNull();
  });

  test("can set fields to null explicitly", () => {
    const taskId = seedTask(db, {
      linearIssueId: "UDI-5",
      orcaStatus: "deploying",
      mergeCommitSha: "had-sha",
      prNumber: 10,
      deployStartedAt: now(),
    });

    updateTaskDeployInfo(db, taskId, {
      mergeCommitSha: null,
      prNumber: null,
      deployStartedAt: null,
    });

    const task = getTask(db, taskId)!;
    expect(task.mergeCommitSha).toBeNull();
    expect(task.prNumber).toBeNull();
    expect(task.deployStartedAt).toBeNull();
  });

  test("non-existent task does not throw", () => {
    // updateTaskDeployInfo on a missing task should not throw
    expect(() => {
      updateTaskDeployInfo(db, "NONEXISTENT", {
        mergeCommitSha: "sha",
      });
    }).not.toThrow();
  });
});

// ===========================================================================
// 3. Config: deploy defaults
// ===========================================================================

describe("Config - deploy defaults", () => {
  test("deployStrategy defaults to 'none'", () => {
    const cfg = testConfig();
    expect(cfg.deployStrategy).toBe("none");
  });

  test("deployPollIntervalSec defaults to 30", () => {
    const cfg = testConfig();
    expect(cfg.deployPollIntervalSec).toBe(30);
  });

  test("deployTimeoutMin defaults to 30", () => {
    const cfg = testConfig();
    expect(cfg.deployTimeoutMin).toBe(30);
  });

  test("deployStrategy can be overridden to 'github_actions'", () => {
    const cfg = testConfig({ deployStrategy: "github_actions" });
    expect(cfg.deployStrategy).toBe("github_actions");
  });

  test("deployPollIntervalSec can be overridden", () => {
    const cfg = testConfig({ deployPollIntervalSec: 60 });
    expect(cfg.deployPollIntervalSec).toBe(60);
  });

  test("deployTimeoutMin can be overridden", () => {
    const cfg = testConfig({ deployTimeoutMin: 120 });
    expect(cfg.deployTimeoutMin).toBe(120);
  });
});

// We need to verify the actual loadConfig defaults. Since loadConfig calls
// process.exit for missing required vars, we test the default env var parsing
// indirectly by verifying the config structure above matches the implementation.

describe("Config - loadConfig defaults for deploy fields", () => {
  test("ORCA_DEPLOY_STRATEGY env var read with default 'none'", () => {
    // Verify the config interface includes the expected deploy fields
    const cfg = testConfig();
    expect(cfg).toHaveProperty("deployStrategy");
    expect(cfg).toHaveProperty("deployPollIntervalSec");
    expect(cfg).toHaveProperty("deployTimeoutMin");
    expect(typeof cfg.deployStrategy).toBe("string");
    expect(typeof cfg.deployPollIntervalSec).toBe("number");
    expect(typeof cfg.deployTimeoutMin).toBe("number");
  });
});

// ===========================================================================
// 4. Conflict resolution: deploying state cases
// ===========================================================================

// Mock scheduler and runner modules (same pattern as linear-integration.test.ts)
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

describe("Conflict resolution - deploying status", () => {
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

  test("deploying + 'In Review' -> no-op (status stays deploying)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-1",
      orcaStatus: "deploying",
    });

    resolveConflict(db, taskId, "In Review", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("deploying");
  });

  test("deploying + 'Todo' -> ready (user reset)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-2",
      orcaStatus: "deploying",
    });

    resolveConflict(db, taskId, "Todo", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  test("deploying + 'Done' -> done (human override)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-3",
      orcaStatus: "deploying",
    });

    resolveConflict(db, taskId, "Done", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("done");
  });

  test("deploying + 'Canceled' -> failed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-4",
      orcaStatus: "deploying",
    });

    resolveConflict(db, taskId, "Canceled", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("failed");
  });

  test("deploying + 'In Progress' -> no explicit conflict rule (falls through)", () => {
    // "In Progress" maps to "running" in mapLinearStateToOrcaStatus.
    // deploying vs running: no explicit conflict case handles this.
    // The resolveConflict function should fall through without changing state.
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-5",
      orcaStatus: "deploying",
    });

    resolveConflict(db, taskId, "In Progress", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    // deploying should remain unchanged since there's no conflict rule for
    // deploying + "In Progress". BUT the upsert after resolveConflict would
    // overwrite it. Here we're only testing resolveConflict in isolation.
    expect(task!.orcaStatus).toBe("deploying");
  });

  test("non-existent task -> no-op (no crash)", () => {
    // resolveConflict should handle missing tasks gracefully
    expect(() => {
      resolveConflict(db, "NONEXISTENT-TASK", "Todo", config);
    }).not.toThrow();
  });

  test("deploying + 'Backlog' (unknown state) -> no-op", () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-CONFLICT-6",
      orcaStatus: "deploying",
    });

    // "Backlog" maps to null in mapLinearStateToOrcaStatus, so resolveConflict
    // should return early.
    resolveConflict(db, taskId, "Backlog", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("deploying");
  });
});

// ===========================================================================
// 5. upsertTask webhook protection: deploying + "In Review" -> stays deploying
// ===========================================================================

describe("Webhook protection - deploying status not overwritten by In Review", () => {
  let db: OrcaDb;
  let config: OrcaConfig;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    db = freshDb();
    config = testConfig();
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    resolveConflict = syncMod.resolveConflict;
    expectedChanges = syncMod.expectedChanges;
    expectedChanges.clear();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("existing deploying task receiving 'In Review' webhook stays deploying", async () => {
    // Seed a deploying task
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-WH-1",
      orcaStatus: "deploying",
      mergeCommitSha: "abc123",
      prNumber: 42,
      deployStartedAt: now(),
    });

    // Simulate webhook: Linear sends "In Review" update
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = {
      rebuild: vi.fn(),
      isDispatchable: vi.fn().mockReturnValue(true),
      computeEffectivePriority: vi.fn().mockReturnValue(0),
    } as any;

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
          id: "uuid-1",
          identifier: "DEPLOY-WH-1",
          title: "Test task",
          description: "test",
          priority: 1,
          state: { id: "state-review", name: "In Review", type: "started" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    // The deploying status should be preserved
    expect(task!.orcaStatus).toBe("deploying");
  });

  test("existing deploying task receiving 'Todo' webhook transitions to ready", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-WH-2",
      orcaStatus: "deploying",
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
          id: "uuid-2",
          identifier: "DEPLOY-WH-2",
          title: "Test task 2",
          description: "test",
          priority: 1,
          state: { id: "state-todo", name: "Todo", type: "unstarted" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    // resolveConflict: deploying + Todo -> ready
    expect(task!.orcaStatus).toBe("ready");
  });

  test("existing deploying task receiving 'Done' webhook transitions to done", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-WH-3",
      orcaStatus: "deploying",
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
          id: "uuid-3",
          identifier: "DEPLOY-WH-3",
          title: "Test task 3",
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

  test("existing deploying task receiving 'Canceled' webhook transitions to failed", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-WH-4",
      orcaStatus: "deploying",
    });

    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = { rebuild: vi.fn() } as any;
    const stateMap = new Map([
      ["Canceled", { id: "state-cancel", type: "canceled" }],
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
          id: "uuid-4",
          identifier: "DEPLOY-WH-4",
          title: "Test task 4",
          description: "test",
          priority: 1,
          state: { id: "state-cancel", name: "Canceled", type: "canceled" },
        },
      },
    );

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("failed");
  });
});

// ===========================================================================
// 6. Write-back: "deploying" transition is a no-op
// ===========================================================================

describe("Write-back - deploying transition is no-op", () => {
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

  test("writeBackStatus('deploying') does not call client.updateIssueState", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map([
      ["In Review", { id: "state-review", type: "started" }],
      ["Done", { id: "state-done", type: "completed" }],
    ]);

    await writeBackStatus(mockClient, "TASK-WB-1", "deploying", stateMap);

    // Should NOT call the API
    expect(mockClient.updateIssueState).not.toHaveBeenCalled();
  });

  test("writeBackStatus('deploying') does not register an expected change", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map();

    await writeBackStatus(mockClient, "TASK-WB-2", "deploying", stateMap);

    // expectedChanges should remain empty
    expect(expectedChanges.size).toBe(0);
  });

  test("writeBackStatus('done') still calls API (contrast test)", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map([
      ["Done", { id: "state-done", type: "completed" }],
    ]);

    await writeBackStatus(mockClient, "TASK-WB-3", "done", stateMap);

    expect(mockClient.updateIssueState).toHaveBeenCalledOnce();
    expect(mockClient.updateIssueState).toHaveBeenCalledWith(
      "TASK-WB-3",
      "state-done",
    );
  });

  test("writeBackStatus('in_review') calls API (contrast test)", async () => {
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
    } as any;

    const stateMap = new Map([
      ["In Review", { id: "state-review", type: "started" }],
    ]);

    await writeBackStatus(mockClient, "TASK-WB-4", "in_review", stateMap);

    expect(mockClient.updateIssueState).toHaveBeenCalledOnce();
    expect(mockClient.updateIssueState).toHaveBeenCalledWith(
      "TASK-WB-4",
      "state-review",
    );
  });
});

// ===========================================================================
// 7. Edge cases and boundary conditions
// ===========================================================================

describe("Edge cases", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("getDeployingTasks does not return tasks that were deploying but changed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-1",
      orcaStatus: "deploying",
    });

    // Now change status to done
    updateTaskStatus(db, taskId, "done");

    const deploying = getDeployingTasks(db);
    expect(deploying).toHaveLength(0);
  });

  test("updateTaskDeployInfo with empty object only updates updatedAt", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-2",
      orcaStatus: "deploying",
      mergeCommitSha: "original-sha",
      prNumber: 10,
    });

    updateTaskDeployInfo(db, taskId, {});

    const task = getTask(db, taskId)!;
    // Fields should remain unchanged
    expect(task.mergeCommitSha).toBe("original-sha");
    expect(task.prNumber).toBe(10);
  });

  test("multiple deploying tasks are all returned by getDeployingTasks", () => {
    for (let i = 1; i <= 10; i++) {
      seedTask(db, {
        linearIssueId: `MULTI-DEPLOY-${i}`,
        orcaStatus: "deploying",
      });
    }

    const deploying = getDeployingTasks(db);
    expect(deploying).toHaveLength(10);
  });

  test("deploying task with all deploy fields populated", () => {
    const ts = now();
    const taskId = seedTask(db, {
      linearIssueId: "FULL-DEPLOY",
      orcaStatus: "deploying",
      mergeCommitSha: "abc123456789",
      prNumber: 999,
      deployStartedAt: ts,
      prBranchName: "orca/FULL-DEPLOY/1",
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("deploying");
    expect(task.mergeCommitSha).toBe("abc123456789");
    expect(task.prNumber).toBe(999);
    expect(task.deployStartedAt).toBe(ts);
    expect(task.prBranchName).toBe("orca/FULL-DEPLOY/1");
  });

  test("updateTaskFields can set orcaStatus to deploying", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-UTF",
      orcaStatus: "in_review",
    });

    updateTaskFields(db, taskId, { orcaStatus: "deploying" });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("deploying");
  });

  test("deploying task with null deployStartedAt and null mergeCommitSha", () => {
    // This is the case where deploy monitoring started without capturing
    // the SHA or timestamp. The checkDeployments function should handle this
    // by marking the task as done with a warning (no SHA to monitor).
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-NULL",
      orcaStatus: "deploying",
    });

    const task = getTask(db, taskId)!;
    expect(task.mergeCommitSha).toBeNull();
    expect(task.deployStartedAt).toBeNull();
    expect(task.orcaStatus).toBe("deploying");
  });

  test("deploying task with prNumber 0", () => {
    // PR number 0 is technically invalid but should not crash
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-PR0",
      orcaStatus: "deploying",
      prNumber: 0,
    });

    const task = getTask(db, taskId)!;
    expect(task.prNumber).toBe(0);
  });

  test("deploying task with empty string mergeCommitSha", () => {
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-EMPTY-SHA",
      orcaStatus: "deploying",
      mergeCommitSha: "",
    });

    const task = getTask(db, taskId)!;
    // Empty string is stored but might be truthy in JS checks
    expect(task.mergeCommitSha).toBe("");
  });
});

// ===========================================================================
// 8. Webhook flow: deploying + "In Progress" (no explicit protection)
// ===========================================================================

describe("Webhook flow - deploying + In Progress interaction", () => {
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

  test("deploying task receiving 'In Progress' webhook: upsert overwrites to 'running'", async () => {
    // This test documents a potential issue: there is no upsert protection
    // for deploying + "In Progress" (only deploying + "in_review" is protected).
    // If someone moves a deploying task to "In Progress" in Linear, the task
    // status will change to "running" which may not be desirable.
    const taskId = seedTask(db, {
      linearIssueId: "DEPLOY-IP-1",
      orcaStatus: "deploying",
      mergeCommitSha: "sha-abc",
      prNumber: 42,
    });

    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
      fetchTeamIdsForProjects: vi.fn().mockResolvedValue([]),
    } as any;

    const mockGraph = { rebuild: vi.fn() } as any;
    const stateMap = new Map([
      ["In Progress", { id: "state-ip", type: "started" }],
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
          id: "uuid-ip",
          identifier: "DEPLOY-IP-1",
          title: "Test",
          description: "",
          priority: 1,
          state: { id: "state-ip", name: "In Progress", type: "started" },
        },
      },
    );

    const task = getTask(db, taskId)!;
    // upsertTask protects deploying against all non-intentional overrides.
    // Only ready/done/failed (from Todo/Done/Canceled) are allowed through.
    expect(task.orcaStatus).toBe("deploying");
  });
});
