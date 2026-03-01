// ---------------------------------------------------------------------------
// Tests for closePrsForTask and its integration with Linear cancellation flows
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Required because sync.ts imports from scheduler and runner
vi.mock("../src/scheduler/index.js", () => ({ activeHandles: new Map() }));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

// Mock child_process.execFile (used by ghAsync via promisify)
// We use vi.hoisted so the mock fn is available at vi.mock time.
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

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
    orcaStatus: "ready" | "dispatched" | "running" | "done" | "failed" | "in_review";
    priority: number;
    retryCount: number;
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
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

/**
 * Simulate successful `execFile` callback for ghAsync (promisified).
 *
 * promisify(execFile) calls execFile(cmd, args, opts, callback)
 * The callback is always the last argument.
 */
function simulateGhSuccess(stdout: string): void {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    process.nextTick(() => callback(null, { stdout, stderr: "" }));
  });
}

function simulateGhError(message: string): void {
  mockExecFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null) => void;
    const err = new Error(message) as Error & { stderr: string };
    err.stderr = message;
    process.nextTick(() => callback(err));
  });
}

/**
 * Enqueue a sequence of gh responses. Each call to mockExecFile
 * will pop and apply the next response.
 */
function simulateGhSequence(
  responses: Array<{ stdout: string } | { error: string }>,
): void {
  for (const resp of responses) {
    if ("error" in resp) {
      simulateGhError(resp.error);
    } else {
      simulateGhSuccess(resp.stdout);
    }
  }
}

// ===========================================================================
// Unit tests for closePrsForTask
// ===========================================================================

describe("closePrsForTask - unit tests", () => {
  let closePrsForTask: typeof import("../src/github/index.js").closePrsForTask;

  beforeEach(async () => {
    mockExecFile.mockReset();
    const mod = await import("../src/github/index.js");
    closePrsForTask = mod.closePrsForTask;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("happy path: closes multiple open PRs matching the task branch pattern", async () => {
    const prListOutput = JSON.stringify([
      { number: 42, headRefName: "orca/EMI-95-inv-1", url: "https://github.com/org/repo/pull/42" },
      { number: 43, headRefName: "orca/EMI-95-inv-2", url: "https://github.com/org/repo/pull/43" },
    ]);

    simulateGhSequence([
      { stdout: prListOutput },  // pr list
      { stdout: "" },            // pr close #42
      { stdout: "" },            // pr close #43
    ]);

    await closePrsForTask("EMI-95", "/tmp/repo");

    // Should have made 3 calls: 1 list + 2 closes
    expect(mockExecFile).toHaveBeenCalledTimes(3);

    // Verify the list call args
    const listArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(listArgs).toContain("pr");
    expect(listArgs).toContain("list");
    expect(listArgs).toContain("--search");
    expect(listArgs).toContain("head:orca/EMI-95-");
    expect(listArgs).toContain("--state");
    expect(listArgs).toContain("open");

    // Verify close call for PR #42
    const closeArgs1 = mockExecFile.mock.calls[1][1] as string[];
    expect(closeArgs1).toContain("close");
    expect(closeArgs1).toContain("42");
    expect(closeArgs1).toContain("--delete-branch");

    // Verify close call for PR #43
    const closeArgs2 = mockExecFile.mock.calls[2][1] as string[];
    expect(closeArgs2).toContain("close");
    expect(closeArgs2).toContain("43");
  });

  test("no open PRs: logs message and makes no close calls", async () => {
    simulateGhSuccess(JSON.stringify([]));

    await closePrsForTask("EMI-100", "/tmp/repo");

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("no open PRs found for canceled task EMI-100"),
    );
  });

  test("gh pr list fails: does not throw, logs warning", async () => {
    simulateGhError("gh: command not found");

    await expect(closePrsForTask("EMI-101", "/tmp/repo")).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to list PRs for canceled task EMI-101"),
    );
  });

  test("one PR close fails, other still gets closed", async () => {
    const prListOutput = JSON.stringify([
      { number: 50, headRefName: "orca/EMI-102-inv-1", url: "https://github.com/org/repo/pull/50" },
      { number: 51, headRefName: "orca/EMI-102-inv-2", url: "https://github.com/org/repo/pull/51" },
    ]);

    simulateGhSequence([
      { stdout: prListOutput },       // pr list succeeds
      { error: "PR already closed" }, // pr close #50 fails
      { stdout: "" },                 // pr close #51 succeeds
    ]);

    await closePrsForTask("EMI-102", "/tmp/repo");

    expect(mockExecFile).toHaveBeenCalledTimes(3);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to close PR #50"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("closed PR #51"),
    );
  });

  test("close comment text includes the task ID and 'canceled'", async () => {
    const prListOutput = JSON.stringify([
      { number: 60, headRefName: "orca/EMI-103-inv-1", url: "https://github.com/org/repo/pull/60" },
    ]);

    simulateGhSequence([
      { stdout: prListOutput },
      { stdout: "" },
    ]);

    await closePrsForTask("EMI-103", "/tmp/repo");

    const closeArgs = mockExecFile.mock.calls[1][1] as string[];
    const commentIdx = closeArgs.indexOf("--comment");
    expect(commentIdx).toBeGreaterThan(-1);
    const commentText = closeArgs[commentIdx + 1] as string;
    expect(commentText).toContain("EMI-103");
    expect(commentText).toContain("canceled");
  });

  test("cwd is passed through to all gh calls", async () => {
    simulateGhSuccess(JSON.stringify([]));

    await closePrsForTask("EMI-104", "/my/custom/repo");

    const listOpts = mockExecFile.mock.calls[0][2] as { cwd?: string };
    expect(listOpts.cwd).toBe("/my/custom/repo");
  });

  test("malformed JSON from gh pr list: does not throw, logs warning", async () => {
    simulateGhSuccess("not valid json {{{");

    await expect(closePrsForTask("EMI-105", "/tmp/repo")).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to list PRs for canceled task EMI-105"),
    );
  });

  test("limit of 10 is passed to gh pr list", async () => {
    simulateGhSuccess(JSON.stringify([]));

    await closePrsForTask("EMI-106", "/tmp/repo");

    const listArgs = mockExecFile.mock.calls[0][1] as string[];
    const limitIdx = listArgs.indexOf("--limit");
    expect(limitIdx).toBeGreaterThan(-1);
    expect(listArgs[limitIdx + 1]).toBe("10");
  });

  test("prefix matching: filters out PRs for unrelated tasks", async () => {
    // GitHub search may return fuzzy matches, so client-side filtering is needed.
    // Canceling EMI-9 should NOT close PRs for EMI-95.
    const prListOutput = JSON.stringify([
      { number: 70, headRefName: "orca/EMI-9-inv-1", url: "https://github.com/org/repo/pull/70" },
      { number: 71, headRefName: "orca/EMI-95-inv-1", url: "https://github.com/org/repo/pull/71" },
    ]);

    simulateGhSequence([
      { stdout: prListOutput },
      { stdout: "" },  // close #70 only
    ]);

    await closePrsForTask("EMI-9", "/tmp/repo");

    // Only PR #70 should be closed (orca/EMI-9-inv-1 matches prefix orca/EMI-9-)
    // PR #71 (orca/EMI-95-inv-1) should be filtered out
    expect(mockExecFile).toHaveBeenCalledTimes(2); // list + 1 close
    const closeArgs = mockExecFile.mock.calls[1][1] as string[];
    expect(closeArgs).toContain("70");
  });

  test("all close calls fail: logs warnings but does not throw", async () => {
    const prs = [
      { number: 200, headRefName: "orca/EMI-114-inv-1", url: "https://github.com/org/repo/pull/200" },
      { number: 201, headRefName: "orca/EMI-114-inv-2", url: "https://github.com/org/repo/pull/201" },
    ];

    simulateGhSequence([
      { stdout: JSON.stringify(prs) },
      { error: "PR is already closed" },
      { error: "network timeout" },
    ]);

    await expect(closePrsForTask("EMI-114", "/tmp/repo")).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to close PR #200"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to close PR #201"),
    );
  });

  test("exactly 10 PRs returned: all matching ones get closed", async () => {
    const prs = Array.from({ length: 10 }, (_, i) => ({
      number: 100 + i,
      headRefName: `orca/EMI-113-inv-${i}`,
      url: `https://github.com/org/repo/pull/${100 + i}`,
    }));

    const responses: Array<{ stdout: string } | { error: string }> = [
      { stdout: JSON.stringify(prs) },
      ...Array.from({ length: 10 }, () => ({ stdout: "" })),
    ];
    simulateGhSequence(responses);

    await closePrsForTask("EMI-113", "/tmp/repo");

    // 1 list + 10 closes = 11
    expect(mockExecFile).toHaveBeenCalledTimes(11);
  });

  test("gh returns unexpected extra fields: still works", async () => {
    const prListOutput = JSON.stringify([
      {
        number: 80,
        headRefName: "orca/EMI-110-inv-1",
        url: "https://github.com/org/repo/pull/80",
        extraField: "unexpected",
      },
    ]);

    simulateGhSequence([
      { stdout: prListOutput },
      { stdout: "" },
    ]);

    await closePrsForTask("EMI-110", "/tmp/repo");
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  test("PRs returned by search but not matching prefix are filtered out", async () => {
    // All returned PRs have different task IDs — none match orca/EMI-50-
    const prListOutput = JSON.stringify([
      { number: 90, headRefName: "orca/EMI-500-inv-1", url: "https://github.com/org/repo/pull/90" },
      { number: 91, headRefName: "orca/EMI-5-inv-1", url: "https://github.com/org/repo/pull/91" },
    ]);

    simulateGhSuccess(prListOutput);

    await closePrsForTask("EMI-50", "/tmp/repo");

    // Only the list call, no close calls (both filtered out)
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("no open PRs found for canceled task EMI-50"),
    );
  });
});

// ===========================================================================
// Integration tests: cancellation flow in sync.ts
// ===========================================================================

describe("closePrsForTask integration with cancellation flow", () => {
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let db: OrcaDb;
  let config: OrcaConfig;

  beforeEach(async () => {
    mockExecFile.mockReset();
    db = freshDb();
    config = testConfig();

    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    fullSync = syncMod.fullSync;
    processWebhookEvent = syncMod.processWebhookEvent;

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("resolveConflict with Canceled state calls closePrsForTask (gh invoked)", () => {
    // Set up a mock that will be called when closePrsForTask invokes ghAsync
    simulateGhSuccess(JSON.stringify([])); // pr list returns empty

    seedTask(db, {
      linearIssueId: "CANCEL-1",
      orcaStatus: "running",
      repoPath: "/tmp/my-repo",
    });

    resolveConflict(db, "CANCEL-1", "Canceled", config);

    // Task should be failed
    const task = getTask(db, "CANCEL-1");
    expect(task!.orcaStatus).toBe("failed");

    // closePrsForTask was called (fire-and-forget), which calls ghAsync
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        const args = mockExecFile.mock.calls[0][1] as string[];
        expect(args).toContain("head:orca/CANCEL-1-");
        const opts = mockExecFile.mock.calls[0][2] as { cwd?: string };
        expect(opts.cwd).toBe("/tmp/my-repo");
        resolve();
      }, 50);
    });
  });

  test("resolveConflict with non-Canceled state does NOT call closePrsForTask", () => {
    seedTask(db, {
      linearIssueId: "NOCANCEL-1",
      orcaStatus: "running",
    });

    resolveConflict(db, "NOCANCEL-1", "Todo", config);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(mockExecFile).not.toHaveBeenCalled();
        resolve();
      }, 50);
    });
  });

  test("resolveConflict with Canceled for non-existent task: no closePrsForTask call", () => {
    resolveConflict(db, "NONEXISTENT-1", "Canceled", config);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(mockExecFile).not.toHaveBeenCalled();
        resolve();
      }, 50);
    });
  });

  test("fullSync with Canceled issue calls closePrsForTask once", async () => {
    seedTask(db, {
      linearIssueId: "SYNC-CANCEL",
      orcaStatus: "running",
      repoPath: "/tmp/repo",
    });

    simulateGhSuccess(JSON.stringify([])); // pr list returns empty

    const mockClient = {
      fetchProjectIssues: vi.fn().mockResolvedValue([
        {
          id: "issue-id",
          identifier: "SYNC-CANCEL",
          title: "Canceled issue",
          description: "",
          priority: 1,
          state: { id: "s-cancel", name: "Canceled", type: "canceled" },
          teamId: "team-1",
          projectId: "proj-1",
          relations: [],
          inverseRelations: [],
          parentId: null,
          parentTitle: null,
          parentDescription: null,
          projectName: "Test Project",
          childIds: [],
        },
      ]),
      fetchWorkflowStates: vi.fn(),
      updateIssueState: vi.fn(),
    };
    const mockGraph = { rebuild: vi.fn() };

    await fullSync(db, mockClient as any, mockGraph as any, config);

    // Wait for fire-and-forget async call to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("head:orca/SYNC-CANCEL-");
  });

  test("fullSync with Canceled issue and no existing task: no closePrsForTask call", async () => {
    // No task seeded -- the Canceled issue should be skipped entirely

    const mockClient = {
      fetchProjectIssues: vi.fn().mockResolvedValue([
        {
          id: "issue-id",
          identifier: "NEW-CANCEL",
          title: "New canceled issue",
          description: "",
          priority: 1,
          state: { id: "s-cancel", name: "Canceled", type: "canceled" },
          teamId: "team-1",
          projectId: "proj-1",
          relations: [],
          inverseRelations: [],
          parentId: null,
          parentTitle: null,
          parentDescription: null,
          projectName: "Test Project",
          childIds: [],
        },
      ]),
      fetchWorkflowStates: vi.fn(),
      updateIssueState: vi.fn(),
    };
    const mockGraph = { rebuild: vi.fn() };

    await fullSync(db, mockClient as any, mockGraph as any, config);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecFile).not.toHaveBeenCalled();

    // Task should NOT have been created
    const task = getTask(db, "NEW-CANCEL");
    expect(task).toBeUndefined();
  });

  test("processWebhookEvent Canceled calls closePrsForTask only once (no double call)", async () => {
    seedTask(db, {
      linearIssueId: "DOUBLE-CLOSE",
      orcaStatus: "running",
      repoPath: "/tmp/repo",
    });

    // Only one gh response needed — closePrsForTask should fire only once
    simulateGhSuccess(JSON.stringify([]));

    const mockClient = {
      fetchProjectIssues: vi.fn(),
      fetchWorkflowStates: vi.fn(),
      updateIssueState: vi.fn(),
    };
    const mockGraph = {
      rebuild: vi.fn(),
      isDispatchable: vi.fn(),
    };
    const stateMap = new Map();

    const event = {
      action: "update" as const,
      type: "Issue",
      data: {
        id: "issue-id",
        identifier: "DOUBLE-CLOSE",
        title: "Test issue",
        priority: 1,
        state: { id: "s-cancel", name: "Canceled", type: "canceled" },
        projectId: "proj-1",
      },
    };

    await processWebhookEvent(
      db,
      mockClient as any,
      mockGraph as any,
      config,
      stateMap,
      event,
    );

    // Wait for fire-and-forget async calls to settle
    await new Promise((r) => setTimeout(r, 100));

    // resolveConflict fires closePrsForTask and sets task to "failed".
    // upsertTask sees task is already "failed" and skips — no double call.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  test("upsertTask uses task's stored repoPath, not config defaultCwd", async () => {
    seedTask(db, {
      linearIssueId: "REPO-PATH",
      orcaStatus: "running",
      repoPath: "/custom/repo/path",
    });

    simulateGhSuccess(JSON.stringify([]));

    const mockClient = {
      fetchProjectIssues: vi.fn().mockResolvedValue([
        {
          id: "issue-id",
          identifier: "REPO-PATH",
          title: "Test",
          description: "",
          priority: 1,
          state: { id: "s-cancel", name: "Canceled", type: "canceled" },
          teamId: "team-1",
          projectId: "proj-1",
          relations: [],
          inverseRelations: [],
          parentId: null,
          parentTitle: null,
          parentDescription: null,
          projectName: "",
          childIds: [],
        },
      ]),
      fetchWorkflowStates: vi.fn(),
      updateIssueState: vi.fn(),
    };
    const mockGraph = { rebuild: vi.fn() };

    await fullSync(db, mockClient as any, mockGraph as any, config);
    await new Promise((r) => setTimeout(r, 50));

    // closePrsForTask should use the task's repoPath from DB, not config.defaultCwd
    const opts = mockExecFile.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe("/custom/repo/path");
  });

  test("closePrsForTask rejection is caught by .catch() -- does not crash", async () => {
    seedTask(db, {
      linearIssueId: "REJECT-TEST",
      orcaStatus: "running",
      repoPath: "/tmp/repo",
    });

    // Make ghAsync throw -- closePrsForTask catches internally
    simulateGhError("catastrophic failure");

    const mockClient = {
      fetchProjectIssues: vi.fn().mockResolvedValue([
        {
          id: "issue-id",
          identifier: "REJECT-TEST",
          title: "Test",
          description: "",
          priority: 1,
          state: { id: "s-cancel", name: "Canceled", type: "canceled" },
          teamId: "team-1",
          projectId: "proj-1",
          relations: [],
          inverseRelations: [],
          parentId: null,
          parentTitle: null,
          parentDescription: null,
          projectName: "",
          childIds: [],
        },
      ]),
      fetchWorkflowStates: vi.fn(),
      updateIssueState: vi.fn(),
    };
    const mockGraph = { rebuild: vi.fn() };

    // Should not throw
    await expect(
      fullSync(db, mockClient as any, mockGraph as any, config),
    ).resolves.not.toThrow();

    // Task should still be updated to failed
    const task = getTask(db, "REJECT-TEST");
    expect(task!.orcaStatus).toBe("failed");
  });

  test("resolveConflict closePrsForTask rejection does not crash", () => {
    simulateGhError("gh not installed");

    const taskId = seedTask(db, {
      linearIssueId: "REJECT-RESOLVE",
      orcaStatus: "running",
      repoPath: "/tmp/repo",
    });

    // resolveConflict is synchronous, closePrsForTask is fire-and-forget
    expect(() => resolveConflict(db, taskId, "Canceled", config)).not.toThrow();

    const task = getTask(db, taskId);
    expect(task!.orcaStatus).toBe("failed");
  });

  test("resolveConflict Canceled for already-failed task still calls closePrsForTask", () => {
    simulateGhSuccess(JSON.stringify([]));

    seedTask(db, {
      linearIssueId: "ALREADY-FAILED",
      orcaStatus: "failed",
      repoPath: "/tmp/repo",
    });

    resolveConflict(db, "ALREADY-FAILED", "Canceled", config);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // closePrsForTask is called even for already-failed tasks via resolveConflict
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        resolve();
      }, 50);
    });
  });

  test("resolveConflict Canceled for 'done' task: closes PRs and sets failed", () => {
    simulateGhSuccess(JSON.stringify([]));

    seedTask(db, {
      linearIssueId: "DONE-CANCEL",
      orcaStatus: "done",
      repoPath: "/tmp/repo",
    });

    resolveConflict(db, "DONE-CANCEL", "Canceled", config);

    const task = getTask(db, "DONE-CANCEL");
    expect(task!.orcaStatus).toBe("failed");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(mockExecFile).toHaveBeenCalledTimes(1);
        resolve();
      }, 50);
    });
  });
});
