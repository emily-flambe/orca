// ---------------------------------------------------------------------------
// Integration tests for deploy-monitor Inngest workflow
//
// Strategy: mock inngest client to capture the handler, then mock getSchedulerDeps
// and GitHub calls to test the workflow's polling logic.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Must be `var` (not `let`) so it's hoisted and accessible when vi.mock runs
// eslint-disable-next-line no-var
var capturedDeployMonitorHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;
// eslint-disable-next-line no-var
var capturedDeployMonitorConfig: { cancelOn?: unknown[]; id?: string };

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        config: { cancelOn?: unknown[]; id?: string },
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        capturedDeployMonitorHandler = handler;
        capturedDeployMonitorConfig = config;
        return { id: config.id ?? "deploy-monitor" };
      },
    ),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockDb = {} as never;

const mockConfig = {
  maxReviewCycles: 3,
  deployTimeoutMin: 30,
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
  insertBudgetEvent: vi.fn(),
  sumCostInWindow: vi.fn().mockReturnValue(0),
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

vi.mock("../src/github/index.js", () => ({
  getWorkflowRunStatus: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/scheduler/alerts.js", () => ({
  sendPermanentFailureAlert: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { getTask, updateTaskStatus } from "../src/db/queries.js";
import { writeBackStatus } from "../src/linear/sync.js";
import { getWorkflowRunStatus } from "../src/github/index.js";
import { sendPermanentFailureAlert } from "../src/scheduler/alerts.js";

// Import the workflow module to trigger createFunction capture
import "../src/inngest/workflows/deploy-monitor.js";

const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockGetWorkflowRunStatus = vi.mocked(getWorkflowRunStatus);
const mockSendPermanentFailureAlert = vi.mocked(sendPermanentFailureAlert);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeployingEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: "task/deploying" as const,
    data: {
      linearIssueId: "TEST-1",
      mergeCommitSha: "abc123",
      repoPath: "/repo",
      prNumber: 42,
      deployStartedAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "TEST-1",
    orcaStatus: "deploying",
    repoPath: "/repo",
    prNumber: 42,
    prBranchName: "orca/TEST-1-inv-1",
    reviewCycleCount: 0,
    mergeAttemptCount: 0,
    ...overrides,
  };
}

function createDeployMonitorStep() {
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

describe("deploy-monitor workflow", () => {
  test("task not found → returns aborted", async () => {
    mockGetTask.mockReturnValue(null);

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "aborted", reason: "task_not_found" });
  });

  test("task status changed from deploying → returns aborted", async () => {
    mockGetTask.mockReturnValue(makeTask({ orcaStatus: "done" }));

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "aborted", reason: "status_changed" });
  });

  test("deploy timeout → fails permanently with deploy_timeout reason", async () => {
    mockGetTask.mockReturnValue(makeTask());

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent({
        // deployStartedAt far in the past — exceeds deployTimeoutMin=30
        deployStartedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
      step,
    });

    expect(result).toMatchObject({ status: "failed", reason: "deploy_timeout" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "failed");
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
  });

  test("no merge commit SHA → transitions to done immediately", async () => {
    mockGetTask.mockReturnValue(makeTask());

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ mergeCommitSha: "" }),
      step,
    });

    expect(result).toMatchObject({ status: "done", reason: "no_sha" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "done");
  });

  test("deploy success → transitions to done", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("success");

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "done");
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "done",
      mockStateMap,
    );
  });

  test("deploy failure → transitions to failed_permanent", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("failure");

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "failed", reason: "deploy_ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "failed");
    expect(mockWriteBackStatus).toHaveBeenCalledWith(
      mockLinearClient,
      "TEST-1",
      "failed_permanent",
      mockStateMap,
    );
  });

  test("deploy pending → polls again (sleeps between polls)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // loop iteration 1
      .mockReturnValueOnce(makeTask()) // inside check-deploy step
      .mockReturnValueOnce(null); // loop iteration 2 → abort

    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent(),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("deploy-poll-wait-1", "30s");
  });

  test("poll exhaustion (60 pending attempts) → task failed with poll_exhausted reason", async () => {
    // Always return a valid deploying task so the loop runs all 60 iterations.
    // step.sleep is mocked to resolve immediately.
    mockGetTask.mockReturnValue(makeTask());
    // Deploy always pending — never resolves
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    const result = await capturedDeployMonitorHandler({
      event: makeDeployingEvent({
        // Set deployStartedAt to recent time so the timeout (deployTimeoutMin=30min) doesn't trigger
        deployStartedAt: new Date().toISOString(),
      }),
      step,
    });

    expect(result).toMatchObject({ status: "failed", reason: "poll_exhausted" });
  });

  test("poll exhaustion → updateTaskStatus called with 'failed'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ deployStartedAt: new Date().toISOString() }),
      step,
    });

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "failed");
  });

  test("poll exhaustion → writeBackStatus called with 'failed_permanent'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ deployStartedAt: new Date().toISOString() }),
      step,
    });

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

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ deployStartedAt: new Date().toISOString() }),
      step,
    });

    expect(mockSendPermanentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
      "TEST-1",
      expect.stringContaining("60"),
    );
  });

  test("poll exhaustion → sendPermanentFailureAlert is called inside step.run", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ deployStartedAt: new Date().toISOString() }),
      step,
    });

    expect(step.run).toHaveBeenCalledWith("deploy-poll-exhausted", expect.any(Function));
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });

  test("poll exhaustion → no duplicate explicit createComment call (alert handles it)", async () => {
    // sendPermanentFailureAlert handles the Linear comment + webhook.
    // No extra explicit createComment call should occur from the exhaustion step.
    mockGetTask.mockReturnValue(makeTask());
    mockGetWorkflowRunStatus.mockResolvedValue("pending");

    const step = createDeployMonitorStep();
    await capturedDeployMonitorHandler({
      event: makeDeployingEvent({ deployStartedAt: new Date().toISOString() }),
      step,
    });

    const exhaustionComments = mockLinearClient.createComment.mock.calls.filter(
      ([_id, msg]: [string, string]) =>
        msg.includes("60") || msg.includes("poll exhausted"),
    );
    expect(exhaustionComments.length).toBe(0);
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });

  test("deploy-monitor workflow is configured to cancel on task/cancelled event", () => {
    expect(capturedDeployMonitorConfig?.cancelOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "task/cancelled" }),
      ]),
    );
  });
});
