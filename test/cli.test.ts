// ---------------------------------------------------------------------------
// CLI command tests — add, status, and start subcommands
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted — must be at top level)
// ---------------------------------------------------------------------------

const mockInsertTask = vi.fn();
const mockGetAllTasks = vi.fn(() => []);
const mockGetRunningInvocations = vi.fn(() => []);
const mockBudgetWindowStart = vi.fn(() => new Date().toISOString());

// start command mocks
const mockFetchProjectMetadata = vi.fn(() => Promise.resolve([]));
const mockFetchWorkflowStates = vi.fn(() => Promise.resolve(new Map()));
const mockLinearCreateComment = vi.fn(() => Promise.resolve());
const mockFullSync = vi.fn(() => Promise.resolve([]));
vi.mock("../src/db/queries.js", () => ({
  insertTask: mockInsertTask,
  getAllTasks: mockGetAllTasks,
  getRunningInvocations: mockGetRunningInvocations,
  budgetWindowStart: mockBudgetWindowStart,
  updateInvocation: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskFields: vi.fn(),
  clearSessionIds: vi.fn(),
  insertSystemEvent: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock("../src/config/index.js", () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ":memory:",
    budgetWindowHours: 4,
    linearApiKey: "test-key",
    linearProjectIds: [],
    projectRepoMap: new Map(),
    // start command fields
    logPath: "/tmp/orca-test.log",
    port: 4000,
    concurrencyCap: 1,

    externalTunnel: true, // skip cloudflared spawn in tests
    cloudflaredPath: "cloudflared",
    tunnelToken: undefined,
  })),
  parseRepoPath: vi.fn(),
  validateProjectRepoPaths: vi.fn(),
}));

// Mock everything that `start` pulls in so module-level imports don't fail
vi.mock("../src/linear/client.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LinearClient: vi.fn(function (this: any) {
    this.fetchProjectMetadata = mockFetchProjectMetadata;
    this.fetchWorkflowStates = mockFetchWorkflowStates;
    this.createComment = mockLinearCreateComment;
  }),
}));
vi.mock("../src/linear/graph.js", () => ({ DependencyGraph: vi.fn() }));
vi.mock("../src/linear/sync.js", () => ({
  fullSync: mockFullSync,
  writeBackStatus: vi.fn(),
  logStateMapping: vi.fn(),
}));
vi.mock("../src/linear/webhook.js", () => ({
  createWebhookRoute: vi.fn(() => ({ fetch: vi.fn() })),
}));
vi.mock("../src/github/webhook.js", () => ({
  createGithubWebhookRoute: vi.fn(),
}));
vi.mock("../src/deploy.js", () => ({
  initDeployState: vi.fn(),
  isDraining: vi.fn(() => false),
  getDrainingSeconds: vi.fn().mockReturnValue(null),
  getDrainingForSeconds: vi.fn(() => null),
}));
vi.mock("../src/tunnel/index.js", () => ({ startTunnel: vi.fn() }));
vi.mock("../src/linear/poller.js", () => ({
  createPoller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock("../src/api/routes.js", () => ({
  createApiRoutes: vi.fn(() => ({ fetch: vi.fn() })),
}));
vi.mock("../src/worktree/index.js", () => ({ removeWorktree: vi.fn() }));
vi.mock("../src/inngest/client.js", () => ({ inngest: {} }));
vi.mock("inngest/hono", () => ({ serve: vi.fn(() => vi.fn()) }));
vi.mock("../src/inngest/functions.js", () => ({ functions: [] }));
vi.mock("../src/inngest/workflows/task-lifecycle.js", () => ({}));
vi.mock("../src/inngest/deps.js", () => ({
  setSchedulerDeps: vi.fn(),
  markReady: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({
  initFileLogger: vi.fn(),
  createLogger: () => ({
    debug: (...a: unknown[]) => console.log(...a),
    info: (...a: unknown[]) => console.log(...a),
    warn: (...a: unknown[]) => console.warn(...a),
    error: (...a: unknown[]) => console.error(...a),
  }),
}));
vi.mock("@hono/node-server", () => ({
  serve: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(),
}));
vi.mock("hono", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Hono: vi.fn(function (this: any) {
    this.route = vi.fn();
    this.use = vi.fn();
    this.get = vi.fn();
    this.on = vi.fn();
    this.fetch = vi.fn();
  }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the CLI module fresh with the given process.argv.
 * vi.resetModules() is required so each test gets a fresh Commander instance.
 */
async function runCli(args: string[]): Promise<void> {
  vi.resetModules();
  process.argv = ["node", "orca", ...args];
  await import("../src/cli/index.js");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orca add", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string) => {
        throw new Error(`process.exit(${code})`);
      });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("validates --priority must be 0-4 (rejects 99)", async () => {
    await expect(
      runCli([
        "add",
        "--prompt",
        "test task",
        "--repo",
        "/tmp",
        "--priority",
        "99",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--priority must be an integer between 0 and 4"),
    );
  });

  test("validates --priority must be 0-4 (rejects negative)", async () => {
    await expect(
      runCli([
        "add",
        "--prompt",
        "test task",
        "--repo",
        "/tmp",
        "--priority",
        "-1",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  test("validates --priority must be 0-4 (rejects non-integer)", async () => {
    await expect(
      runCli([
        "add",
        "--prompt",
        "test task",
        "--repo",
        "/tmp",
        "--priority",
        "2.5",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  test("auto-generates task ID when --id is omitted", async () => {
    await runCli(["add", "--prompt", "my task", "--repo", "/some/path"]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.linearIssueId).toMatch(/^ORCA-[a-z0-9]+$/);
  });

  test("uses custom --id when provided", async () => {
    await runCli([
      "add",
      "--prompt",
      "my task",
      "--repo",
      "/some/path",
      "--id",
      "MY-CUSTOM-ID",
    ]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.linearIssueId).toBe("MY-CUSTOM-ID");
  });

  test("calls insertTask with correct fields", async () => {
    await runCli([
      "add",
      "--prompt",
      "do the thing",
      "--repo",
      "/path/to/repo",
      "--priority",
      "2",
      "--id",
      "TASK-42",
    ]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.linearIssueId).toBe("TASK-42");
    expect(task.agentPrompt).toBe("do the thing");
    expect(task.repoPath).toBe("/path/to/repo");
    expect(task.priority).toBe(2);
    expect(task.lifecycleStage).toBe("ready");
    expect(task.retryCount).toBe(0);
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
  });

  test("prints Task <id> added (priority: <n>) on success", async () => {
    await runCli([
      "add",
      "--prompt",
      "do the thing",
      "--repo",
      "/tmp",
      "--priority",
      "3",
      "--id",
      "TASK-99",
    ]);

    expect(consoleSpy).toHaveBeenCalledWith("Task TASK-99 added (priority: 3)");
  });

  test("accepts priority 0 (minimum boundary)", async () => {
    await runCli([
      "add",
      "--prompt",
      "low priority",
      "--repo",
      "/tmp",
      "--priority",
      "0",
    ]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.priority).toBe(0);
  });

  test("accepts priority 4 (maximum boundary)", async () => {
    await runCli([
      "add",
      "--prompt",
      "high priority",
      "--repo",
      "/tmp",
      "--priority",
      "4",
    ]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.priority).toBe(4);
  });

  test("defaults to priority 0 when --priority omitted", async () => {
    await runCli(["add", "--prompt", "default prio", "--repo", "/tmp"]);

    expect(mockInsertTask).toHaveBeenCalledTimes(1);
    const [, task] = mockInsertTask.mock.calls[0];
    expect(task.priority).toBe(0);
  });
});

describe("orca status", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("prints active sessions count", async () => {
    mockGetRunningInvocations.mockReturnValue([
      { linearIssueId: "TASK-1" },
      { linearIssueId: "TASK-2" },
    ]);
    mockGetAllTasks.mockReturnValue([]);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Active sessions: 2");
  });

  test("prints queued task count", async () => {
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([
      { lifecycleStage: "ready", lifecycleStage: "ready", currentPhase: null },
      { lifecycleStage: "ready", lifecycleStage: "ready", currentPhase: null },
      {
        lifecycleStage: "active", currentPhase: "implement",
        lifecycleStage: "active",
        currentPhase: "implement",
      },
    ]);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Queued tasks:    2");
  });

  test("prints failed task count", async () => {
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([
      { lifecycleStage: "failed", lifecycleStage: "failed", currentPhase: null },
      { lifecycleStage: "failed", lifecycleStage: "failed", currentPhase: null },
      { lifecycleStage: "ready", lifecycleStage: "ready", currentPhase: null },
    ]);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Failed tasks:    2");
  });

  test("shows active task IDs in brackets", async () => {
    mockGetRunningInvocations.mockReturnValue([
      { linearIssueId: "TASK-A" },
      { linearIssueId: "TASK-B" },
    ]);
    mockGetAllTasks.mockReturnValue([]);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("[TASK-A, TASK-B]");
  });
});

describe("orca start", () => {
  let _consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      throw new Error(`process.exit(${code})`);
    });
    // Default: no orphaned invocations, no tasks
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("start command initializes scheduler deps after grace period", async () => {
    await runCli(["start"]);

    const { setSchedulerDeps } = await import("../src/inngest/deps.js");
    // setSchedulerDeps is deferred by STARTUP_GRACE_MS (15s)
    expect(vi.mocked(setSchedulerDeps)).not.toHaveBeenCalled();

    // Advance past the startup grace period
    await vi.advanceTimersByTimeAsync(16_000);

    expect(vi.mocked(setSchedulerDeps)).toHaveBeenCalled();
  });

  test("orphaned invocations are marked failed on startup", async () => {
    const { updateInvocation } = await import("../src/db/queries.js");
    mockGetRunningInvocations
      .mockReturnValueOnce([
        { id: "inv-1", linearIssueId: "TASK-1" },
        { id: "inv-2", linearIssueId: "TASK-2" },
      ])
      .mockReturnValue([]);

    await runCli(["start"]);

    // Orphan cleanup happens synchronously before the grace period
    expect(vi.mocked(updateInvocation)).toHaveBeenCalledWith(
      expect.anything(),
      "inv-1",
      expect.objectContaining({
        status: "failed",
        outputSummary: "orphaned by crash/restart",
      }),
    );
    expect(vi.mocked(updateInvocation)).toHaveBeenCalledWith(
      expect.anything(),
      "inv-2",
      expect.objectContaining({
        status: "failed",
        outputSummary: "orphaned by crash/restart",
      }),
    );
  });
});
