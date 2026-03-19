// ---------------------------------------------------------------------------
// EMI-332: Circuit breaker, zero-cost failure recording, budget backoff
// Adversarial tests targeting the new implementation.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-var
var capturedHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        _config: unknown,
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
        return { id: "task-lifecycle" };
      },
    ),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/db/queries.js", () => ({
  getTask: vi.fn(),
  getInvocation: vi.fn(),
  claimTaskForDispatch: vi.fn(),
  updateTaskStatus: vi.fn(),
  insertInvocation: vi.fn(),
  updateInvocation: vi.fn(),
  insertBudgetEvent: vi.fn(),
  sumCostInWindow: vi.fn().mockReturnValue(0),
  sumTokensInWindow: vi.fn().mockReturnValue(0),
  budgetWindowStart: vi.fn().mockReturnValue(new Date().toISOString()),
  incrementRetryCount: vi.fn(),
  incrementReviewCycleCount: vi.fn(),
  updateTaskPrBranch: vi.fn(),
  updateTaskCiInfo: vi.fn(),
  updateTaskDeployInfo: vi.fn(),
  updateTaskFixReason: vi.fn(),
  getLastMaxTurnsInvocation: vi.fn().mockReturnValue(null),
  getLastDeployInterruptedInvocation: vi.fn().mockReturnValue(null),
  getLastCompletedImplementInvocation: vi.fn().mockReturnValue(null),
  resetMergeAttemptCount: vi.fn(),
  resetStaleSessionRetryCount: vi.fn(),
  incrementMergeAttemptCount: vi.fn(),
  insertSystemEvent: vi.fn(),
  getInvocationsByTask: vi.fn().mockReturnValue([]),
  // NEW in EMI-332 — the original test mock is missing this
  countZeroCostFailuresSince: vi.fn().mockReturnValue(0),
  clearSessionIds: vi.fn(),
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn().mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  }),
  killSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn().mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  }),
  removeWorktree: vi.fn(),
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
  findPrForBranch: vi.fn(),
  closeSupersededPrs: vi.fn(),
  getPrCheckStatus: vi.fn(),
  getPrMergeState: vi.fn(),
  mergePr: vi.fn(),
  updatePrBranch: vi.fn(),
  rebasePrBranch: vi.fn(),
  getMergeCommitSha: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/inngest/workflow-utils.js", () => ({
  extractMarkerFromLog: vi.fn().mockResolvedValue(null),
  worktreeHasNoChanges: vi.fn().mockResolvedValue(false),
  alreadyDonePatterns: [],
}));

vi.mock("../src/scheduler/alerts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scheduler/alerts.js")>();
  return {
    ...actual,
    sendAlert: vi.fn(),
    sendAlertThrottled: vi.fn(),
    sendPermanentFailureAlert: vi.fn(),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  sumCostInWindow,
  sumTokensInWindow,
  countZeroCostFailuresSince,
  insertSystemEvent,
  insertBudgetEvent,
} from "../src/db/queries.js";
import { spawnSession } from "../src/runner/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { activeHandles } from "../src/session-handles.js";
import { sendAlertThrottled } from "../src/scheduler/alerts.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockCountZeroCostFailuresSince = vi.mocked(countZeroCostFailuresSince);
const mockInsertSystemEvent = vi.mocked(insertSystemEvent);
const mockInsertBudgetEvent = vi.mocked(insertBudgetEvent);
const mockSpawnSession = vi.mocked(spawnSession);
const mockSendAlertThrottled = vi.mocked(sendAlertThrottled);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockExistsSync = vi.mocked(existsSync);
const mockCreateWorktree = vi.mocked(createWorktree);

const mockConfig = {
  budgetMaxCostUsd: 100,
  budgetWindowHours: 4,
  budgetMaxTokens: 1_000_000,
  maxRetries: 3,
  maxReviewCycles: 3,
  resumeOnMaxTurns: false,
  resumeOnFix: false,
  implementModel: "claude-sonnet-4-5",
  reviewModel: "claude-haiku-4-5",
  fixModel: "claude-sonnet-4-5",
  defaultMaxTurns: 200,
  reviewMaxTurns: 50,
  claudePath: "claude",
  implementSystemPrompt: "",
  reviewSystemPrompt: "",
  fixSystemPrompt: "",
  disallowedTools: "",
  deployTimeoutMin: 30,
  deployStrategy: "none" as const,
};

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

const mockStateMap = {};
const mockDb = {} as never;

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "TEST-1",
    orcaStatus: "ready",
    agentPrompt: "Fix the bug",
    repoPath: "/repo",
    prBranchName: null,
    prNumber: null,
    retryCount: 0,
    reviewCycleCount: 0,
    fixReason: null,
    mergeAttemptCount: 0,
    ...overrides,
  };
}

function makeTaskReadyEvent(taskId = "TEST-1") {
  return {
    name: "task/ready" as const,
    data: {
      linearIssueId: taskId,
      repoPath: "/repo",
      priority: 0,
      projectName: "test",
      taskType: "feature",
      createdAt: new Date().toISOString(),
    },
  };
}

function makeSessionCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: "session/completed" as const,
    data: {
      invocationId: 1,
      linearIssueId: "TEST-1",
      phase: "implement" as const,
      exitCode: 0,
      summary: null,
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 200,
      numTurns: 5,
      sessionId: "sess-123",
      branchName: "orca/TEST-1-inv-1",
      worktreePath: "/tmp/worktree",
      isMaxTurns: false,
      isResumeNotFound: false,
      ...overrides,
    },
  };
}

function createStep(waitForEventResponses: Map<string, unknown> = new Map()) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async (id: string, _opts: unknown) => {
      activeHandles.clear();
      return waitForEventResponses.get(id) ?? null;
    }),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  activeHandles.clear();
  delete process.env.ORCA_CIRCUIT_BREAKER_THRESHOLD;

  // Re-apply defaults after reset
  mockSumCostInWindow.mockReturnValue(0);
  mockSumTokensInWindow.mockReturnValue(0);
  mockCountZeroCostFailuresSince.mockReturnValue(0);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockWriteBackStatus.mockResolvedValue(undefined);
  mockExistsSync.mockReturnValue(false);
  mockCreateWorktree.mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  });
  mockInsertInvocation.mockReturnValue(1);
  mockSpawnSession.mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  });

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: mockStateMap as never,
  });
});

// ---------------------------------------------------------------------------
// BUG #1: countZeroCostFailuresSince missing from test mock causes all tests to fail
// This test verifies the mock is required for the budget check step to work.
// ---------------------------------------------------------------------------

describe("circuit breaker — countZeroCostFailuresSince integration", () => {
  test("budget check step calls countZeroCostFailuresSince", async () => {
    // If countZeroCostFailuresSince is not in the mock, every test that
    // reaches the check-budget step will throw:
    // "No 'countZeroCostFailuresSince' export is defined on the mock"
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(mockCountZeroCostFailuresSince).toHaveBeenCalled();
  });

  test("circuit breaker triggers when zero-cost failures >= threshold (default 5)", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5); // At threshold

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    // Should not claim the task
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
  });

  test("circuit breaker does NOT trigger when zero-cost failures < threshold", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(4); // Below threshold
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // Should have proceeded past budget check
    expect(mockClaimTaskForDispatch).toHaveBeenCalled();
  });

  test("ORCA_CIRCUIT_BREAKER_THRESHOLD env var is respected", async () => {
    process.env.ORCA_CIRCUIT_BREAKER_THRESHOLD = "3";
    mockCountZeroCostFailuresSince.mockReturnValue(3); // Exactly at custom threshold

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
  });

  test("circuit breaker result includes circuitBreaker: true flag", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // The outcome is budget_exceeded but with circuit breaker reason
    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(result).toMatchObject({
      reason: expect.stringContaining("circuit breaker"),
    });
  });

  test("circuit breaker sends critical alert (not warning)", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "circuit_breaker",
      expect.objectContaining({ severity: "critical" }),
      expect.any(Number),
    );
  });

  test("circuit breaker alert uses 60-min throttle (not 30-min)", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "circuit_breaker",
      expect.anything(),
      60 * 60 * 1000,
    );
  });

  test("budget exhausted alert uses 30-min throttle (not circuit breaker)", async () => {
    // Cost exceeded, but no circuit breaker
    mockSumCostInWindow.mockReturnValue(150);
    mockCountZeroCostFailuresSince.mockReturnValue(0);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "budget_exhausted",
      expect.objectContaining({ severity: "warning" }),
      30 * 60 * 1000,
    );
    // Must NOT send a circuit_breaker alert
    expect(mockSendAlertThrottled).not.toHaveBeenCalledWith(
      expect.anything(),
      "circuit_breaker",
      expect.anything(),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// BUG #2: zero-cost failure system events recorded correctly
// ---------------------------------------------------------------------------

describe("zero-cost failure recording", () => {
  test("implement failure with $0 cost inserts zero_cost_failure system event", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failEvent = makeSessionCompletedEvent({
      exitCode: 1,
      costUsd: 0,
      isMaxTurns: false,
    });

    const step = createStep(new Map([["await-implement", failEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "zero_cost_failure",
        // NOTE: metadata does NOT include "phase" - it only includes taskId, invocationId, exitCode
        // The phase appears only in the message string, not the metadata
        metadata: expect.objectContaining({ taskId: "TEST-1" }),
      }),
    );
  });

  test("implement failure with null cost inserts zero_cost_failure system event", async () => {
    // null costUsd should also be treated as zero-cost failure
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failEvent = makeSessionCompletedEvent({
      exitCode: 1,
      costUsd: null,
      isMaxTurns: false,
    });

    const step = createStep(new Map([["await-implement", failEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "zero_cost_failure",
      }),
    );
  });

  test("implement SUCCESS with $0 cost does NOT insert zero_cost_failure", async () => {
    // A successful $0 session (e.g., work already done) should not fire circuit breaker
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const { findPrForBranch } = await import("../src/github/index.js");
    const { worktreeHasNoChanges } =
      await import("../src/inngest/workflow-utils.js");
    vi.mocked(findPrForBranch).mockResolvedValue({
      exists: true,
      number: 42,
      url: "https://github.com/x/y/pull/42",
      headBranch: "orca/TEST-1-inv-1",
    });
    vi.mocked(worktreeHasNoChanges).mockResolvedValue(false);

    // Success (exitCode: 0) with zero cost
    const successEvent = makeSessionCompletedEvent({
      exitCode: 0,
      costUsd: 0,
      isMaxTurns: false,
    });

    const step = createStep(new Map([["await-implement", successEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Should NOT have inserted a zero_cost_failure event
    const zeroCostCalls = mockInsertSystemEvent.mock.calls.filter(
      (call) =>
        call[1] && (call[1] as { type: string }).type === "zero_cost_failure",
    );
    expect(zeroCostCalls).toHaveLength(0);
  });

  test("implement failure with non-zero cost does NOT insert zero_cost_failure", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failEvent = makeSessionCompletedEvent({
      exitCode: 1,
      costUsd: 0.05, // non-zero cost
      isMaxTurns: false,
    });

    const step = createStep(new Map([["await-implement", failEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    const zeroCostCalls = vi
      .mocked(mockInsertSystemEvent)
      .mock.calls.filter(
        (call) =>
          call[1] && (call[1] as { type: string }).type === "zero_cost_failure",
      );
    expect(zeroCostCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BUG #3: recordBudgetEventFromEvent records $0 cost (not filtered out)
// ---------------------------------------------------------------------------

describe("budget event recording — $0 cost", () => {
  test("$0 cost event is recorded in budget_events table", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const zeroEvent = makeSessionCompletedEvent({
      exitCode: 1, // fail fast - we just want to check budget event recording
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });

    const step = createStep(new Map([["await-implement", zeroEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // insertBudgetEvent MUST be called even for $0 cost
    expect(mockInsertBudgetEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ costUsd: 0 }),
    );
  });

  test("null cost event is NOT recorded in budget_events (null skipped)", async () => {
    // null means the cost data was unavailable — this is still filtered out
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const nullCostEvent = makeSessionCompletedEvent({
      exitCode: 1,
      costUsd: null,
    });

    const step = createStep(new Map([["await-implement", nullCostEvent]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInsertBudgetEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BUG #4: backoff sleep — duration calculation
// ---------------------------------------------------------------------------

describe("budget exhaustion backoff", () => {
  test("backoff formula is min(2^retryCount * 5, 60) minutes", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // retryCount=0: min(2^0 * 5, 60) = min(5, 60) = 5 minutes
    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "5m");
  });

  test("backoff caps at 60 minutes when retryCount is large", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    // retryCount=4: min(2^4 * 5, 60) = min(80, 60) = 60 minutes
    const task = makeTask({ retryCount: 4 });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "60m");
  });

  test("backoff is applied AFTER requeue step, not before", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const callOrder: string[] = [];

    const originalRun = step.run;
    const originalSleep = step.sleep;
    step.run = vi.fn(async (id: string, fn: () => unknown) => {
      callOrder.push(`run:${id}`);
      return originalRun(id, fn);
    });
    step.sleep = vi.fn(async (id: string) => {
      callOrder.push(`sleep:${id}`);
      return originalSleep(id);
    });

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    const requeueIdx = callOrder.indexOf("run:requeue-budget-exceeded");
    const backoffIdx = callOrder.indexOf("sleep:budget-backoff");

    expect(requeueIdx).toBeGreaterThanOrEqual(0);
    expect(backoffIdx).toBeGreaterThanOrEqual(0);
    expect(backoffIdx).toBeGreaterThan(requeueIdx);
  });
});

// ---------------------------------------------------------------------------
// BUG #5: sendAlertThrottled/Linear comment called outside step.run
// In Inngest, code between steps is re-executed on workflow replay.
// This tests that alerts fire with throttling to mitigate the re-execution risk.
// ---------------------------------------------------------------------------

describe("alert throttling outside step.run", () => {
  test("circuit breaker alert uses throttled send (not unthrottled sendAlert)", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);
    const { sendAlert } = await import("../src/scheduler/alerts.js");

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // The throttled version must be used for circuit breaker, not the plain sendAlert
    expect(mockSendAlertThrottled).toHaveBeenCalled();
    // sendAlert should NOT have been called directly for the circuit breaker alert
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled();
  });

  test("budget exhaustion alert uses throttled send", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    const { sendAlert } = await import("../src/scheduler/alerts.js");

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockSendAlertThrottled).toHaveBeenCalled();
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BUG #6: circuit breaker reason contains count info
// ---------------------------------------------------------------------------

describe("circuit breaker reason message", () => {
  test("reason message includes the failure count", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(7);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({
      reason: expect.stringContaining("7"),
    });
  });
});
