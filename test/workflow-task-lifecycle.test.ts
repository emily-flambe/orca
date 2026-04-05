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
var capturedHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;
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
  getInvocationsByTask: vi.fn().mockReturnValue([]),
  clearSessionIds: vi.fn(),
  countActiveSessions: vi.fn().mockReturnValue(0),
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
  getDefaultBranch: vi.fn().mockReturnValue("main"),
}));

vi.mock("../src/scheduler/alerts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/scheduler/alerts.js")>();
  return {
    ...actual,
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
  getInvocation,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  incrementRetryCount,
  insertSystemEvent,
  resetStaleSessionRetryCount,
} from "../src/db/queries.js";
import { spawnSession, killSession } from "../src/runner/index.js";
import { findPrForBranch, getPrCheckStatus } from "../src/github/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/task-lifecycle.js";
import { inngest } from "../src/inngest/client.js";
import { activeHandles } from "../src/session-handles.js";

const mockInngestSend = vi.mocked(inngest.send);

// Typed mocks
const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockIncrementRetryCount = vi.mocked(incrementRetryCount);
const mockUpdateInvocation = vi.mocked(updateInvocation);
const mockSpawnSession = vi.mocked(spawnSession);
const mockKillSession = vi.mocked(killSession);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
const mockGetPrCheckStatus = vi.mocked(getPrCheckStatus);
const mockGetInvocation = vi.mocked(getInvocation);
const mockInsertSystemEvent = vi.mocked(insertSystemEvent);
const _mockResetStaleSessionRetryCount = vi.mocked(resetStaleSessionRetryCount);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockCreateWorktree = vi.mocked(createWorktree);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockConfig = {
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

const mockStateMap = {};
// Using a minimal DB stand-in (queries are all mocked)
const mockDb = {} as never;

const STATUS_TO_LIFECYCLE: Record<
  string,
  { lifecycleStage: string; currentPhase: string | null }
> = {
  backlog: { lifecycleStage: "backlog", currentPhase: null },
  ready: { lifecycleStage: "ready", currentPhase: null },
  running: { lifecycleStage: "active", currentPhase: "implement" },
  in_review: { lifecycleStage: "active", currentPhase: "review" },
  changes_requested: { lifecycleStage: "active", currentPhase: "fix" },
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
function createStep(waitForEventResponses: Map<string, unknown> = new Map()) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async (id: string, _opts: unknown) => {
      // Simulate session completion: clear activeHandles and pending count so
      // the next spawn doesn't hit the concurrency cap.
      activeHandles.clear();

      return waitForEventResponses.get(id) ?? null;
    }),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

/**
 * Like createStep, but does NOT clear activeHandles on timeout (null response).
 * Use this when testing that timeout paths kill the active handle.
 */
function createStepPreserveHandlesOnTimeout(
  waitForEventResponses: Map<string, unknown> = new Map(),
) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(async (id: string, _opts: unknown) => {
      const response = waitForEventResponses.get(id);
      if (response !== undefined) {
        // Event received — clear handles as normal
        activeHandles.clear();

        return response;
      }
      // Timeout (null) — leave handles in place so the kill path can find them
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

  // Initialize deps so getSchedulerDeps() works in the workflow
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

describe("task-lifecycle workflow", () => {
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
    mockGetTask.mockReturnValue(makeTask({ lifecycleStage: "done" }));
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
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "session_timed_out" }),
    );
  });

  test("implement succeeds, PR found → transitions to awaiting_ci", async () => {
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

    const _result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // After Gate 2 passes with PR found, transitions directly to awaiting_ci (review removed)
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "awaiting_ci",
      { reason: "pr_found" },
    );
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
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "done",
      { reason: "already_done" },
    );
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

  // Review tests (APPROVED, CHANGES_REQUESTED, timeout, exhausts all cycles)
  // removed in EMI-504 — review phase no longer exists.

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
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "implement_failed" }),
    );
    expect(mockIncrementRetryCount).toHaveBeenCalledWith(mockDb, "TEST-1");
  });

  test("implement success → invocation finalized with completed status and cost data", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);
    mockGetInvocation.mockReturnValue({ outputSummary: "" });
    mockFindPrForBranch.mockReturnValue({ exists: false });
    mockExistsSync.mockReturnValue(false);

    const implementEvent = makeSessionCompletedEvent({
      invocationId: 1,
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 300,
    });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.objectContaining({
        status: "completed",
        costUsd: 0.05,
        inputTokens: 500,
        outputTokens: 300,
        endedAt: expect.any(String),
      }),
    );
  });

  test("implement failure → invocation finalized with failed status", async () => {
    const task = makeTask({ retryCount: 0 });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    const implementEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
    });
    const step = createStep(new Map([["await-implement", implementEvent]]));

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.objectContaining({
        status: "failed",
        costUsd: 0.02,
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
  });

  // review/fix invocation finalization tests removed in EMI-504

  test("implement timeout → killSession called on the active handle", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    const fakeHandle = {
      done: new Promise(() => {}),
      sessionId: "sess-timeout",
      process: { exitCode: null, killed: false, pid: 1234 } as never,
      kill: vi.fn(),
    };
    mockSpawnSession.mockReturnValue(fakeHandle);
    mockKillSession.mockResolvedValue(undefined as never);

    // Use step that preserves handles on timeout so the kill path can find them
    const step = createStepPreserveHandlesOnTimeout();

    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockKillSession).toHaveBeenCalledWith(fakeHandle);
    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      1,
      expect.objectContaining({ status: "timed_out" }),
    );
  });

  // review timeout killSession test removed in EMI-504
});

// ---------------------------------------------------------------------------
// Guard A — stale workflow abort
// ---------------------------------------------------------------------------

describe("Guard A — stale workflow abort", () => {
  test("canceled task → workflow aborts with aborted_stale", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: getTask after claim (emitTaskUpdated)
      .mockReturnValueOnce(makeTask({ lifecycleStage: "canceled" })); // guard-a-implement
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toEqual({ outcome: "aborted_stale" });
    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "self_heal" }),
    );
  });

  test("done task → workflow aborts", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: getTask after claim
      .mockReturnValueOnce(makeTask({ lifecycleStage: "done" })); // guard-a-implement
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toEqual({ outcome: "aborted_stale" });
    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "self_heal" }),
    );
  });

  test("deleted task (null) → workflow aborts", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: getTask after claim
      .mockReturnValueOnce(null); // guard-a-implement: task deleted
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toEqual({ outcome: "aborted_stale" });
    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "self_heal" }),
    );
  });

  test("active task → workflow proceeds normally (spawnSession called)", async () => {
    // Guard A returns non-terminal status, so workflow continues to start-implement
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: getTask after claim
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // guard-a-implement
      .mockReturnValue(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ); // all subsequent calls
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    // Implement times out so we get a clean exit
    const step = createStep(new Map([["await-implement", null]]));
    await capturedHandler({ event: makeTaskReadyEvent(), step });

    expect(mockSpawnSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guard B — orphaned green PR recovery
// ---------------------------------------------------------------------------

describe("Guard B — orphaned green PR recovery", () => {
  test("failed implement with green PR → rescued to awaiting_ci", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: after claim
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // guard-a-implement
      .mockReturnValue(
        makeTask({
          lifecycleStage: "active",
          currentPhase: "implement",
          prBranchName: "orca/TEST-1-inv-1",
          retryCount: 0,
        }),
      ); // all subsequent (start-implement, process-implement-and-gate2)
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    mockFindPrForBranch.mockResolvedValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });
    mockGetPrCheckStatus.mockResolvedValue("success");
    mockInngestSend.mockResolvedValue(undefined as never);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "rescued_pr" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "awaiting_ci",
      { reason: "rescued_green_pr" },
    );
    expect(mockInsertSystemEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "self_heal" }),
    );
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/awaiting-ci" }),
    );
  });

  test("failed implement with failing PR → falls through to normal failure", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: after claim
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // guard-a-implement
      .mockReturnValue(
        makeTask({
          lifecycleStage: "active",
          currentPhase: "implement",
          prBranchName: "orca/TEST-1-inv-1",
          retryCount: 0,
        }),
      );
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    mockFindPrForBranch.mockResolvedValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });
    mockGetPrCheckStatus.mockResolvedValue("failure");

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "implement_failed" }),
    );
  });

  test("failed implement with no PR → falls through to normal failure", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: after claim
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // guard-a-implement
      .mockReturnValue(
        makeTask({
          lifecycleStage: "active",
          currentPhase: "implement",
          prBranchName: "orca/TEST-1-inv-1",
          retryCount: 0,
        }),
      );
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    mockFindPrForBranch.mockResolvedValue({ exists: false } as never);

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "implement_failed" }),
    );
  });

  test("gh CLI error → try/catch catches, falls through to normal failure", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask({ lifecycleStage: "ready" })) // claim-task: first getTask
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // claim-task: after claim
      .mockReturnValueOnce(
        makeTask({ lifecycleStage: "active", currentPhase: "implement" }),
      ) // guard-a-implement
      .mockReturnValue(
        makeTask({
          lifecycleStage: "active",
          currentPhase: "implement",
          prBranchName: "orca/TEST-1-inv-1",
          retryCount: 0,
        }),
      );
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    mockFindPrForBranch.mockRejectedValue(new Error("gh CLI not found"));

    const failedEvent = makeSessionCompletedEvent({
      invocationId: 1,
      exitCode: 1,
      isMaxTurns: false,
    });
    const step = createStep(new Map([["await-implement", failedEvent]]));

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "retry" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "implement_failed" }),
    );
  });
});
