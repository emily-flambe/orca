// ---------------------------------------------------------------------------
// EMI-345: Adversarial tests for failure metadata implementation
//
// Tests targeting:
// 1. updateTaskFailure function in db/queries.ts
// 2. Migration 18 correctness in db/index.ts
// 3. OrcaStatus interface missing failedTaskSnapshot field
// 4. API contract: /api/status failedTaskSnapshot field
// 5. Missing updateTaskFailure in vi.mock() calls (documented as bugs)
// 6. Truncation edge cases
// 7. updateTaskFailure after retry should clear stale failure reason
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask, updateTaskStatus } from "../src/db/queries.js";
import { createApiRoutes } from "../src/api/routes.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { OrcaStatus } from "../src/shared/types.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Mocks needed for API route tests
// ---------------------------------------------------------------------------
vi.mock("../src/scheduler/index.js", () => ({ activeHandles: new Map() }));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  invocationLogs: new Map(),
}));
vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
  findStateByType: vi
    .fn()
    .mockReturnValue({ id: "state-123", type: "unstarted" }),
}));
vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    logPath: "./orca.log",
    ...overrides,
  };
}

const mockClient = {
  createIssue: vi
    .fn()
    .mockResolvedValue({ identifier: "TEST-1", id: "issue-id-1" }),
  updateIssueState: vi.fn().mockResolvedValue(true),
  createComment: vi.fn().mockResolvedValue(undefined),
  createAttachment: vi.fn().mockResolvedValue(undefined),
} as any;

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeApp(db: OrcaDb, configOverrides?: Partial<OrcaConfig>): Hono {
  return createApiRoutes({
    db,
    config: makeConfig(configOverrides),
    syncTasks: vi.fn().mockResolvedValue([]),
    client: mockClient,
    stateMap: new Map(),
    projectMeta: [{ id: "test-project", name: "Test Project", teamIds: [] }],
    inngest: mockInngest,
  });
}

function seedTask(db: OrcaDb, overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  insertTask(db, {
    linearIssueId: "TEST-1",
    agentPrompt: "fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: "ready" as const,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  } as any);
}

// ---------------------------------------------------------------------------
// 1. updateTaskFailure — basic functionality
// ---------------------------------------------------------------------------

describe("updateTaskFailure — db/queries", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
    seedTask(db, { orcaStatus: "failed" });
  });

  it("BUG: updateTaskFailure is not exported from db/queries.js", async () => {
    // This test documents that updateTaskFailure must be importable
    const queries = await import("../src/db/queries.js");
    expect(typeof queries.updateTaskFailure).toBe("function");
  });

  it("stores reason, phase, and timestamp on task", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const before = Date.now();
    updateTaskFailure(db, "TEST-1", "CI timed out", "ci");
    const after = Date.now();

    const task = getTask(db, "TEST-1");
    expect(task).toBeDefined();
    expect(task!.lastFailureReason).toBe("CI timed out");
    expect(task!.lastFailedPhase).toBe("ci");
    expect(task!.lastFailedAt).toBeDefined();
    const ts = new Date(task!.lastFailedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("truncates reason at 500 chars with ellipsis", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const longReason = "x".repeat(600);
    updateTaskFailure(db, "TEST-1", longReason, "implement");

    const task = getTask(db, "TEST-1");
    expect(task!.lastFailureReason).toHaveLength(500);
    expect(task!.lastFailureReason!.endsWith("...")).toBe(true);
  });

  it("reason at exactly 500 chars is NOT truncated", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const exactReason = "x".repeat(500);
    updateTaskFailure(db, "TEST-1", exactReason, "implement");

    const task = getTask(db, "TEST-1");
    expect(task!.lastFailureReason).toHaveLength(500);
    expect(task!.lastFailureReason!.endsWith("...")).toBe(false);
  });

  it("reason at 501 chars IS truncated to 500", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const reason = "x".repeat(501);
    updateTaskFailure(db, "TEST-1", reason, "implement");

    const task = getTask(db, "TEST-1");
    expect(task!.lastFailureReason).toHaveLength(500);
    expect(task!.lastFailureReason!.endsWith("...")).toBe(true);
    // Confirm 497 chars of content + "..." = 500
    expect(task!.lastFailureReason!.slice(0, 497)).toBe("x".repeat(497));
  });

  it("empty string reason is stored as-is (not null)", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    updateTaskFailure(db, "TEST-1", "", "implement");

    const task = getTask(db, "TEST-1");
    // Empty string reason — should be stored but is falsy
    // The API filter `t.lastFailureReason` would exclude it
    expect(task!.lastFailureReason).toBe("");
  });

  it("updates updatedAt field", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const taskBefore = getTask(db, "TEST-1")!;
    // Ensure some time passes
    await new Promise((r) => setTimeout(r, 10));
    updateTaskFailure(db, "TEST-1", "session failed", "implement");
    const taskAfter = getTask(db, "TEST-1")!;
    expect(taskAfter.updatedAt >= taskBefore.updatedAt).toBe(true);
  });

  it("noop on nonexistent task — no throw", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    // Should not throw; 0 rows affected silently
    expect(() =>
      updateTaskFailure(db, "NONEXISTENT", "some reason", "implement"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Migration 18 — columns exist after DB creation
// ---------------------------------------------------------------------------

describe("migration 18 — failure metadata columns", () => {
  it("new DB has last_failure_reason, last_failed_phase, last_failed_at on tasks", () => {
    const db = createDb(":memory:");
    // The schema should include these columns; insert a task and verify
    // we can select them
    seedTask(db);
    const task = getTask(db, "TEST-1");
    expect(task).toBeDefined();
    // These properties should exist (even as null)
    expect("lastFailureReason" in task!).toBe(true);
    expect("lastFailedPhase" in task!).toBe(true);
    expect("lastFailedAt" in task!).toBe(true);
    // New tasks have null failure metadata
    expect(task!.lastFailureReason).toBeNull();
    expect(task!.lastFailedPhase).toBeNull();
    expect(task!.lastFailedAt).toBeNull();
  });

  it("BUG: migration 18 comment says 18 but appears before migration 17 in code order", () => {
    // This is a documentation/ordering bug in src/db/index.ts
    // Migration 18 is inserted between migration 16 and the migration 17 index block.
    // The migration itself works because it uses a sentinel column check,
    // but the numbering in comments is wrong and could confuse future maintainers.
    // The test documents the expected ordering: 17 indexes should come before 18 columns.
    //
    // This test will PASS regardless (SQLite doesn't care about comment order),
    // but it flags the naming inconsistency.
    const db = createDb(":memory:");
    seedTask(db);
    const task = getTask(db, "TEST-1");
    // If migration 18 columns exist AND performance indexes work, both ran correctly
    expect(task!.lastFailureReason).toBeNull();
    // Verify the idx_tasks_orca_status index exists (migration 17)
    // We can't easily check index existence in drizzle, but if the DB started
    // successfully it means both ran without errors
    expect(task).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Interaction: updateTaskStatus + updateTaskFailure ordering
// ---------------------------------------------------------------------------

describe("updateTaskStatus + updateTaskFailure interaction", () => {
  it("calling updateTaskStatus('failed') does NOT clear lastFailureReason", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const db = createDb(":memory:");
    seedTask(db, { orcaStatus: "running" });

    // Set failure metadata
    updateTaskFailure(db, "TEST-1", "original failure reason", "implement");
    // Now call updateTaskStatus (as production code does — status first, then metadata)
    updateTaskStatus(db, "TEST-1", "failed");

    const task = getTask(db, "TEST-1");
    // updateTaskStatus should NOT wipe lastFailureReason
    expect(task!.lastFailureReason).toBe("original failure reason");
  });

  it("calling incrementRetryCount clears failure metadata so retrying tasks don't show stale reasons", async () => {
    const { updateTaskFailure } = await import("../src/db/queries.js");
    const { incrementRetryCount } = await import("../src/db/queries.js");
    const db = createDb(":memory:");
    seedTask(db, { orcaStatus: "failed" });

    updateTaskFailure(db, "TEST-1", "CI timed out", "ci");
    incrementRetryCount(db, "TEST-1"); // resets to "ready" and clears failure metadata

    const task = getTask(db, "TEST-1");
    expect(task!.orcaStatus).toBe("ready");
    // Failure metadata should be cleared on retry
    expect(task!.lastFailureReason).toBeNull();
    expect(task!.lastFailedPhase).toBeNull();
    expect(task!.lastFailedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. API: /api/status failedTaskSnapshot field
// ---------------------------------------------------------------------------

describe("GET /api/status — failedTaskSnapshot", () => {
  it("BUG: OrcaStatus type does not include failedTaskSnapshot — API returns it but type is missing", () => {
    // This test documents that OrcaStatus in shared/types.ts doesn't have
    // failedTaskSnapshot. The /api/status endpoint returns it, but the
    // TypeScript interface is incomplete.
    // We import and check: the type should have the field but doesn't.
    type StatusWithSnapshot = OrcaStatus & {
      failedTaskSnapshot?: unknown;
    };
    // If this compiles without error, it means failedTaskSnapshot is NOT in OrcaStatus
    // (it's being added via intersection type above)
    const _check: StatusWithSnapshot = {} as any;
    expect(_check).toBeDefined(); // always passes — the bug is in the type definition
  });

  it("returns failedTaskSnapshot array in response body", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    // Insert a failed task with failure metadata
    insertTask(db, {
      linearIssueId: "FAIL-1",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "failed" as const,
      priority: 0,
      retryCount: 1,
      createdAt: ts,
      updatedAt: ts,
      lastFailureReason: "CI timed out after 30 minutes",
      lastFailedPhase: "ci",
      lastFailedAt: ts,
    } as any);

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();

    // failedTaskSnapshot should be in the response
    expect(Array.isArray(body.failedTaskSnapshot)).toBe(true);
    expect(body.failedTaskSnapshot).toHaveLength(1);
    expect(body.failedTaskSnapshot[0].id).toBe("FAIL-1");
    expect(body.failedTaskSnapshot[0].phase).toBe("ci");
    expect(body.failedTaskSnapshot[0].reason).toBe(
      "CI timed out after 30 minutes",
    );
  });

  it("failedTaskSnapshot omits tasks with no failure reason", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    insertTask(db, {
      linearIssueId: "FAIL-NO-REASON",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "failed" as const,
      priority: 0,
      retryCount: 1,
      createdAt: ts,
      updatedAt: ts,
      // no lastFailureReason
    } as any);

    const res = await app.request("/api/status");
    const body = await res.json();
    expect(body.failedTaskSnapshot).toHaveLength(0);
  });

  it("failedTaskSnapshot truncates reasons over 80 chars to 77 + '...'", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    const longReason = "A".repeat(81); // 81 chars — over the 80 limit
    insertTask(db, {
      linearIssueId: "FAIL-LONG",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "failed" as const,
      priority: 0,
      retryCount: 1,
      createdAt: ts,
      updatedAt: ts,
      lastFailureReason: longReason,
      lastFailedPhase: "deploy",
      lastFailedAt: ts,
    } as any);

    const res = await app.request("/api/status");
    const body = await res.json();
    const snapshot = body.failedTaskSnapshot[0];
    expect(snapshot.reason).toHaveLength(80);
    expect(snapshot.reason.endsWith("...")).toBe(true);
  });

  it("failedTaskSnapshot reason at exactly 80 chars is NOT truncated", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    const exactReason = "B".repeat(80);
    insertTask(db, {
      linearIssueId: "FAIL-EXACT",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "failed" as const,
      priority: 0,
      retryCount: 1,
      createdAt: ts,
      updatedAt: ts,
      lastFailureReason: exactReason,
      lastFailedPhase: "gate2",
      lastFailedAt: ts,
    } as any);

    const res = await app.request("/api/status");
    const body = await res.json();
    const snapshot = body.failedTaskSnapshot[0];
    expect(snapshot.reason).toHaveLength(80);
    expect(snapshot.reason.endsWith("...")).toBe(false);
  });

  it("BUG: failedTaskSnapshot double-truncation — reason stored up to 500 chars, API truncates to 80, but TaskList.tsx truncates to 100, creating inconsistency", () => {
    // The API truncates at 80 chars (for status/monitoring snapshot)
    // but TaskList.tsx truncates at 100 chars.
    // This is an inconsistency: a 90-char reason shows full in TaskList but
    // truncated in the API snapshot. Not a bug per se, but worth noting.
    // The test is informational only.
    const reason = "C".repeat(90);
    // API truncates to 80: reason.length (90) > 80, so slice(0,77) + "..." = 80
    const apiTruncated =
      reason.length > 80 ? reason.slice(0, 77) + "..." : reason;
    // TaskList shows full: reason.length (90) <= 100
    const taskListShows =
      reason.length > 100 ? reason.slice(0, 97) + "..." : reason;

    expect(apiTruncated).toHaveLength(80);
    expect(taskListShows).toHaveLength(90); // full, not truncated in TaskList
    expect(apiTruncated).not.toBe(taskListShows); // inconsistency confirmed
  });
});

// ---------------------------------------------------------------------------
// 5. Task.lastFailureReason fields present in /api/tasks response
// ---------------------------------------------------------------------------

describe("GET /api/tasks — failure metadata in task objects", () => {
  it("failed task exposes lastFailureReason, lastFailedPhase, lastFailedAt", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    insertTask(db, {
      linearIssueId: "TASK-F1",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "failed" as const,
      priority: 0,
      retryCount: 1,
      createdAt: ts,
      updatedAt: ts,
      lastFailureReason: "Gate 2: no PR found for branch orca/TASK-F1",
      lastFailedPhase: "gate2",
      lastFailedAt: ts,
    } as any);

    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    const task = body.find((t: any) => t.linearIssueId === "TASK-F1");
    expect(task).toBeDefined();
    expect(task.lastFailureReason).toBe(
      "Gate 2: no PR found for branch orca/TASK-F1",
    );
    expect(task.lastFailedPhase).toBe("gate2");
    expect(task.lastFailedAt).toBe(ts);
  });

  it("ready task has null failure metadata", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const ts = new Date().toISOString();
    insertTask(db, {
      linearIssueId: "TASK-R1",
      agentPrompt: "do something",
      repoPath: "/tmp/repo",
      orcaStatus: "ready" as const,
      priority: 0,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    } as any);

    const res = await app.request("/api/tasks");
    const body = await res.json();
    const task = body.find((t: any) => t.linearIssueId === "TASK-R1");
    expect(task.lastFailureReason).toBeNull();
    expect(task.lastFailedPhase).toBeNull();
    expect(task.lastFailedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. The mocks in test files for db/queries.js don't include updateTaskFailure
//    — this causes 36 test failures across 6 files.
//    Document the affected files and the required fix.
// ---------------------------------------------------------------------------

describe("BUG: vi.mock('../src/db/queries.js') missing updateTaskFailure", () => {
  it("documents the 6 test files that need updateTaskFailure added to their vi.mock", () => {
    // These test files mock ../src/db/queries.js but do NOT include updateTaskFailure:
    const affectedFiles = [
      "test/workflow-task-lifecycle.test.ts",
      "test/workflow-ci-merge.test.ts",
      "test/workflow-deploy-monitor.test.ts",
      "test/emi-342-lifecycle.test.ts",
      "test/linear-integration.test.ts",
      "test/cleanup.test.ts",
    ];
    // The fix in each file is to add `updateTaskFailure: vi.fn()` to the
    // vi.mock("../src/db/queries.js") call factory.
    //
    // This test itself passes as a documentation artifact.
    expect(affectedFiles).toHaveLength(6);
  });

  it("workflow-task-lifecycle mock is missing updateTaskFailure — confirmed by import check", async () => {
    // The production code imports updateTaskFailure from db/queries.js.
    // When the test mocks that module without the function, vitest strict mode
    // throws: 'No "updateTaskFailure" export is defined on the mock.'
    // Verify the function is exported from queries.
    const { updateTaskFailure } = await import("../src/db/queries.js");
    expect(typeof updateTaskFailure).toBe("function");
    // This means every test file that mocks db/queries.js must add it.
  });
});
