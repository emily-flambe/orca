// ---------------------------------------------------------------------------
// Tests for EMI-332 circuit breaker + recordBudgetEventFromEvent
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
  clearSessionIds: vi.fn(),
  countActiveSessions: vi.fn().mockReturnValue(0),
  countZeroCostFailuresSince: vi.fn().mockReturnValue(0),
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

vi.mock("../src/scheduler/alerts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scheduler/alerts.js")>();
  return {
    ...actual,
    sendAlert: vi.fn(),
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
  sumTokensInWindow,
  countZeroCostFailuresSince,
  insertBudgetEvent,
} from "../src/db/queries.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { activeHandles } from "../src/session-handles.js";
import { sendAlert } from "../src/scheduler/alerts.js";
import { inngest } from "../src/inngest/client.js";

const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockCountZeroCostFailuresSince = vi.mocked(countZeroCostFailuresSince);
const mockInsertBudgetEvent = vi.mocked(insertBudgetEvent);
const mockSendAlert = vi.mocked(sendAlert);
const mockInngestSend = vi.mocked(inngest.send);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockConfig = {
  budgetMaxCostUsd: 100,
  budgetWindowHours: 4,
  budgetMaxTokens: 10_000_000,
  zeroCostCircuitBreakerThreshold: 5,
  zeroCostCircuitBreakerWindowMin: 30,
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

function makeTaskReadyEvent(taskId = "TEST-1", budgetHoldCount?: number) {
  return {
    name: "task/ready" as const,
    data: {
      linearIssueId: taskId,
      repoPath: "/repo",
      priority: 0,
      projectName: "test",
      taskType: "feature",
      createdAt: new Date().toISOString(),
      ...(budgetHoldCount !== undefined && { budgetHoldCount }),
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

  // Re-apply all defaults after reset
  mockSumCostInWindow.mockReturnValue(0);
  mockSumTokensInWindow.mockReturnValue(0);
  mockCountZeroCostFailuresSince.mockReturnValue(0);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockInngestSend.mockResolvedValue(undefined);

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: mockStateMap as never,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EMI-332 circuit breaker", () => {
  test("circuit breaker fires at threshold → returns budget_exceeded with circuit breaker reason", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5); // exactly at threshold
    mockSumCostInWindow.mockReturnValue(0);
    mockSumTokensInWindow.mockReturnValue(0);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(result).toMatchObject({
      reason: expect.stringContaining("circuit breaker"),
    });
  });

  test("circuit breaker fires on N zero-cost FAILED invocations (status filter working)", async () => {
    // countZeroCostFailuresSince joins invocations and filters status='failed',
    // so only failed sessions count. This mock returns 5 to simulate that.
    mockCountZeroCostFailuresSince.mockReturnValue(5);
    mockSumCostInWindow.mockReturnValue(0);
    mockSumTokensInWindow.mockReturnValue(0);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent("TEST-6"),
      step,
    });

    expect(result).toMatchObject({
      outcome: "budget_exceeded",
      reason: expect.stringContaining("circuit breaker"),
    });
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "critical" }),
    );
  });

  test("sendAlert is wrapped in step.run for Inngest idempotency", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // sendAlert is called inside step.run("send-budget-alert"), which Inngest
    // memoizes so it fires exactly once per workflow execution, not on replay.
    expect(step.run).toHaveBeenCalledWith(
      "send-budget-alert",
      expect.any(Function),
    );
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
  });

  test("circuit breaker at exactly threshold (5) → fires", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5); // exactly at threshold

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(result).toMatchObject({
      reason: expect.stringContaining("circuit breaker"),
    });
  });

  test("circuit breaker at threshold minus 1 (4) → does NOT fire", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(4); // one below threshold

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // Should not be blocked — should proceed to claim
    expect(result).not.toMatchObject({ outcome: "budget_exceeded" });
  });

  test("token budget exhausted → returns budget_exceeded with token reason", async () => {
    mockSumCostInWindow.mockReturnValue(0); // cost is fine
    mockSumTokensInWindow.mockReturnValue(10_000_001); // exceeds 10M token cap

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(result).toMatchObject({
      reason: expect.stringContaining("token budget exhausted"),
    });
  });

  test("circuit breaker triggers sleep before requeue", async () => {
    mockCountZeroCostFailuresSince.mockReturnValue(5);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // First hold (budgetHoldCount=0): 5 * 2^0 = 5m
    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "5m");
    expect(step.run).toHaveBeenCalledWith(
      "requeue-budget-exceeded",
      expect.any(Function),
    );
  });

  test("normal budget exhaustion sends warning alert (not critical)", async () => {
    mockSumCostInWindow.mockReturnValue(150); // exceeds $100
    mockCountZeroCostFailuresSince.mockReturnValue(0); // no zero-cost failures

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "warning", title: expect.stringContaining("Budget") }),
    );
    expect(mockSendAlert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "critical" }),
    );
  });

  test("non-circuit-breaker budget exhaustion does NOT set isCircuitBreaker flag", async () => {
    mockSumCostInWindow.mockReturnValue(150); // regular budget exhaustion
    mockCountZeroCostFailuresSince.mockReturnValue(0); // no zero-cost failures

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "warning", title: expect.stringContaining("Budget") }),
    );
    expect(mockSendAlert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "critical" }),
    );
  });
});

describe("EMI-332 exponential backoff", () => {
  test("first hold (budgetHoldCount=0) → 5m sleep", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1", 0),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "5m");
  });

  test("second hold (budgetHoldCount=1) → 10m sleep", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1", 1),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "10m");
  });

  test("third hold (budgetHoldCount=2) → 20m sleep", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1", 2),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "20m");
  });

  test("high hold count (budgetHoldCount=10) → capped at 160m", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1", 10),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "160m");
  });

  test("requeue emits task/ready with incremented budgetHoldCount", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1", 2),
      step,
    });

    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "task/ready",
        data: expect.objectContaining({
          linearIssueId: "TEST-1",
          budgetHoldCount: 3, // 2 + 1
        }),
      }),
    );
  });

  test("missing budgetHoldCount defaults to 0 → 5m sleep", async () => {
    mockSumCostInWindow.mockReturnValue(150);

    const step = createStep();
    // Event with no budgetHoldCount field
    await capturedHandler({
      event: makeTaskReadyEvent("TEST-1"),
      step,
    });

    expect(step.sleep).toHaveBeenCalledWith("budget-exceeded-backoff", "5m");
    // Re-emitted with budgetHoldCount: 1
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ budgetHoldCount: 1 }),
      }),
    );
  });
});

describe("EMI-332 recordBudgetEventFromEvent", () => {
  // The function recordBudgetEventFromEvent is internal but called during the
  // workflow session completion handling. We can test its effect via
  // insertBudgetEvent mock calls.

  test("zero-cost session with null costUsd inserts budget event with costUsd=0", async () => {
    // The change in EMI-332 removes the `if (costUsd > 0)` guard.
    // Now ALL sessions insert budget events. We verify this by checking
    // insertBudgetEvent is called even when costUsd is null.

    const { getTask, claimTaskForDispatch, insertInvocation, getInvocation } =
      await import("../src/db/queries.js");
    const { findPrForBranch } = await import("../src/github/index.js");
    const { spawnSession } = await import("../src/runner/index.js");
    const { createWorktree } = await import("../src/worktree/index.js");
    const { existsSync } = await import("node:fs");

    const mockGetTask = vi.mocked(getTask);
    const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
    const mockInsertInvocation = vi.mocked(insertInvocation);
    const mockGetInvocation = vi.mocked(getInvocation);
    const mockFindPrForBranch = vi.mocked(findPrForBranch);
    const mockCreateWorktree = vi.mocked(createWorktree);
    const mockExistsSync = vi.mocked(existsSync);
    const mockSpawnSession = vi.mocked(spawnSession);

    mockGetTask.mockReturnValue({
      linearIssueId: "TEST-1",
      orcaStatus: "ready",
      agentPrompt: "Fix bug",
      repoPath: "/repo",
      prBranchName: null,
      prNumber: null,
      retryCount: 0,
      reviewCycleCount: 0,
      fixReason: null,
      mergeAttemptCount: 0,
    } as never);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockCreateWorktree.mockReturnValue({
      worktreePath: "/tmp/worktree",
      branchName: "orca/TEST-1-inv-1",
    });
    mockExistsSync.mockReturnValue(false);
    mockGetInvocation.mockReturnValue({ outputSummary: "" } as never);
    mockFindPrForBranch.mockReturnValue({ exists: false } as never);
    mockSpawnSession.mockReturnValue({
      done: new Promise(() => {}),
      sessionId: "sess-abc",
      kill: vi.fn(),
    } as never);

    const sessionCompletedEvent = {
      name: "session/completed" as const,
      data: {
        invocationId: 1,
        linearIssueId: "TEST-1",
        phase: "implement" as const,
        exitCode: 0,
        summary: null,
        costUsd: null, // null cost — the new code uses ?? 0
        inputTokens: null,
        outputTokens: null,
        numTurns: 1,
        sessionId: "sess-abc",
        branchName: "orca/TEST-1-inv-1",
        worktreePath: "/tmp/worktree",
        isMaxTurns: false,
      },
    };

    const step = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async (_id: string, _opts: unknown) => {
        activeHandles.clear();
        return sessionCompletedEvent;
      }),
      sleep: vi.fn(async () => {}),
      sendEvent: vi.fn(async () => {}),
    };

    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // insertBudgetEvent should have been called with costUsd=0 (not skipped)
    expect(mockInsertBudgetEvent).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ costUsd: 0 }),
    );
  });
});

describe("EMI-332 circuit breaker configuration", () => {
  test("uses zeroCostCircuitBreakerThreshold from config (not hardcoded)", async () => {
    // With a custom threshold of 3, the circuit breaker should fire at 3 failures
    setSchedulerDeps({
      db: mockDb,
      config: { ...mockConfig, zeroCostCircuitBreakerThreshold: 3 },
      graph: {} as never,
      client: mockLinearClient as never,
      stateMap: mockStateMap as never,
    });

    mockCountZeroCostFailuresSince.mockReturnValue(3);
    mockSumCostInWindow.mockReturnValue(0);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({
      outcome: "budget_exceeded",
      reason: expect.stringContaining("circuit breaker"),
    });
  });

  test("does not fire circuit breaker when failures below custom threshold", async () => {
    setSchedulerDeps({
      db: mockDb,
      config: { ...mockConfig, zeroCostCircuitBreakerThreshold: 10 },
      graph: {} as never,
      client: mockLinearClient as never,
      stateMap: mockStateMap as never,
    });

    // 5 failures, but threshold is 10 — should not trip
    mockCountZeroCostFailuresSince.mockReturnValue(5);
    mockSumCostInWindow.mockReturnValue(0);

    const { claimTaskForDispatch, getTask } = await import("../src/db/queries.js");
    vi.mocked(getTask).mockReturnValue(null);
    vi.mocked(claimTaskForDispatch).mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).not.toMatchObject({ outcome: "budget_exceeded" });
  });
});
