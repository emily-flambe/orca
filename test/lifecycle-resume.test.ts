// ---------------------------------------------------------------------------
// EMI-342: Task-lifecycle workflow tests for isResumeNotFound handling
//
// Tests the handling of isResumeNotFound in src/inngest/workflows/task-lifecycle.ts.
// Uses same mock infrastructure as workflow-task-lifecycle.test.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted by vi.mock
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
  sumTokensInWindow: vi.fn().mockReturnValue(0),
  budgetWindowStart: vi.fn().mockReturnValue(new Date().toISOString()),
  incrementRetryCount: vi.fn(),
  incrementReviewCycleCount: vi.fn(),
  updateTaskPrBranch: vi.fn(),
  updateTaskCiInfo: vi.fn(),
  updateTaskPrState: vi.fn(),
  updateTaskDeployInfo: vi.fn(),
  updateTaskFixReason: vi.fn(),
  getLastMaxTurnsInvocation: vi.fn().mockReturnValue(null),
  getLastDeployInterruptedInvocation: vi.fn().mockReturnValue(null),
  getLastCompletedImplementInvocation: vi.fn().mockReturnValue(null),
  resetMergeAttemptCount: vi.fn(),
  resetStaleSessionRetryCount: vi.fn(),
  incrementMergeAttemptCount: vi.fn(),
  insertSystemEvent: vi.fn(),
  clearSessionIds: vi.fn(),
  countActiveSessions: vi.fn().mockReturnValue(0),
  budgetMaxTokens: 1000000,
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

vi.mock("../src/scheduler/alerts.js", () => ({
  sendAlert: vi.fn(),
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
  getDefaultBranch: vi.fn().mockReturnValue("main"),
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
  getInvocation,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  insertSystemEvent,
  incrementRetryCount,
  clearSessionIds,
  sumTokensInWindow,
  budgetWindowStart,
  getLastMaxTurnsInvocation,
  getLastDeployInterruptedInvocation,
  getLastCompletedImplementInvocation,
} from "../src/db/queries.js";
import { spawnSession } from "../src/runner/index.js";
import { findPrForBranch } from "../src/github/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { inngest } from "../src/inngest/client.js";
import { activeHandles } from "../src/session-handles.js";

const mockInngestSend = vi.mocked(inngest.send);
const mockGetTask = vi.mocked(getTask);
const mockGetInvocation = vi.mocked(getInvocation);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const _mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockInsertInvocation = vi.mocked(insertInvocation);
const _mockUpdateInvocation = vi.mocked(updateInvocation);
const _mockInsertSystemEvent = vi.mocked(insertSystemEvent);
const mockIncrementRetryCount = vi.mocked(incrementRetryCount);
const mockClearSessionIds = vi.mocked(clearSessionIds);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
const mockSpawnSession = vi.mocked(spawnSession);

const mockConfig = {
  budgetMaxTokens: 10_000_000,
  budgetWindowHours: 4,
  maxRetries: 3,
  model: "claude-sonnet-4-5",
  defaultMaxTurns: 200,
  claudePath: "claude",
  implementSystemPrompt: "",
  fixSystemPrompt: "",
  disallowedTools: "",
  maxDeployPollAttempts: 60,
  deployStrategy: "none" as const,
};

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

const mockDb = {} as never;

const STATUS_TO_LIFECYCLE: Record<
  string,
  { lifecycleStage: string; currentPhase: string | null }
> = {
  backlog: { lifecycleStage: "backlog", currentPhase: null },
  ready: { lifecycleStage: "ready", currentPhase: null },
  running: { lifecycleStage: "active", currentPhase: "implement" },
  awaiting_ci: { lifecycleStage: "active", currentPhase: "ci" },
  deploying: { lifecycleStage: "active", currentPhase: "deploy" },
  done: { lifecycleStage: "done", currentPhase: null },
  failed: { lifecycleStage: "failed", currentPhase: null },
  canceled: { lifecycleStage: "canceled", currentPhase: null },
};

function makeTask(overrides: Record<string, unknown> = {}) {
  const statusStr = (overrides.lifecycleStage as string) ?? "ready";
  const derived = STATUS_TO_LIFECYCLE[statusStr] ?? {
    lifecycleStage: null,
    currentPhase: null,
  };
  return {
    linearIssueId: "TEST-1",
    lifecycleStage: derived.lifecycleStage,
    currentPhase: derived.currentPhase,
    agentPrompt: "Fix the bug",
    repoPath: "/repo",
    prBranchName: null,
    prNumber: null,
    retryCount: 0,
    fixReason: null,
    mergeAttemptCount: 0,
    ...overrides,
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

      return waitForEventResponses.get(id) ?? null;
    }),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockBudgetWindowStart = vi.mocked(budgetWindowStart);
const mockGetLastMaxTurnsInvocation = vi.mocked(getLastMaxTurnsInvocation);
const mockGetLastDeployInterruptedInvocation = vi.mocked(
  getLastDeployInterruptedInvocation,
);
const mockGetLastCompletedImplementInvocation = vi.mocked(
  getLastCompletedImplementInvocation,
);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockCreateWorktree = vi.mocked(createWorktree);

beforeEach(() => {
  vi.resetAllMocks();
  activeHandles.clear();

  mockSumTokensInWindow.mockReturnValue(0);
  mockBudgetWindowStart.mockReturnValue(new Date().toISOString());

  mockGetLastMaxTurnsInvocation.mockReturnValue(null);
  mockGetLastDeployInterruptedInvocation.mockReturnValue(null);
  mockGetLastCompletedImplementInvocation.mockReturnValue(null);
  mockExistsSync.mockReturnValue(false);
  mockWriteBackStatus.mockResolvedValue(undefined);
  mockCreateWorktree.mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  });

  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockInsertInvocation.mockReturnValue(1);
  mockSpawnSession.mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  } as never);

  setSchedulerDeps({
    db: mockDb,
    config: mockConfig,
    graph: {} as never,
    client: mockLinearClient as never,
    stateMap: {} as never,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EMI-342: isResumeNotFound in task-lifecycle (implement phase)", () => {
  // -------------------------------------------------------------------------
  // BUG CANDIDATE A: retry must NOT increment the retry counter
  // -------------------------------------------------------------------------

  test("isResumeNotFound: returns retry WITHOUT incrementing retryCount", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
      isResumeNotFound: true,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(result).toMatchObject({ outcome: "retry" });
    // MUST NOT consume a retry slot
    expect(mockIncrementRetryCount).not.toHaveBeenCalled();
    // MUST clear the stale session ID
    expect(mockClearSessionIds).toHaveBeenCalledWith(mockDb, "TEST-1");
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE B: isResumeNotFound checked BEFORE the maxRetries gate
  //
  // Current code order in process-implement-and-gate2 (line ~797):
  //
  //   if (implementEvent.data.isResumeNotFound) {
  //     clearSessionIds(...)
  //     return { outcome: "retry" };   // ← returns before maxRetries check
  //   }
  //   if (task.retryCount >= config.maxRetries) {
  //     return { outcome: "permanent_fail" };
  //   }
  //
  // So a task at retryCount=3 (maxRetries) with isResumeNotFound=true should
  // still return "retry", not "permanent_fail".
  // -------------------------------------------------------------------------

  test("isResumeNotFound at maxRetries: still returns retry (not permanent_fail)", async () => {
    const task = makeTask({ retryCount: 3 }); // at cap
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
      isResumeNotFound: true,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Must be retry, not permanent_fail — this is a setup failure
    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockIncrementRetryCount).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE C: task/ready event is re-sent after isResumeNotFound retry
  // -------------------------------------------------------------------------

  test("isResumeNotFound: task/ready event is re-sent to trigger fresh dispatch", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
      isResumeNotFound: true,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // task/ready must be re-fired so the new workflow picks it up
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE D: normal failure (isResumeNotFound=false) still increments
  // retry counter (regression guard)
  // -------------------------------------------------------------------------

  test("normal failure (isResumeNotFound=false) still increments retryCount", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
      isResumeNotFound: false,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Normal failure must still count against retries
    expect(mockIncrementRetryCount).toHaveBeenCalledWith(mockDb, "TEST-1");
    expect(mockClearSessionIds).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE E: isResumeNotFound with a SUCCESS exitCode (edge case)
  //
  // The !isSuccess guard (exitCode===0 && !isMaxTurns) gates the
  // isResumeNotFound check. So if somehow exitCode=0 but isResumeNotFound=true,
  // the code falls through to Gate 2 without clearing session IDs.
  // -------------------------------------------------------------------------

  test("isResumeNotFound with exitCode=0 is NOT handled (falls through to Gate 2)", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockGetInvocation.mockReturnValue({ outputSummary: "" });
    mockFindPrForBranch.mockReturnValue({ exists: false });

    // exitCode=0 (treated as success), but isResumeNotFound=true
    const ambiguousEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 0,
      isMaxTurns: false,
      isResumeNotFound: true,
    });
    const step = createStep(new Map([["await-implement", ambiguousEvent]]));

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    // Session IDs are NOT cleared — the isResumeNotFound guard only fires
    // when !isSuccess. exitCode=0 is isSuccess, so the check is skipped.
    expect(mockClearSessionIds).not.toHaveBeenCalled();
  });
});

// EMI-342 fix-phase isResumeNotFound test removed in EMI-504 (review phase removal)
