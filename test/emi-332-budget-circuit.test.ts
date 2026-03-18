// ---------------------------------------------------------------------------
// Adversarial tests for EMI-332: budget exhaustion alerts and zero-cost
// failure circuit breaker in task-lifecycle workflow.
//
// Strategy: same mock infrastructure as workflow-task-lifecycle.test.ts.
// We spy on sendAlertThrottled and sendAlert to confirm call semantics,
// and drive the budget/circuit-breaker branch by controlling the mocked
// query return values.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (hoisted by vi.mock)
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
  incrementMergeAttemptCount: vi.fn(),
  insertSystemEvent: vi.fn(),
  getInvocationsByTask: vi.fn().mockReturnValue([]),
  countZeroCostInvocationsSince: vi.fn().mockReturnValue(0),
  countSystemEventsOfTypeSince: vi.fn().mockReturnValue(0),
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

// Partially mock alerts: spy on sendAlertThrottled and sendAlert, keep real
// implementations (they must not throw even if webhook URL is absent).
vi.mock("../src/scheduler/alerts.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/scheduler/alerts.js")
  >();
  return {
    ...actual,
    sendAlertThrottled: vi.fn(actual.sendAlertThrottled),
    sendAlert: vi.fn(actual.sendAlert),
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
  sumCostInWindow,
  insertBudgetEvent,
  countZeroCostInvocationsSince,
  countSystemEventsOfTypeSince,
  getTask,
  updateTaskStatus,
  claimTaskForDispatch,
  insertInvocation,
} from "../src/db/queries.js";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { spawnSession } from "../src/runner/index.js";
import { findPrForBranch } from "../src/github/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { inngest } from "../src/inngest/client.js";
import { activeHandles } from "../src/session-handles.js";
import {
  sendAlertThrottled,
  sendAlert,
} from "../src/scheduler/alerts.js";

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------

const mockInngestSend = vi.mocked(inngest.send);
const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockInsertBudgetEvent = vi.mocked(insertBudgetEvent);
const mockCountZeroCost = vi.mocked(countZeroCostInvocationsSince);
const mockCountSystemEvents = vi.mocked(countSystemEventsOfTypeSince);
const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockSendAlertThrottled = vi.mocked(sendAlertThrottled);
const mockSendAlert = vi.mocked(sendAlert);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockConfig = {
  budgetMaxCostUsd: 100,
  budgetWindowHours: 4,
  budgetMaxTokens: 1_000_000_000,
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
  zeroCostCircuitBreakerThreshold: 5,
  zeroCostCircuitBreakerWindowMin: 10,
  alertWebhookUrl: undefined,
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
    priority: 0,
    projectName: "test",
    taskType: "standard",
    createdAt: new Date().toISOString(),
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

function createStep() {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async (_id: string, _opts: unknown) => {
      activeHandles.clear();
      return null;
    }),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  activeHandles.clear();

  // Re-apply defaults after reset
  mockSumCostInWindow.mockReturnValue(0);
  mockCountZeroCost.mockReturnValue(0);
  mockCountSystemEvents.mockReturnValue(0);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  vi.mocked(writeBackStatus).mockResolvedValue(undefined);
  vi.mocked(createWorktree).mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  });
  mockInsertInvocation.mockReturnValue(1);
  vi.mocked(spawnSession).mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  });
  vi.mocked(findPrForBranch).mockReturnValue({
    exists: true,
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    headBranch: "orca/TEST-1-inv-1",
    merged: false,
  });

  // Re-wrap mocked functions after vi.resetAllMocks wipes implementations
  // (The mock module factory runs once; resetAllMocks clears call history but
  // keeps the spy wrapper — we just need to re-apply the default return
  // values above.)

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig as never,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: mockStateMap as never,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EMI-332: budget exhaustion alerts and circuit breaker", () => {
  // -------------------------------------------------------------------------
  // 1. sendAlertThrottled called with "budget-exhausted" key on USD overage
  // -------------------------------------------------------------------------
  test("budget USD exceeded → sendAlertThrottled called with 'budget-exhausted' key", async () => {
    mockSumCostInWindow.mockReturnValue(150); // exceeds $100 limit
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "budget-exhausted",
      expect.objectContaining({ severity: "warning" }),
      expect.any(Number),
    );
  });

  // -------------------------------------------------------------------------
  // 2. sendAlertThrottled called with "circuit-breaker" key when tripped
  // -------------------------------------------------------------------------
  test("circuit breaker trips → sendAlertThrottled called with 'circuit-breaker' key", async () => {
    // Zero-cost count at or above threshold (5)
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "circuit-breaker",
      expect.objectContaining({ severity: "critical" }),
      expect.any(Number),
    );
  });

  // -------------------------------------------------------------------------
  // 3. Circuit breaker alert uses "critical" severity
  // -------------------------------------------------------------------------
  test("circuit breaker alert severity is 'critical'", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    const calls = mockSendAlertThrottled.mock.calls;
    const circuitCall = calls.find((c) => c[1] === "circuit-breaker");
    expect(circuitCall).toBeDefined();
    expect(circuitCall![2]).toMatchObject({ severity: "critical" });
  });

  // -------------------------------------------------------------------------
  // 4. Budget exhaustion alert uses "warning" severity
  // -------------------------------------------------------------------------
  test("budget exhaustion alert severity is 'warning'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    const calls = mockSendAlertThrottled.mock.calls;
    const budgetCall = calls.find((c) => c[1] === "budget-exhausted");
    expect(budgetCall).toBeDefined();
    expect(budgetCall![2]).toMatchObject({ severity: "warning" });
  });

  // -------------------------------------------------------------------------
  // 5. Linear comment IS posted when budget is exhausted (not circuit breaker)
  // -------------------------------------------------------------------------
  test("budget exhaustion → Linear comment is posted", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // The workflow calls client.createComment directly (not via sendAlert)
    expect(mockLinearClient.createComment).toHaveBeenCalledWith(
      "TEST-1",
      expect.stringContaining("Budget Hold"),
    );
  });

  // -------------------------------------------------------------------------
  // 6. NO Linear comment when circuit breaker trips
  // -------------------------------------------------------------------------
  test("circuit breaker → NO Linear comment from the budget alert branch", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // The circuit-breaker branch must NOT call client.createComment directly
    // (sendAlert itself may call it, but the explicit circuit-breaker block must not)
    // We verify by checking that createComment was never called with "Budget Hold"
    const budgetCommentCall = mockLinearClient.createComment.mock.calls.find(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("Budget Hold"),
    );
    expect(budgetCommentCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // BUG PROBE: circuit breaker alert payload includes taskId, which causes
  // sendAlert (called by sendAlertThrottled) to post a Linear comment via
  // "Self-Heal" wording. The spec says NO Linear comment for circuit breaker.
  //
  // This test uses the REAL sendAlertThrottled implementation (not the no-op
  // left by vi.resetAllMocks) to properly catch the bug.
  // -------------------------------------------------------------------------
  test("circuit breaker → NO Linear comment of any kind (strict, real sendAlertThrottled)", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    // Restore real sendAlertThrottled so it actually calls through to sendAlert
    // (vi.resetAllMocks clears the implementation; we put it back for this test)
    const { sendAlertThrottled: realFn } = await vi.importActual<
      typeof import("../src/scheduler/alerts.js")
    >("../src/scheduler/alerts.js");
    mockSendAlertThrottled.mockImplementation(realFn);

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // createComment must not be called at all — not "Budget Hold", not
    // "[Orca Self-Heal] Circuit Breaker Tripped", not any wording.
    expect(mockLinearClient.createComment).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. step.sleep is called after budget exhaustion alert
  // -------------------------------------------------------------------------
  test("budget exhaustion → step.sleep is called", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. task/ready is re-emitted after the sleep
  // -------------------------------------------------------------------------
  test("budget exhaustion → task/ready re-emitted via inngest.send", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  // -------------------------------------------------------------------------
  // 9. insertBudgetEvent called even when costUsd = 0 (zero-cost failures recorded)
  //    This is tested via recordBudgetEventFromEvent, which is called after a
  //    session/completed event arrives. We get there by letting the task proceed
  //    past budget check and complete an implement session with costUsd = 0.
  // -------------------------------------------------------------------------
  test("session completing with costUsd=0 → insertBudgetEvent is still called", async () => {
    // Budget is fine so the workflow proceeds past budget check
    mockSumCostInWindow.mockReturnValue(0);
    mockCountZeroCost.mockReturnValue(0);

    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    // Session completes with costUsd = 0
    const sessionEvent = {
      name: "session/completed",
      data: {
        invocationId: 1,
        linearIssueId: "TEST-1",
        phase: "implement",
        exitCode: 0,
        summary: null,
        costUsd: 0,        // zero cost
        inputTokens: 0,
        outputTokens: 0,
        numTurns: 1,
        sessionId: "sess-abc",
        branchName: "orca/TEST-1-inv-1",
        worktreePath: "/tmp/worktree",
        isMaxTurns: false,
      },
    };

    const step = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async (id: string) => {
        activeHandles.clear();
        if (id === "await-implement") return sessionEvent;
        return null;
      }),
      sleep: vi.fn(async () => {}),
      sendEvent: vi.fn(async () => {}),
    };

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInsertBudgetEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ costUsd: 0 }),
    );
  });

  // -------------------------------------------------------------------------
  // 10a. Backoff delay = "5m" when 0 prior self_heal events
  // -------------------------------------------------------------------------
  test("0 prior self_heal events → backoff delay is '5m'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockCountSystemEvents.mockReturnValue(0); // 0 self_heal events
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "5m");
  });

  // -------------------------------------------------------------------------
  // 10b. Backoff delay = "10m" when 1 prior self_heal event
  // -------------------------------------------------------------------------
  test("1 prior self_heal event → backoff delay is '10m'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockCountSystemEvents.mockReturnValue(1); // 1 self_heal event
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "10m");
  });

  // -------------------------------------------------------------------------
  // 10c. Backoff delay = "20m" when 2 prior self_heal events
  // -------------------------------------------------------------------------
  test("2 prior self_heal events → backoff delay is '20m'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockCountSystemEvents.mockReturnValue(2); // 2 self_heal events
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "20m");
  });

  // -------------------------------------------------------------------------
  // 10d. Backoff delay = "30m" when >= 3 prior self_heal events
  // -------------------------------------------------------------------------
  test("3+ prior self_heal events → backoff delay is '30m'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockCountSystemEvents.mockReturnValue(5); // >3 self_heal events
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalledWith("budget-backoff", "30m");
  });

  // -------------------------------------------------------------------------
  // 11. Circuit breaker does NOT fire when zero-cost count is below threshold
  // -------------------------------------------------------------------------
  test("zero-cost count below threshold (4 < 5) → circuit breaker does NOT trip", async () => {
    mockCountZeroCost.mockReturnValue(4); // below threshold of 5
    mockSumCostInWindow.mockReturnValue(0); // budget fine too
    mockGetTask.mockReturnValue(makeTask());
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // No circuit-breaker alert should have been sent
    const circuitCall = mockSendAlertThrottled.mock.calls.find(
      (c) => c[1] === "circuit-breaker",
    );
    expect(circuitCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Edge: circuit breaker fires at exactly the threshold (boundary value)
  // -------------------------------------------------------------------------
  test("zero-cost count exactly at threshold (5) → circuit breaker trips", async () => {
    mockCountZeroCost.mockReturnValue(5); // exactly 5 = threshold
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "circuit-breaker",
      expect.objectContaining({ severity: "critical" }),
      expect.any(Number),
    );
  });

  // -------------------------------------------------------------------------
  // Edge: circuit breaker takes priority over budget exhaustion
  // -------------------------------------------------------------------------
  test("both budget exceeded AND circuit breaker tripped → circuit breaker takes priority", async () => {
    mockCountZeroCost.mockReturnValue(10); // circuit breaker
    mockSumCostInWindow.mockReturnValue(200); // also budget exceeded
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Should get circuit-breaker alert, not budget-exhausted
    const circuitCall = mockSendAlertThrottled.mock.calls.find(
      (c) => c[1] === "circuit-breaker",
    );
    const budgetCall = mockSendAlertThrottled.mock.calls.find(
      (c) => c[1] === "budget-exhausted",
    );
    expect(circuitCall).toBeDefined();
    expect(budgetCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Edge: outcome is still "budget_exceeded" for circuit breaker trips
  // -------------------------------------------------------------------------
  test("circuit breaker trips → outcome is 'budget_exceeded'", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
  });

  // -------------------------------------------------------------------------
  // Edge: task/ready re-emitted for circuit breaker (not just budget exhaustion)
  // -------------------------------------------------------------------------
  test("circuit breaker trips → task/ready still re-emitted via inngest.send", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  // -------------------------------------------------------------------------
  // Edge: step.sleep is called even for circuit breaker (same backoff path)
  // -------------------------------------------------------------------------
  test("circuit breaker trips → step.sleep is still called (shared backoff path)", async () => {
    mockCountZeroCost.mockReturnValue(5);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(step.sleep).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Edge: task not found → task/ready is NOT re-emitted (null guard)
  // -------------------------------------------------------------------------
  test("budget exceeded but task not found in DB → task/ready NOT re-emitted", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    // Return null from getTask so requeueTask is null
    mockGetTask.mockReturnValue(null);

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // The inngest.send re-emit should NOT be called when getTask returns null
    expect(mockInngestSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  // -------------------------------------------------------------------------
  // Edge: updateTaskStatus called with "ready" on budget hold (requeue step)
  // -------------------------------------------------------------------------
  test("budget exceeded → task status set back to 'ready'", async () => {
    mockSumCostInWindow.mockReturnValue(150);
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "ready");
  });
});
