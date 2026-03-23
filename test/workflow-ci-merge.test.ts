// ---------------------------------------------------------------------------
// Integration tests for ci-merge Inngest workflow
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
var capturedCiMergeHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;
// eslint-disable-next-line no-var
var capturedCiMergeConfig: { cancelOn?: unknown[]; id?: string };

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        config: { cancelOn?: unknown[]; id?: string },
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        capturedCiMergeHandler = handler;
        capturedCiMergeConfig = config;
        return { id: config.id ?? "ci-gate-merge" };
      },
    ),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockDb = {} as never;

const mockConfig = {
  maxReviewCycles: 3,
  maxCiPollAttempts: 240,
  deployStrategy: "none" as const,
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
  // include all others from task-lifecycle to avoid import errors
  claimTaskForDispatch: vi.fn(),
  insertInvocation: vi.fn(),
  updateInvocation: vi.fn(),
  budgetWindowStart: vi.fn().mockReturnValue(new Date().toISOString()),
  incrementRetryCount: vi.fn(),
  updateTaskPrBranch: vi.fn(),
  updateTaskCiInfo: vi.fn(),
  updateTaskPrState: vi.fn(),
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
  getPrCheckStatus: vi.fn(),
  getPrMergeState: vi.fn(),
  mergePr: vi.fn(),
  updatePrBranch: vi.fn(),
  rebasePrBranch: vi.fn(),
  findPrForBranch: vi.fn(),
  getMergeCommitSha: vi.fn(),
  closeSupersededPrs: vi.fn(),
  getFailingCheckNames: vi.fn(),
  isCiFlakeOnMain: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  getTask,
  updateTaskStatus,
  incrementReviewCycleCount,
} from "../src/db/queries.js";
import { writeBackStatus } from "../src/linear/sync.js";
import {
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  getMergeCommitSha,
  updatePrBranch,
  getFailingCheckNames,
  isCiFlakeOnMain,
} from "../src/github/index.js";
import { sendPermanentFailureAlert } from "../src/scheduler/alerts.js";

// Import the workflow module to trigger createFunction capture
import "../src/inngest/workflows/ci-merge.js";

const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockIncrementReviewCycleCount = vi.mocked(incrementReviewCycleCount);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockGetPrCheckStatus = vi.mocked(getPrCheckStatus);
const mockGetPrMergeState = vi.mocked(getPrMergeState);
const mockMergePr = vi.mocked(mergePr);
const mockGetMergeCommitSha = vi.mocked(getMergeCommitSha);
const mockUpdatePrBranch = vi.mocked(updatePrBranch);
const mockGetFailingCheckNames = vi.mocked(getFailingCheckNames);
const mockIsCiFlakeOnMain = vi.mocked(isCiFlakeOnMain);
const mockSendPermanentFailureAlert = vi.mocked(sendPermanentFailureAlert);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAwaitingCiEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: "task/awaiting-ci" as const,
    data: {
      linearIssueId: "TEST-1",
      prNumber: 42,
      prBranchName: "orca/TEST-1-inv-1",
      repoPath: "/repo",
      ciStartedAt: new Date().toISOString(),
      ...overrides,
    },
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "TEST-1",
    orcaStatus: "awaiting_ci",
    repoPath: "/repo",
    prNumber: 42,
    prBranchName: "orca/TEST-1-inv-1",
    reviewCycleCount: 0,
    mergeAttemptCount: 0,
    ...overrides,
  };
}

/**
 * Creates a step mock for ci-merge. The workflow calls step.run repeatedly
 * in a while loop. We support controlling each call via an ordered queue.
 *
 * step.run always executes the provided fn directly (like the real Inngest).
 */
function createCiMergeStep() {
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
  // Restore mutated mockSchedulerDeps.config to default
  (mockSchedulerDeps as Record<string, unknown>).config = mockConfig;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ci-merge workflow", () => {
  test("task not found → returns aborted", async () => {
    mockGetTask.mockReturnValue(null);

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({
      status: "aborted",
      reason: "task_not_found",
    });
  });

  test("task status changed from awaiting_ci → returns aborted", async () => {
    mockGetTask.mockReturnValue(makeTask({ orcaStatus: "done" }));

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({
      status: "aborted",
      reason: "status_changed",
    });
  });

  test("CI pending → polls again (sleeps between polls)", async () => {
    // First call: CI pending; second call: task not found (to exit loop cleanly)
    mockGetTask
      .mockReturnValueOnce(makeTask()) // loop iteration 1
      .mockReturnValueOnce(makeTask()) // inside check-ci step
      .mockReturnValueOnce(null); // loop iteration 2 → abort

    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    // Sleep should have been called once (after pending)
    expect(step.sleep).toHaveBeenCalledWith("ci-poll-wait-1", "30s");
  });

  test("CI success → merges → done (deploy strategy: none)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // mergeAndFinalizeStep - task lookup
      .mockReturnValue(makeTask()); // subsequent calls (emitTaskUpdated etc)

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc123");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "merged", nextStatus: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "done",
      { reason: "pr_merged" },
    );
  });

  test("CI success → merges → deploying (deploy strategy: github_actions)", async () => {
    // Override config to use github_actions deploy strategy
    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      deployStrategy: "github_actions",
    };

    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // mergeAndFinalizeStep - task lookup
      .mockReturnValue(makeTask()); // subsequent calls (emitTaskUpdated etc)

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("sha-deploy");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "merged", nextStatus: "deploying" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "deploying",
      { reason: "pr_merged" },
    );

    // Restore config
    (mockSchedulerDeps as Record<string, unknown>).config = mockConfig;
  });

  test("CI no_checks (no checks configured) → treats as success → merges", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // mergeAndFinalize task lookup
      .mockReturnValue(makeTask()); // subsequent calls

    mockGetPrCheckStatus.mockResolvedValue("no_checks");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc456");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "merged" });
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
  });

  test("CI failure → changes_requested (if cycles remain)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // inside check-ci step
      .mockReturnValueOnce(makeTask()) // inside ci-flake-check step
      .mockReturnValueOnce(makeTask({ reviewCycleCount: 0 })); // inside ci-failure step

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
      { reason: "ci_failed_changes_requested" },
    );
    expect(mockIncrementReviewCycleCount).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
    );
  });

  test("CI failure → failed permanently (if cycles exhausted)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check (outside step)
      .mockReturnValueOnce(makeTask()) // inside ci-flake-check step
      .mockReturnValueOnce(makeTask({ reviewCycleCount: 3 })); // inside ci-failure step

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      { reason: "ci_failed_cycles_exhausted" },
    );
    expect(mockIncrementReviewCycleCount).not.toHaveBeenCalled();
  });

  test("merge attempt behind → updates PR branch then merges successfully", async () => {
    // BEHIND → updatePrBranch → falls through to merge attempt → succeeds
    mockGetTask
      .mockReturnValueOnce(makeTask()) // loop 1 - outer check (outside step)
      .mockReturnValueOnce(makeTask()) // mergeAndFinalize - task lookup
      .mockReturnValue(makeTask()); // any subsequent calls (for emitTaskUpdated etc)

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    mockUpdatePrBranch.mockResolvedValue(true);
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc789");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    // The branch update should have been attempted before the merge
    expect(mockUpdatePrBranch).toHaveBeenCalledWith(42, "/repo");
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
    expect(result).toMatchObject({ status: "merged" });
  });

  test("merge attempt conflicting → changes_requested when cycles remain", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask({ reviewCycleCount: 0 })) // mergeAndFinalize outer getTask
      .mockReturnValue(makeTask()); // subsequent calls (emitTaskUpdated etc)

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "CONFLICTING",
      mergeStateStatus: "CONFLICTING",
    });

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "changes_requested" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
      { reason: "merge_conflict" },
    );
  });

  test("CI failure → flake detected (failure exists on main) → re-polls without burning retry", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop iteration 1 check
      .mockReturnValueOnce(makeTask()) // inside ci-flake-check step (iteration 1)
      .mockReturnValueOnce(makeTask()) // outer loop iteration 2 check
      .mockReturnValueOnce(makeTask()) // inside check-ci step (iteration 2)
      .mockReturnValueOnce(makeTask()) // inside merge-and-finalize step (iteration 2)
      .mockReturnValue(makeTask()); // subsequent calls

    mockGetPrCheckStatus
      .mockResolvedValueOnce("failure") // iteration 1: failure
      .mockResolvedValueOnce("success"); // iteration 2: success after flake wait

    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(true);

    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc123");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    // Flake: review cycle count should NOT have been incremented
    expect(mockIncrementReviewCycleCount).not.toHaveBeenCalled();
    // Flake sleep should have been called
    expect(step.sleep).toHaveBeenCalledWith("ci-flake-wait-1", "30s");
    // Eventually merges successfully
    expect(result).toMatchObject({ status: "merged" });
  });

  test("CI failure → not a flake (failure unique to PR) → burns retry normally", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // inside ci-flake-check step
      .mockReturnValueOnce(makeTask({ reviewCycleCount: 0 })); // inside ci-failure step

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockIncrementReviewCycleCount).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
    );
    // Flake sleep should NOT have been called
    expect(step.sleep).not.toHaveBeenCalledWith(
      expect.stringContaining("ci-flake-wait"),
      expect.anything(),
    );
  });

  test("CI failure → getFailingCheckNames returns empty → treated as real failure", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop check
      .mockReturnValueOnce(makeTask()) // inside ci-flake-check step
      .mockReturnValueOnce(makeTask({ reviewCycleCount: 0 })); // inside ci-failure step

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue([]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockIncrementReviewCycleCount).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
    );
  });

  test("CI poll exhausted → updates task to failed, writes back to Linear, fires alert", async () => {
    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      maxCiPollAttempts: 1,
    };

    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop iteration 1 check
      .mockReturnValueOnce(makeTask()) // inside check-ci step (iteration 1)
      .mockReturnValue(makeTask()); // poll-exhausted step calls

    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      { reason: "ci_poll_exhausted" },
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

  test("ci-merge workflow is configured to cancel on task/cancelled event", () => {
    // capturedCiMergeConfig was saved when the module was loaded
    expect(capturedCiMergeConfig?.cancelOn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "task/cancelled" }),
      ]),
    );
  });

  test("poll exhaustion (240 pending attempts) → task failed with poll_exhausted reason", async () => {
    // Always return a valid task with awaiting_ci status so the loop runs all 240 iterations.
    // step.sleep is mocked to resolve immediately so there's no real delay.
    mockGetTask.mockReturnValue(makeTask());
    // CI always pending — never resolves
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({
        // Set ciStartedAt to recent time so the timeout (deployTimeoutMin=30min) doesn't trigger
        ciStartedAt: new Date().toISOString(),
      }),
      step,
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
  });

  test("poll exhaustion → updateTaskStatus called with 'failed'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({ ciStartedAt: new Date().toISOString() }),
      step,
    });

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      { reason: "ci_poll_exhausted" },
    );
  });

  test("poll exhaustion → writeBackStatus called with 'failed_permanent'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({ ciStartedAt: new Date().toISOString() }),
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
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({ ciStartedAt: new Date().toISOString() }),
      step,
    });

    // sendPermanentFailureAlert is responsible for posting the Linear comment + webhook
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
      "TEST-1",
      expect.stringContaining("240"),
    );
  });

  test("poll exhaustion → sendPermanentFailureAlert is called inside step.run", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({ ciStartedAt: new Date().toISOString() }),
      step,
    });

    // Must be called inside a step.run (not fire-and-forget outside)
    expect(step.run).toHaveBeenCalledWith(
      "ci-poll-exhausted",
      expect.any(Function),
    );
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });

  test("CI error → treated as pending, continues polling, eventually succeeds", async () => {
    // Iteration 1: error (transient gh CLI failure) → sleep → iteration 2: success → merge
    mockGetTask
      .mockReturnValueOnce(makeTask()) // outer loop iteration 1
      .mockReturnValueOnce(makeTask()) // outer loop iteration 2
      .mockReturnValueOnce(makeTask()) // mergeAndFinalize task lookup
      .mockReturnValue(makeTask()); // subsequent calls

    mockGetPrCheckStatus
      .mockResolvedValueOnce("error") // iteration 1: transient error
      .mockResolvedValueOnce("success"); // iteration 2: success

    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc999");

    const step = createCiMergeStep();
    const result = await capturedCiMergeHandler({
      event: makeAwaitingCiEvent(),
      step,
    });

    // Should not have merged on the error iteration
    expect(step.sleep).toHaveBeenCalledWith("ci-poll-wait-1", "30s");
    // Should eventually merge
    expect(result).toMatchObject({ status: "merged" });
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
  });

  test("poll exhaustion → no duplicate explicit createComment call (alert handles it)", async () => {
    // sendPermanentFailureAlert handles the Linear comment + webhook.
    // No extra explicit createComment call should occur from the exhaustion step.
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createCiMergeStep();
    await capturedCiMergeHandler({
      event: makeAwaitingCiEvent({ ciStartedAt: new Date().toISOString() }),
      step,
    });

    // sendPermanentFailureAlert is mocked so createComment won't be called by it.
    // No explicit createComment from the exhaustion step either.
    const exhaustionComments = mockLinearClient.createComment.mock.calls.filter(
      ([_id, msg]: [string, string]) =>
        msg.includes("240") || msg.includes("poll exhausted"),
    );
    expect(exhaustionComments.length).toBe(0);
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });
});
