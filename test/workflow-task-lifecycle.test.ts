// ---------------------------------------------------------------------------
// Integration tests for task-lifecycle Inngest workflow
//
// Strategy: mock the inngest client to capture the handler, then call it
// directly with a mock step object that executes step functions immediately.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

// Captured handler and config from inngest.createFunction
// Must be `var` (not `let`) so it's hoisted and accessible when vi.mock runs
// eslint-disable-next-line no-var
var capturedHandler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>;
// eslint-disable-next-line no-var
var capturedFunctionConfig: { cancelOn?: unknown[] };

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        config: { cancelOn?: unknown[] },
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
        capturedFunctionConfig = config;
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
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn().mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  }),
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
  sumCostInWindow,
  incrementRetryCount,
} from "../src/db/queries.js";
import { spawnSession } from "../src/runner/index.js";
import { findPrForBranch } from "../src/github/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { initTaskLifecycle } from "../src/inngest/workflows/task-lifecycle.js";

// Typed mocks
const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockIncrementRetryCount = vi.mocked(incrementRetryCount);
const mockSpawnSession = vi.mocked(spawnSession);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
const mockGetInvocation = vi.mocked(getInvocation);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockCreateWorktree = vi.mocked(createWorktree);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockConfig = {
  budgetMaxCostUsd: 100,
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
};

const mockLinearClient = {
  createComment: vi.fn().mockResolvedValue({}),
  createAttachment: vi.fn().mockResolvedValue({}),
};

const mockStateMap = {};
// Using a minimal DB stand-in (queries are all mocked)
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

/**
 * Creates a mock step that executes step.run() fns immediately and returns
 * pre-configured responses for step.waitForEvent().
 */
function createStep(
  waitForEventResponses: Map<string, unknown> = new Map(),
) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(
      async (id: string, _opts: unknown) => waitForEventResponses.get(id) ?? null,
    ),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();

  // Re-apply defaults after reset
  mockSumCostInWindow.mockReturnValue(0);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockExistsSync.mockReturnValue(false);
  mockWriteBackStatus.mockResolvedValue(undefined);
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

  // Initialize deps so getDeps() works in the workflow
  initTaskLifecycle({
    db: mockDb,
    config: mockConfig,
    client: mockLinearClient as never,
    stateMap: mockStateMap as never,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("task-lifecycle workflow", () => {
  test("budget exceeded → returns budget_exceeded outcome", async () => {
    mockSumCostInWindow.mockReturnValue(150); // exceeds 100 limit

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "budget_exceeded" });
    // Should NOT have claimed the task
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
  });

  test("claim fails (task not in DB) → returns not_claimed outcome", async () => {
    mockGetTask.mockReturnValue(null);
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "not_claimed" });
  });

  test("claim fails (task not in dispatchable state) → returns not_claimed", async () => {
    mockGetTask.mockReturnValue(makeTask({ orcaStatus: "done" }));
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "not_claimed" });
  });

  test("implement session times out → task marked failed, returns timed_out", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    // waitForEvent returns null → timeout
    const step = createStep(new Map([["await-implement", null]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "timed_out" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "failed");
  });

  test("implement succeeds, PR found → transitions to in_review", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockGetInvocation.mockReturnValue({ outputSummary: "" });
    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // After Gate 2 passes with PR found, the workflow continues to review loop.
    // With no review event it returns timed_out or awaiting_ci based on flow.
    // The in_review transition happens inside the step.run, then it continues to review.
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "in_review");
  });

  test("implement succeeds, no PR found, no changes → transitions to done", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockGetInvocation.mockReturnValue({
      outputSummary: "Already implemented",
    });
    mockFindPrForBranch.mockReturnValue({ exists: false });
    // existsSync returns false (worktree gone), worktreeHasNoChanges returns false
    // but "already implemented" matches the already-done patterns
    mockExistsSync.mockReturnValue(true); // worktree path exists for the check

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "done");
  });

  test("implement succeeds, no PR found, retries remain → returns retry", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockGetInvocation.mockReturnValue({ outputSummary: "" });
    mockFindPrForBranch.mockReturnValue({ exists: false });
    mockExistsSync.mockReturnValue(false); // no changes

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockIncrementRetryCount).toHaveBeenCalledWith(mockDb, "TEST-1");
  });

  test("implement succeeds, no PR, max retries exhausted → permanent_fail", async () => {
    const task = makeTask({ retryCount: 3 }); // at maxRetries
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockGetInvocation.mockReturnValue({ outputSummary: "" });
    mockFindPrForBranch.mockReturnValue({ exists: false });
    mockExistsSync.mockReturnValue(false);

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "permanent_fail" });
    expect(mockIncrementRetryCount).not.toHaveBeenCalled();
  });

  test("review returns APPROVED → transitions to awaiting_ci", async () => {
    const task = makeTask({ prNumber: 42, prBranchName: "orca/TEST-1-inv-1" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // implement invocation
    mockInsertInvocation.mockReturnValueOnce(1).mockReturnValueOnce(2);
    mockGetInvocation
      .mockReturnValueOnce({ outputSummary: "" }) // for Gate 2
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:APPROVED" }); // for review

    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const reviewEvent = makeSessionCompletedEvent({
      invocationId: 2,
      phase: "review",
    });

    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", reviewEvent],
      ]),
    );

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "awaiting_ci" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "awaiting_ci",
    );
  });

  test("review returns CHANGES_REQUESTED → spawns fix session, next review cycle returns awaiting_ci", async () => {
    const task = makeTask({ prNumber: 42, prBranchName: "orca/TEST-1-inv-1" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // invocation IDs: implement=1, review=2, fix=3, review2=4
    mockInsertInvocation
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(4);

    mockGetInvocation
      .mockReturnValueOnce({ outputSummary: "" }) // Gate 2
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:CHANGES_REQUESTED" }) // review cycle 0
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:APPROVED" }); // review cycle 1

    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const reviewEvent0 = makeSessionCompletedEvent({
      invocationId: 2,
      phase: "review",
    });
    const fixEvent0 = makeSessionCompletedEvent({ invocationId: 3 });
    const reviewEvent1 = makeSessionCompletedEvent({
      invocationId: 4,
      phase: "review",
    });

    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", reviewEvent0],
        ["await-fix-0", fixEvent0],
        ["await-review-1", reviewEvent1],
      ]),
    );

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "awaiting_ci" });
    // changes_requested transition should have been called (in fix spawn step)
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
    );
  });

  test("review times out → returns timed_out", async () => {
    const task = makeTask({ prNumber: 42, prBranchName: "orca/TEST-1-inv-1" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValueOnce(1).mockReturnValueOnce(2);
    mockGetInvocation.mockReturnValueOnce({ outputSummary: "" });

    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });

    // review times out → null
    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", null],
      ]),
    );

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "timed_out" });
  });

  test("review exhausts all cycles → in_review_needs_human", async () => {
    const task = makeTask({ prNumber: 42, prBranchName: "orca/TEST-1-inv-1" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // 1 implement + 3 reviews + 2 fix sessions (cycles 0,1) + cycle 2 returns no_marker → needs_human
    // invocations: implement=1, review0=2, fix0=3, review1=4, fix1=5, review2=6
    mockInsertInvocation
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3)
      .mockReturnValueOnce(4)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(6);

    mockGetInvocation
      .mockReturnValueOnce({ outputSummary: "" }) // Gate 2
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:CHANGES_REQUESTED" }) // review 0
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:CHANGES_REQUESTED" }) // review 1
      .mockReturnValueOnce({ outputSummary: "" }); // review 2 - no marker

    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const reviewEvent0 = makeSessionCompletedEvent({ invocationId: 2, phase: "review" });
    const fixEvent0 = makeSessionCompletedEvent({ invocationId: 3 });
    const reviewEvent1 = makeSessionCompletedEvent({ invocationId: 4, phase: "review" });
    const fixEvent1 = makeSessionCompletedEvent({ invocationId: 5 });
    const reviewEvent2 = makeSessionCompletedEvent({ invocationId: 6, phase: "review" });

    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", reviewEvent0],
        ["await-fix-0", fixEvent0],
        ["await-review-1", reviewEvent1],
        ["await-fix-1", fixEvent1],
        ["await-review-2", reviewEvent2],
      ]),
    );

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "in_review_needs_human" });
  });

  test("workflow is configured to cancel on task/cancelled event", () => {
    // capturedFunctionConfig was saved when the module was loaded and
    // createFunction was called — before vi.resetAllMocks() could clear it.
    expect(capturedFunctionConfig?.cancelOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "task/cancelled" }),
      ]),
    );
  });

  test("implement session fails (non-max-turns) → retry incremented", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    const implementEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
    });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "TEST-1", "failed");
    expect(mockIncrementRetryCount).toHaveBeenCalledWith(mockDb, "TEST-1");
  });
});
