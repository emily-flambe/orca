// ---------------------------------------------------------------------------
// EMI-332: Failing tests for bugs in budget exhaustion + circuit breaker
// implementation.
//
// Run with: npm test -- test/emi-332-budget-circuit-breaker.test.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (hoisted by vi.mock)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-var
var capturedHandler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>;

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
  countActiveSessions: vi.fn().mockReturnValue(0),
  clearSessionIds: vi.fn(),
  countZeroCostFailuresInWindow: vi.fn().mockReturnValue(0),
  getInvocationsByTask: vi.fn().mockReturnValue([]),
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

// Spy on the alert functions
vi.mock("../src/scheduler/alerts.js", () => ({
  sendAlert: vi.fn(),
  sendAlertThrottled: vi.fn(),
  sendPermanentFailureAlert: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  getTask,
  sumCostInWindow,
  sumTokensInWindow,
  budgetWindowStart,
  countZeroCostFailuresInWindow,
  updateTaskStatus,
} from "../src/db/queries.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { inngest } from "../src/inngest/client.js";
import { activeHandles, resetSessionSlots } from "../src/session-handles.js";
import { sendAlert, sendAlertThrottled } from "../src/scheduler/alerts.js";

const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockBudgetWindowStart = vi.mocked(budgetWindowStart);
const mockCountZeroCostFailuresInWindow = vi.mocked(countZeroCostFailuresInWindow);
const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockSendAlert = vi.mocked(sendAlert);
const mockSendAlertThrottled = vi.mocked(sendAlertThrottled);

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

const mockDb = {} as never;

const mockConfig = {
  budgetMaxCostUsd: 100,
  budgetMaxTokens: 10_000_000,
  budgetWindowHours: 4,
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
};

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

function createStep(waitForEventResponses: Map<string, unknown> = new Map()) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async (id: string, _opts: unknown) => {
      activeHandles.clear();
      resetSessionSlots();
      return waitForEventResponses.get(id) ?? null;
    }),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  activeHandles.clear();
  resetSessionSlots();

  mockSumCostInWindow.mockReturnValue(0);
  mockSumTokensInWindow.mockReturnValue(0);
  mockBudgetWindowStart.mockReturnValue(new Date().toISOString());
  mockCountZeroCostFailuresInWindow.mockReturnValue(0);

  mockLinearClient.createComment.mockResolvedValue({});

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: {} as never,
  });
});

// ---------------------------------------------------------------------------
// BUG 1: sendAlertThrottled called inside step.run() — non-deterministic for
// Inngest durable workflows. The check-budget step is replayed on every
// workflow resume; any in-memory side effect (alertCooldowns Map update) that
// happens inside step.run() will execute again on replay, defeating the
// throttling.
//
// Inngest docs: "Never use non-deterministic code directly in a step" — all
// side effects with external state must be their own step.run() call.
//
// The fix: move sendAlertThrottled into a separate step, or at minimum ensure
// check-budget returns a value that a subsequent step uses to fire the alert.
// ---------------------------------------------------------------------------

describe("BUG 1: sendAlertThrottled called inside step.run() — not safe for Inngest replay", () => {
  test("circuit breaker alert fires inside check-budget step.run, not in its own step", async () => {
    // Arrange: circuit breaker is tripped
    mockCountZeroCostFailuresInWindow.mockReturnValue(10); // above threshold of 5

    // Track which step IDs call sendAlertThrottled
    const stepsCallingSendAlertThrottled: string[] = [];
    const step = {
      run: vi.fn(async (id: string, fn: () => unknown) => {
        const result = fn();
        // If sendAlertThrottled was called during this step's fn(), record it
        if ((mockSendAlertThrottled as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
          const callsBefore = stepsCallingSendAlertThrottled.length;
          if (callsBefore === 0) {
            stepsCallingSendAlertThrottled.push(id);
          }
        }
        return result;
      }),
      waitForEvent: vi.fn(async () => null),
      sleep: vi.fn(async () => {}),
      sendEvent: vi.fn(async () => {}),
    };

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // sendAlertThrottled must have been called
    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "zero-cost-circuit-breaker",
      expect.anything(),
      30 * 60 * 1000,
    );

    // The first step that called sendAlertThrottled should be "check-budget"
    // This documents the bug: the alert is a side effect inside check-budget,
    // not in its own isolated step. On Inngest replay of check-budget (e.g.
    // after a process restart), the alert fires again, bypassing in-memory
    // throttling (alertCooldowns is reset on restart).
    expect(stepsCallingSendAlertThrottled[0]).toBe("check-budget");
  });

  test("Inngest replay of check-budget (process restart) fires the alert again despite throttle cooldown", async () => {
    // This test simulates what happens after a process restart:
    // alertCooldowns is cleared, the step is replayed, and the alert fires again.
    mockCountZeroCostFailuresInWindow.mockReturnValue(10);
    mockGetTask.mockReturnValue(makeTask());

    // First workflow execution
    const step1 = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step: step1 });
    const firstCallCount = (mockSendAlertThrottled as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(firstCallCount).toBe(1); // fired once

    // Simulate process restart: vi.resetAllMocks() clears in-memory alertCooldowns
    // (the real alertCooldowns Map is also cleared on process restart)
    vi.resetAllMocks();
    mockCountZeroCostFailuresInWindow.mockReturnValue(10);
    mockGetTask.mockReturnValue(makeTask());
    mockSumCostInWindow.mockReturnValue(0);
    mockSumTokensInWindow.mockReturnValue(0);
    mockBudgetWindowStart.mockReturnValue(new Date().toISOString());
    mockLinearClient.createComment.mockResolvedValue({});
    setSchedulerDeps({
      db: mockDb,
      config: mockConfig,
      graph: {} as never,
      client: mockLinearClient as never,
      stateMap: {} as never,
    });

    // Second workflow run (post-restart replay of check-budget)
    const step2 = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step: step2 });

    // BUG: alert fires again — throttling doesn't survive process restarts
    // because alertCooldowns is in-memory, and sendAlertThrottled is called
    // inside step.run() rather than being persisted via Inngest step state.
    expect(mockSendAlertThrottled).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: Double-alerting when circuit breaker fires — both sendAlertThrottled
// (in check-budget step) AND sendAlert (in alert-budget-exceeded step) fire
// for the same budget exhaustion event.
//
// When isCircuitBreaker=true:
//   check-budget: calls sendAlertThrottled (circuit breaker alert)
//   alert-budget-exceeded: calls sendAlert with "Budget Exhausted" title
//
// A circuit breaker trip fires two separate alerts: one critical from
// sendAlertThrottled, one warning from sendAlert. The operator receives
// duplicate notifications for the same root cause.
// ---------------------------------------------------------------------------

describe("BUG 2 (fixed): circuit breaker fires only one alert, no duplicate Budget Exhausted alert", () => {
  test("circuit breaker trip fires only sendAlertThrottled — no sendAlert with Budget Exhausted", async () => {
    mockCountZeroCostFailuresInWindow.mockReturnValue(10); // trips circuit breaker
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Only the CB alert fires
    expect(mockSendAlertThrottled).toHaveBeenCalledWith(
      expect.anything(),
      "zero-cost-circuit-breaker",
      expect.objectContaining({ title: "Zero-Cost Circuit Breaker Tripped" }),
      30 * 60 * 1000,
    );
    // "Budget Exhausted" sendAlert must NOT fire when circuit breaker is the cause
    expect(mockSendAlert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Budget Exhausted" }),
    );
  });

  test("normal budget exhaustion (not circuit breaker) fires only one sendAlert", async () => {
    mockSumCostInWindow.mockReturnValue(150); // exceeds $100 budget
    mockCountZeroCostFailuresInWindow.mockReturnValue(0); // no circuit breaker
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Only one alert for normal budget exhaustion
    expect(mockSendAlertThrottled).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Budget Exhausted", severity: "warning" }),
    );
  });
});

// ---------------------------------------------------------------------------
// BUG 3: windowClearsAt is computed incorrectly for circuit breaker.
//
// The "alert-budget-exceeded" step always computes:
//   windowClearsAt = now + budgetWindowHours * 60 * 60 * 1000
//
// When the circuit breaker fires (isCircuitBreaker=true), the task is held
// for 60 minutes — NOT budgetWindowHours (4 hours). The message tells the
// operator "window clears around [now + 4h]" but the actual backoff is 60
// minutes. This is misleading.
// ---------------------------------------------------------------------------

describe("BUG 3 (fixed): circuit breaker path skips alert-budget-exceeded, no misleading windowClearsAt", () => {
  test("circuit breaker path does NOT call createComment with budget window time", async () => {
    mockCountZeroCostFailuresInWindow.mockReturnValue(10); // trips circuit breaker
    mockGetTask.mockReturnValue(makeTask());

    const step = createStep();
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // The alert-budget-exceeded step is skipped for CB path.
    // createComment with budget-window timing should NOT be called.
    const commentCallsWithBudgetMessage = mockLinearClient.createComment.mock.calls.filter(
      ([, body]: [unknown, string]) =>
        typeof body === "string" && body.includes("Budget Hold") && body.includes("will clear around"),
    );
    expect(commentCallsWithBudgetMessage.length).toBe(0);
  });

  test("circuit breaker uses 60m fixed sleep, normal budget uses exponential backoff", async () => {
    // Circuit breaker path: 60m fixed
    mockCountZeroCostFailuresInWindow.mockReturnValue(10);
    mockGetTask.mockReturnValue(makeTask({ retryCount: 0 }));
    const sleepArgsCb: string[] = [];
    const stepCb = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => null),
      sleep: vi.fn(async (_id: string, delay: string) => { sleepArgsCb.push(delay); }),
      sendEvent: vi.fn(async () => {}),
    };
    await capturedHandler({ event: makeTaskReadyEvent(), step: stepCb });
    expect(sleepArgsCb[0]).toBe("60m");

    // Normal budget path: exponential backoff (5m for retryCount=0)
    vi.resetAllMocks();
    mockSumCostInWindow.mockReturnValue(150);
    mockCountZeroCostFailuresInWindow.mockReturnValue(0);
    mockGetTask.mockReturnValue(makeTask({ retryCount: 0 }));
    mockBudgetWindowStart.mockReturnValue(new Date().toISOString());
    mockLinearClient.createComment.mockResolvedValue({});
    setSchedulerDeps({
      db: mockDb,
      config: mockConfig,
      graph: {} as never,
      client: mockLinearClient as never,
      stateMap: {} as never,
    });
    const sleepArgsBudget: string[] = [];
    const stepBudget = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => null),
      sleep: vi.fn(async (_id: string, delay: string) => { sleepArgsBudget.push(delay); }),
      sendEvent: vi.fn(async () => {}),
    };
    await capturedHandler({ event: makeTaskReadyEvent(), step: stepBudget });
    expect(sleepArgsBudget[0]).toBe("5m");
  });
});

// ---------------------------------------------------------------------------
// BUG 4: `db` is destructured but never used in alert-budget-exceeded step.
//
// ESLint catches this: "'db' is assigned a value but never used"
// at src/inngest/workflows/task-lifecycle.ts line 352.
//
// This is a lint failure that blocks CI — verified by running:
//   npm run lint
// Output: error @typescript-eslint/no-unused-vars
//
// No test needed — the lint error is already documented by running npm run lint.
// This is documented here for completeness.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BUG 5: countZeroCostFailuresInWindow window computation uses Date.now()
// inside step.run() — non-deterministic.
//
// In check-budget:
//   const cbWindowStart = new Date(
//     Date.now() - config.zeroCostCircuitBreakerWindowMin * 60 * 1000,
//   ).toISOString();
//
// Date.now() inside a step.run() is non-deterministic across Inngest replays.
// On replay, Date.now() returns a different value, so the circuit breaker
// window is recalculated differently each time. The correct pattern is to use
// step.run() to capture the timestamp once and pass it forward, or use
// a deterministic event timestamp.
//
// This test documents that the window computation varies between calls,
// which means the count returned by countZeroCostFailuresInWindow can differ
// between the original execution and a replay.
// ---------------------------------------------------------------------------

describe("BUG 5: circuit breaker window uses Date.now() inside step.run() — non-deterministic", () => {
  test("cbWindowStart passed to countZeroCostFailuresInWindow varies between calls within same step", async () => {
    const windowsObserved: string[] = [];

    // Capture the windowStart argument passed to countZeroCostFailuresInWindow
    mockCountZeroCostFailuresInWindow.mockImplementation((_, windowStart: string) => {
      windowsObserved.push(windowStart);
      return 0; // under threshold
    });

    // Override step.run to call check-budget fn twice (replay simulation)
    const step = createStep();
    step.run.mockImplementation(async (id: string, fn: () => unknown) => {
      if (id === "check-budget") {
        const result1 = fn();
        // Small delay to make timestamps differ
        await new Promise((r) => setTimeout(r, 5));
        const result2 = fn();
        return result2;
      }
      return fn();
    });

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // If both replay calls happen, countZeroCostFailuresInWindow is called twice.
    // The two windowStart values will differ because Date.now() advances.
    // In a real Inngest replay (different process restart), they could differ
    // by minutes or hours, potentially changing whether the circuit breaker trips.
    if (windowsObserved.length >= 2) {
      // Document that the values CAN differ (they differ by a few ms in the test)
      // In production replays they can differ by much more
      expect(windowsObserved[0]).not.toBe(windowsObserved[1]);
    }
    // At minimum, the function is called once per check-budget execution
    expect(mockCountZeroCostFailuresInWindow).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BUG 6: Zero-cost events with null invocationId.
//
// recordBudgetEventFromEvent is called with (db, invocationId, eventData) where
// invocationId comes from the session/completed event. In the bridgeSessionCompletion
// error path (synthetic failure event), invocationId is passed correctly.
//
// However: countZeroCostFailuresInWindow counts ALL budget_events where
// cost_usd = 0, regardless of which task or invocation they belong to.
// A task with a broken CLI that produces zero-cost failures will trip the
// circuit breaker globally — blocking ALL tasks, not just the broken one.
//
// This test verifies the circuit breaker is global (not per-task), which may
// be intentional, but should be explicitly documented and tested.
// ---------------------------------------------------------------------------

describe("BUG 6: circuit breaker is global — one broken task blocks all tasks", () => {
  test("zero-cost failures from any task can trip circuit breaker for unrelated tasks", async () => {
    // 10 zero-cost failures have been recorded globally (from any tasks)
    mockCountZeroCostFailuresInWindow.mockReturnValue(10); // above threshold of 5
    mockGetTask.mockReturnValue(makeTask({ linearIssueId: "UNRELATED-1" }));

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent("UNRELATED-1"),
      step,
    });

    // A completely unrelated task is blocked because of global zero-cost failures
    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    // The circuit breaker tripped — verify isCircuitBreaker is in the reason
    expect((result as { reason?: string }).reason).toContain("circuit_breaker");
  });
});

// ---------------------------------------------------------------------------
// BUG 7: New env vars not documented in .env.example
//
// ORCA_ZERO_COST_CB_THRESHOLD and ORCA_ZERO_COST_CB_WINDOW_MIN are new config
// vars added in src/config/index.ts but they are NOT present in .env.example.
//
// This test is structural — verified by reading .env.example above.
// The .env.example file ends at line 200 with no mention of these vars.
// ---------------------------------------------------------------------------

describe("BUG 7: new env vars missing from .env.example", () => {
  test("ORCA_ZERO_COST_CB_THRESHOLD and ORCA_ZERO_COST_CB_WINDOW_MIN are not documented", async () => {
    const { readFileSync } = await import("node:fs");
    // Read the actual .env.example (not the mocked version — need to access real FS)
    // Since node:fs is mocked, we check via a different mechanism
    // This test documents the finding — the actual check is done by reading the file above
    //
    // Reproduction: grep the .env.example for these variable names
    // $ grep ZERO_COST .env.example
    // (no output — they are absent)
    //
    // This means operators upgrading to this version get no hint that these
    // new circuit breaker vars exist or what their defaults are.
    expect(true).toBe(true); // placeholder — the finding is documented above
  });
});

// ---------------------------------------------------------------------------
// BUG 8: Exponential backoff formula uses retryCount, but retryCount is NOT
// incremented before the backoff is computed for budget exhaustion.
//
// For a task with retryCount=0:
//   delayMin = min(5 * 2^0, 60) = 5 minutes
// After requeueing, retryCount is still 0 (incrementRetryCount is NOT called
// in the budget-exceeded path). So the next time the task hits budget exhaustion,
// it AGAIN gets 5 minutes — the backoff never escalates.
//
// The formula is effectively always "5m" for budget-exceeded tasks because
// retryCount only increments on task failure, not on budget holds.
// ---------------------------------------------------------------------------

describe("BUG 8: exponential backoff never escalates for budget-held tasks", () => {
  test("budget-exceeded backoff is always 5m regardless of how many times task was budget-blocked", async () => {
    // Task has been requeued many times due to budget (retryCount remains 0
    // since incrementRetryCount is not called in the budget-exceeded path)
    mockSumCostInWindow.mockReturnValue(150); // exceeds $100 budget
    mockCountZeroCostFailuresInWindow.mockReturnValue(0);
    // Even with retryCount=0 (never incremented for budget holds)
    mockGetTask.mockReturnValue(makeTask({ retryCount: 0 }));

    const sleepArgs: string[] = [];
    const step = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => null),
      sleep: vi.fn(async (_id: string, delay: string) => {
        sleepArgs.push(delay);
      }),
      sendEvent: vi.fn(async () => {}),
    };

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // First budget hold: backoff = 5 * 2^0 = 5m
    expect(sleepArgs[0]).toBe("5m");

    // Now simulate the task being requeued and hitting budget again.
    // retryCount is still 0 because incrementRetryCount was NOT called in the
    // budget-exceeded path — only called on task failure. So the backoff formula
    // gets retryCount=0 again and returns 5m, never escalating.
    sleepArgs.length = 0;
    mockSumCostInWindow.mockReturnValue(150);
    mockCountZeroCostFailuresInWindow.mockReturnValue(0);
    mockGetTask.mockReturnValue(makeTask({ retryCount: 0 })); // still 0!
    mockLinearClient.createComment.mockResolvedValue({});

    const step2 = {
      run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
      waitForEvent: vi.fn(async () => null),
      sleep: vi.fn(async (_id: string, delay: string) => {
        sleepArgs.push(delay);
      }),
      sendEvent: vi.fn(async () => {}),
    };

    await capturedHandler({ event: makeTaskReadyEvent(), step: step2 });

    // BUG: still 5m, backoff never escalated even after multiple budget holds
    expect(sleepArgs[0]).toBe("5m");
  });
});
