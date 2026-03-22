// ---------------------------------------------------------------------------
// Resource-aware concurrency throttling tests (EMI-360)
//
// Verifies that the claim-task step in both task-lifecycle and
// cron-task-lifecycle skips dispatch when system resources are constrained.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-var
var capturedHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;

// eslint-disable-next-line no-var
var capturedCronHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        config: { id: string },
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        if (config.id === "task-lifecycle") {
          capturedHandler = handler;
        } else if (config.id === "cron-task-lifecycle") {
          capturedCronHandler = handler;
        }
        return { id: config.id };
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
  countZeroCostFailuresInWindow: vi.fn().mockReturnValue(0),
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

vi.mock("../src/scheduler/alerts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scheduler/alerts.js")>();
  return {
    ...actual,
    sendPermanentFailureAlert: vi.fn(),
  };
});

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

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// Mock system-resources so tests control resource check outcomes
vi.mock("../src/system-resources.js", () => ({
  checkResourceConstraints: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  getTask,
  claimTaskForDispatch,
  countActiveSessions,
  insertInvocation,
} from "../src/db/queries.js";
import { spawnSession } from "../src/runner/index.js";
import { createWorktree } from "../src/worktree/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import { checkResourceConstraints } from "../src/system-resources.js";
import "../src/inngest/workflows/task-lifecycle.js";
import "../src/inngest/workflows/cron-task-lifecycle.js";
import { activeHandles } from "../src/session-handles.js";
import { findPrForBranch } from "../src/github/index.js";
import {
  getLastMaxTurnsInvocation,
  getLastDeployInterruptedInvocation,
  getLastCompletedImplementInvocation,
  sumCostInWindow,
  sumTokensInWindow,
  budgetWindowStart,
} from "../src/db/queries.js";

const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockCountActiveSessions = vi.mocked(countActiveSessions);
const mockSpawnSession = vi.mocked(spawnSession);
const mockCheckResourceConstraints = vi.mocked(checkResourceConstraints);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockCreateWorktree = vi.mocked(createWorktree);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
const mockGetLastMaxTurnsInvocation = vi.mocked(getLastMaxTurnsInvocation);
const mockGetLastDeployInterruptedInvocation = vi.mocked(
  getLastDeployInterruptedInvocation,
);
const mockGetLastCompletedImplementInvocation = vi.mocked(
  getLastCompletedImplementInvocation,
);
const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockBudgetWindowStart = vi.mocked(budgetWindowStart);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockConfig = {
  concurrencyCap: 1,
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
  resourceMinMemoryGb: 2,
  resourceMaxCpuPercent: 80,
};

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

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

function makeTaskReadyEvent(taskId = "TEST-1", taskType = "feature") {
  return {
    name: "task/ready" as const,
    data: {
      linearIssueId: taskId,
      repoPath: "/repo",
      priority: 0,
      projectName: "test",
      taskType,
      createdAt: new Date().toISOString(),
    },
  };
}

function makeOkResourceResult() {
  return {
    ok: true,
    snapshot: { availableMemoryGb: 8, cpuLoadPercent: 20 },
  };
}

function makeLowMemoryResourceResult(availableGb = 1) {
  return {
    ok: false,
    reason: `insufficient memory: ${availableGb.toFixed(2)}GB available (minimum: 2GB)`,
    snapshot: { availableMemoryGb: availableGb, cpuLoadPercent: 20 },
  };
}

function makeHighCpuResourceResult(cpuPercent = 90) {
  return {
    ok: false,
    reason: `CPU load too high: ${cpuPercent.toFixed(1)}% (maximum: 80%)`,
    snapshot: { availableMemoryGb: 8, cpuLoadPercent: cpuPercent },
  };
}

function makeWindowsOkResourceResult() {
  return {
    ok: true,
    snapshot: { availableMemoryGb: 4, cpuLoadPercent: null },
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

  mockCountActiveSessions.mockReturnValue(0);
  mockCheckResourceConstraints.mockReturnValue(makeOkResourceResult());
  mockSumCostInWindow.mockReturnValue(0);
  mockSumTokensInWindow.mockReturnValue(0);
  mockBudgetWindowStart.mockReturnValue(new Date().toISOString());
  mockFindPrForBranch.mockReturnValue({ exists: false } as never);
  mockGetLastMaxTurnsInvocation.mockReturnValue(null);
  mockGetLastDeployInterruptedInvocation.mockReturnValue(null);
  mockGetLastCompletedImplementInvocation.mockReturnValue(null);
  mockInsertInvocation.mockReturnValue(1);
  mockCreateWorktree.mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  });
  mockSpawnSession.mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  } as never);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: {} as never,
  });
});

// ===========================================================================
// 1. task-lifecycle: resource throttle blocks claim
// ===========================================================================

describe("task-lifecycle: resource throttling in claim-task", () => {
  test("dispatch is skipped when memory is below threshold", async () => {
    mockCheckResourceConstraints.mockReturnValue(
      makeLowMemoryResourceResult(1),
    );

    const task = makeTask();
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("resource throttle"),
    });

    // Must not proceed to claim
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  test("dispatch is skipped when CPU load exceeds threshold", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeHighCpuResourceResult(90));

    const task = makeTask();
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("resource throttle"),
    });

    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  test("reason includes the resource constraint detail", async () => {
    const lowMem = makeLowMemoryResourceResult(0.5);
    mockCheckResourceConstraints.mockReturnValue(lowMem);

    const task = makeTask();
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("insufficient memory"),
    });
  });

  test("dispatch proceeds when resources are available", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeOkResourceResult());

    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // Provide session completion so workflow doesn't hang
    const step = createStep(
      new Map([
        [
          "await-implement",
          {
            name: "session/completed",
            data: {
              invocationId: 1,
              linearIssueId: "TEST-1",
              phase: "implement",
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
            },
          },
        ],
      ]),
    );

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Claim was attempted
    expect(mockClaimTaskForDispatch).toHaveBeenCalled();
  });

  test("concurrency cap check still runs before resource check", async () => {
    // Cap is exceeded — resource check should never be reached
    mockCountActiveSessions.mockReturnValue(1); // cap=1, at limit

    const task = makeTask();
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: "session cap reached",
    });

    // Resource check was never called
    expect(mockCheckResourceConstraints).not.toHaveBeenCalled();
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
  });

  test("Windows: dispatch proceeds when only memory is checked and memory is ok", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeWindowsOkResourceResult());

    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-implement",
          {
            name: "session/completed",
            data: {
              invocationId: 1,
              linearIssueId: "TEST-1",
              phase: "implement",
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
            },
          },
        ],
      ]),
    );

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockClaimTaskForDispatch).toHaveBeenCalled();
  });

  test("checkResourceConstraints is called with config thresholds", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeOkResourceResult());

    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-implement",
          {
            name: "session/completed",
            data: {
              invocationId: 1,
              linearIssueId: "TEST-1",
              phase: "implement",
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
            },
          },
        ],
      ]),
    );

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockCheckResourceConstraints).toHaveBeenCalledWith({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
  });
});

// ===========================================================================
// 2. cron-task-lifecycle: resource throttle blocks claim
// ===========================================================================

describe("cron-task-lifecycle: resource throttling in claim-task", () => {
  test("cron dispatch is skipped when memory is below threshold", async () => {
    mockCheckResourceConstraints.mockReturnValue(
      makeLowMemoryResourceResult(1),
    );

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("resource throttle"),
    });

    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  test("cron dispatch is skipped when CPU load exceeds threshold", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeHighCpuResourceResult(95));

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("resource throttle"),
    });

    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  test("cron concurrency cap check still runs before resource check", async () => {
    mockCountActiveSessions.mockReturnValue(1); // at cap

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);

    const step = createStep();
    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: "session cap reached",
    });

    expect(mockCheckResourceConstraints).not.toHaveBeenCalled();
  });

  test("cron dispatch proceeds when resources are available", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeOkResourceResult());

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-session",
          {
            name: "session/completed",
            data: { invocationId: 1, exitCode: 0 },
          },
        ],
      ]),
    );

    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(mockSpawnSession).toHaveBeenCalled();
  });

  test("cron checkResourceConstraints called with config thresholds", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeOkResourceResult());

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-session",
          {
            name: "session/completed",
            data: { invocationId: 1, exitCode: 0 },
          },
        ],
      ]),
    );

    await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(mockCheckResourceConstraints).toHaveBeenCalledWith({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
  });

  test("Windows: cron dispatch proceeds when cpuLoadPercent is null (ok=true)", async () => {
    mockCheckResourceConstraints.mockReturnValue(makeWindowsOkResourceResult());

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-session",
          {
            name: "session/completed",
            data: { invocationId: 1, exitCode: 0 },
          },
        ],
      ]),
    );

    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({ outcome: "done" });
  });
});
