// ---------------------------------------------------------------------------
// CLI command tests — add, status, and start subcommands
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted — must be at top level)
// ---------------------------------------------------------------------------

const mockInsertTask = vi.fn();
const mockGetAllTasks = vi.fn(() => []);
const mockGetRunningInvocations = vi.fn(() => []);
const mockSumCostInWindow = vi.fn(() => 0);
const mockBudgetWindowStart = vi.fn(() => new Date().toISOString());

// start command mocks
const mockFetchProjectMetadata = vi.fn(() => Promise.resolve([]));
const mockFetchWorkflowStates = vi.fn(() => Promise.resolve(new Map()));
const mockLinearCreateComment = vi.fn(() => Promise.resolve());
const mockFullSync = vi.fn(() => Promise.resolve([]));
const mockCreateScheduler = vi.fn(() => ({ stop: vi.fn() }));

vi.mock("../src/db/queries.js", () => ({
  insertTask: mockInsertTask,
  getAllTasks: mockGetAllTasks,
  getRunningInvocations: mockGetRunningInvocations,
  sumCostInWindow: mockSumCostInWindow,
  budgetWindowStart: mockBudgetWindowStart,
  updateInvocation: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskFields: vi.fn(),
  clearSessionIds: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock("../src/config/index.js", () => ({
  loadConfig: vi.fn(() => ({
    dbPath: ":memory:",
    budgetWindowHours: 4,
    budgetMaxCostUsd: 100,
    linearApiKey: "test-key",
    linearProjectIds: [],
    projectRepoMap: new Map(),
    // start command fields
    logPath: "/tmp/orca-test.log",
    logMaxSizeMb: 10,
    port: 4000,
    concurrencyCap: 1,
    schedulerIntervalSec: 10,
    externalTunnel: true, // skip cloudflared spawn in tests
    githubWebhookSecret: undefined,
    cloudflaredPath: "cloudflared",
    tunnelToken: undefined,
  })),
  parseRepoPath: vi.fn(),
  validateProjectRepoPaths: vi.fn(),
}));

// Mock everything that `start` pulls in so module-level imports don't fail
vi.mock("../src/scheduler/index.js", () => ({
  createScheduler: mockCreateScheduler,
}));
vi.mock("../src/scheduler/state.js", () => ({ setSchedulerHandle: vi.fn() }));
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
}));
vi.mock("../src/tunnel/index.js", () => ({ startTunnel: vi.fn() }));
vi.mock("../src/linear/poller.js", () => ({
  createPoller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock("../src/api/routes.js", () => ({
  createApiRoutes: vi.fn(() => ({ fetch: vi.fn() })),
  createInngestRoute: vi.fn(() => ({ fetch: vi.fn() })),
}));
vi.mock("../src/worktree/index.js", () => ({ removeWorktree: vi.fn() }));
vi.mock("../src/logger.js", () => ({ initFileLogger: vi.fn() }));
vi.mock("../src/inngest/deps.js", () => ({ setSchedulerDeps: vi.fn() }));
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
    expect(task.orcaStatus).toBe("ready");
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
      { orcaStatus: "ready" },
      { orcaStatus: "ready" },
      { orcaStatus: "running" },
    ]);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Queued tasks:    2");
  });

  test("prints budget usage", async () => {
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([]);
    mockSumCostInWindow.mockReturnValue(42.5);

    const { loadConfig } = await import("../src/config/index.js");
    vi.mocked(loadConfig).mockReturnValue({
      dbPath: ":memory:",
      budgetWindowHours: 4,
      budgetMaxCostUsd: 100,
      linearApiKey: "test-key",
      linearProjectIds: [],
      projectRepoMap: new Map(),
      logPath: "/tmp/orca-test.log",
      logMaxSizeMb: 10,
      port: 4000,
      concurrencyCap: 1,
      schedulerIntervalSec: 10,
      externalTunnel: true,
      githubWebhookSecret: undefined,
      cloudflaredPath: "cloudflared",
      tunnelToken: undefined,
    } as ReturnType<typeof loadConfig>);

    await runCli(["status"]);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("$42.50");
    expect(output).toContain("$100.00");
  });

  test("prints failed task count", async () => {
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([
      { orcaStatus: "failed" },
      { orcaStatus: "failed" },
      { orcaStatus: "ready" },
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
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string) => {
      throw new Error(`process.exit(${code})`);
    });
    // Default: no orphaned invocations, no tasks
    mockGetRunningInvocations.mockReturnValue([]);
    mockGetAllTasks.mockReturnValue([]);
  });

  test("start command initializes scheduler", async () => {
    await runCli(["start"]);

    await vi.waitFor(() => {
      expect(mockCreateScheduler).toHaveBeenCalled();
    });
  });

  test("--scheduler-paused passes paused:true to createScheduler", async () => {
    await runCli(["start", "--scheduler-paused"]);

    await vi.waitFor(() => {
      expect(mockCreateScheduler).toHaveBeenCalledWith(expect.anything(), {
        paused: true,
      });
    });
  });

  test("without --scheduler-paused, createScheduler receives paused:undefined", async () => {
    await runCli(["start"]);

    await vi.waitFor(() => {
      expect(mockCreateScheduler).toHaveBeenCalledWith(expect.anything(), {
        paused: undefined,
      });
    });
  });

  test("--scheduler-paused prints paused message", async () => {
    await runCli(["start", "--scheduler-paused"]);

    await vi.waitFor(() => {
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("PAUSED");
    });
  });

  test("without --scheduler-paused prints started message with concurrency", async () => {
    await runCli(["start"]);

    await vi.waitFor(() => {
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Orca scheduler started");
      expect(output).toContain("concurrency: 1");
    });
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

    await vi.waitFor(() => {
      expect(mockCreateScheduler).toHaveBeenCalled();
    });

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
