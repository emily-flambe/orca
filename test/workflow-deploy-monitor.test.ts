// ---------------------------------------------------------------------------
// Integration tests for shared deploy-monitor logic (runDeployMonitor)
//
// Strategy: mock getSchedulerDeps and GitHub calls, then call runDeployMonitor
// directly with a mock step object.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(() => ({ id: "unused" })),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockDb = {} as never;

const mockConfig = {
  maxDeployPollAttempts: 60,
  deployStrategy: "github_actions" as const,
  maxRetries: 3,
};

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

const mockStateMap = {};

const mockSchedulerDeps = {
  db: mockDb,
  config: mockConfig,
  client: mockLinearClient,
  stateMap: mockStateMap,
};

vi.mock("../src/inngest/deps.js", () => ({
  getSchedulerDeps: vi.fn(() => mockSchedulerDeps),
  setSchedulerDeps: vi.fn(),
}));

vi.mock("../src/db/queries.js", () => ({
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskDeployInfo: vi.fn(),
  updateTaskFixReason: vi.fn(),
  incrementMergeAttemptCount: vi.fn(),
  resetMergeAttemptCount: vi.fn(),
  incrementReviewCycleCount: vi.fn(),
  claimTaskForDispatch: vi.fn(),
  insertInvocation: vi.fn(),
  updateInvocation: vi.fn(),
  budgetWindowStart: vi.fn().mockReturnValue(new Date().toISOString()),
  incrementRetryCount: vi.fn(),
  updateTaskPrBranch: vi.fn(),
  updateTaskCiInfo: vi.fn(),
  getLastMaxTurnsInvocation: vi.fn().mockReturnValue(null),
  getLastDeployInterruptedInvocation: vi.fn().mockReturnValue(null),
  getLastCompletedImplementInvocation: vi.fn().mockReturnValue(null),
  getInvocation: vi.fn(),
  getInvocationsByTask: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitInvocationStarted: vi.fn(),
  emitInvocationCompleted: vi.fn(),
}));

vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/scheduler/alerts.js", () => ({
  sendPermanentFailureAlert: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  getWorkflowRunStatus: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
  getDefaultBranch: vi.fn().mockReturnValue("main"),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { getTask, updateTaskStatus } from "../src/db/queries.js";
import { writeBackStatus } from "../src/linear/sync.js";
import { getWorkflowRunStatus } from "../src/github/index.js";
import { sendPermanentFailureAlert } from "../src/scheduler/alerts.js";
import { runDeployMonitor } from "../src/inngest/shared/deploy-monitor.js";

const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockGetWorkflowRunStatus = vi.mocked(getWorkflowRunStatus);
const mockSendPermanentFailureAlert = vi.mocked(sendPermanentFailureAlert);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "TEST-1",
    lifecycleStage: "active",
    currentPhase: "deploy",
    repoPath: "/repo",
    prNumber: 42,
    prBranchName: "orca/TEST-1-inv-1",
    mergeAttemptCount: 0,
    ...overrides,
  };
}

function createStep() {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    sleep: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => null),
    sendEvent: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockWriteBackStatus.mockResolvedValue(undefined);
  (mockSchedulerDeps as Record<string, unknown>).config = mockConfig;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDeployMonitor (shared deploy monitor logic)", () => {
  test("task not found → returns aborted", async () => {
    mockGetTask.mockReturnValue(null);

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "aborted",
      reason: "task_not_found",
    });
  });

  test("task status changed from deploying → returns aborted", async () => {
    mockGetTask.mockReturnValue(
      makeTask({
        lifecycleStage: "done",
        currentPhase: null,
      }),
    );

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "aborted",
      reason: "status_changed",
    });
  });

  test("deploy timeout → fails permanently with deploy_timeout reason", async () => {
    mockGetTask.mockReturnValue(makeTask());

    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      maxDeployPollAttempts: 1,
    };

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "deploy_timeout",
    });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "deploy_timeout" }),
    );
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
  });

  test("no merge commit SHA → transitions to done immediately", async () => {
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "done", reason: "no_sha" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "done",
      { reason: "deploy_no_sha" },
    );
  });

  test("deploy success → updates task to done, writes back to Linear", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetWorkflowRunStatus.mockResolvedValue("success");

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "done",
      { reason: "deploy_succeeded" },
    );
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "done",
      mockStateMap,
    );
  });

  test("deploy failure → updates task to failed, writes back to Linear", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetWorkflowRunStatus.mockResolvedValue("failure");

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "deploy_ci_failure",
    });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "deploy_ci_failed" }),
    );
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
  });

  test("deploy pending → polls again (sleeps between polls)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(null);

    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(step.sleep).toHaveBeenCalledWith("deploy-poll-wait-1", "30s");
  });

  test("no merge commit SHA → marks task done without polling", async () => {
    mockGetTask.mockReturnValueOnce(makeTask()).mockReturnValue(makeTask());

    const step = createStep();
    // runDeployMonitor treats falsy mergeCommitSha as "no SHA"
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "done", reason: "no_sha" });
    expect(mockGetWorkflowRunStatus).not.toHaveBeenCalled();
  });

  test("poll exhaustion → updates task to failed, writes back to Linear, fires alert", async () => {
    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      maxDeployPollAttempts: 1,
    };

    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "deploy_poll_exhausted" }),
    );
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
      "TEST-1",
      expect.stringContaining("poll attempts"),
    );
  });

  test("poll exhaustion (60 pending attempts) → task failed with poll_exhausted reason", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    const result = await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
  });

  test("poll exhaustion → updateTaskStatus called with 'failed'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "deploy_poll_exhausted" }),
    );
  });

  test("poll exhaustion → writeBackStatus called with 'failed_permanent'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
  });

  test("poll exhaustion → sendPermanentFailureAlert called with poll count in reason", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(mockSendPermanentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
      "TEST-1",
      expect.stringContaining("60"),
    );
  });

  test("poll exhaustion → sendPermanentFailureAlert is called inside step.run", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    expect(step.run).toHaveBeenCalledWith(
      "deploy-poll-exhausted",
      expect.any(Function),
    );
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });

  test("poll exhaustion → no duplicate explicit createComment call (alert handles it)", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createStep();
    await runDeployMonitor(
      step as never,
      "TEST-1",
      "abc123",
      new Date().toISOString(),
    );

    const exhaustionComments = mockLinearClient.createComment.mock.calls.filter(
      ([_id, msg]: [string, string]) =>
        msg.includes("60") || msg.includes("poll exhausted"),
    );
    expect(exhaustionComments.length).toBe(0);
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });
});
