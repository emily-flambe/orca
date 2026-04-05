// ---------------------------------------------------------------------------
// Integration tests for shared ci-merge logic (runCiGateAndMerge)
//
// Strategy: mock getSchedulerDeps and GitHub calls, then call runCiGateAndMerge
// directly with a mock step object.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(() => ({ id: "unused" })),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockDb = {} as never;

const mockConfig = {
  maxCiPollAttempts: 240,
  deployStrategy: "none" as const,
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
  getDefaultBranch: vi.fn().mockReturnValue("main"),
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
  incrementRetryCount,
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
import { runCiGateAndMerge } from "../src/inngest/shared/ci-merge.js";

const mockGetTask = vi.mocked(getTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockIncrementRetryCount = vi.mocked(incrementRetryCount);
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

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "TEST-1",
    lifecycleStage: "active",
    currentPhase: "ci",
    repoPath: "/repo",
    prNumber: 42,
    prBranchName: "orca/TEST-1-inv-1",
    mergeAttemptCount: 0,
    retryCount: 0,
    ...overrides,
  };
}

/**
 * Creates a step mock. step.run always executes the provided fn directly.
 */
function createStep() {
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

describe("runCiGateAndMerge (shared CI gate logic)", () => {
  test("task not found → returns aborted", async () => {
    mockGetTask.mockReturnValue(null);

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "aborted",
      reason: "task_not_found",
    });
  });

  test("task status changed from awaiting_ci → returns aborted", async () => {
    mockGetTask.mockReturnValue(
      makeTask({
        lifecycleStage: "done",
        currentPhase: null,
      }),
    );

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "aborted",
      reason: "status_changed",
    });
  });

  test("CI pending → polls again (sleeps between polls)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(null);

    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(step.sleep).toHaveBeenCalledWith("ci-poll-wait-1", "30s");
  });

  test("CI success → merges → done (deploy strategy: none)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc123");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "merged", nextStatus: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "done",
      { reason: "pr_merged" },
    );
  });

  test("CI success → merges → deploying (deploy strategy: github_actions)", async () => {
    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      deployStrategy: "github_actions",
    };

    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("sha-deploy");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "merged", nextStatus: "deploying" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "deploying",
      { reason: "pr_merged" },
    );
  });

  test("CI no_checks (no checks configured) → treats as success → merges", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("no_checks");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc456");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "merged" });
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
  });

  test("CI failure → changes_requested (if cycles remain)", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
      { reason: "ci_failed_fix_needed" },
    );
  });

  test("CI failure → failed permanently (if retries exhausted)", async () => {
    const exhaustedTask = makeTask({ retryCount: 3 });
    mockGetTask
      .mockReturnValueOnce(exhaustedTask)
      .mockReturnValueOnce(exhaustedTask)
      .mockReturnValueOnce(exhaustedTask);

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "ci_failed_retries_exhausted" }),
    );
  });

  test("merge attempt behind → updates PR branch then merges successfully", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    mockUpdatePrBranch.mockResolvedValue(true);
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc789");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(mockUpdatePrBranch).toHaveBeenCalledWith(42, "/repo");
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
    expect(result).toMatchObject({ status: "merged" });
  });

  test("merge attempt conflicting → changes_requested when cycles remain", async () => {
    mockGetTask.mockReturnValueOnce(makeTask()).mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("success");
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "CONFLICTING",
      mergeStateStatus: "CONFLICTING",
    });

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

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
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus
      .mockResolvedValueOnce("failure")
      .mockResolvedValueOnce("success");

    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(true);

    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc123");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(mockIncrementRetryCount).not.toHaveBeenCalled();
    expect(step.sleep).toHaveBeenCalledWith("ci-flake-wait-1", "30s");
    expect(result).toMatchObject({ status: "merged" });
  });

  test("CI failure → not a flake (failure unique to PR) → burns retry normally", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue(["CI / test"]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
      { reason: "ci_failed_fix_needed" },
    );
    expect(step.sleep).not.toHaveBeenCalledWith(
      expect.stringContaining("ci-flake-wait"),
      expect.anything(),
    );
  });

  test("CI failure → getFailingCheckNames returns empty → treated as real failure", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("failure");
    mockGetFailingCheckNames.mockResolvedValue([]);
    mockIsCiFlakeOnMain.mockResolvedValue(false);

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({ status: "ci_failure" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "changes_requested",
      { reason: "ci_failed_fix_needed" },
    );
  });

  test("CI poll exhausted → updates task to failed, writes back to Linear, fires alert", async () => {
    (mockSchedulerDeps as Record<string, unknown>).config = {
      ...mockConfig,
      maxCiPollAttempts: 1,
    };

    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "ci_poll_exhausted" }),
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

  test("poll exhaustion (240 pending attempts) → task failed with poll_exhausted reason", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "poll_exhausted",
    });
  });

  test("poll exhaustion → updateTaskStatus called with 'failed'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TEST-1",
      "failed",
      expect.objectContaining({ reason: "ci_poll_exhausted" }),
    );
  });

  test("poll exhaustion → writeBackStatus called with 'failed_permanent'", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

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

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(mockSendPermanentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
      "TEST-1",
      expect.stringContaining("240"),
    );
  });

  test("poll exhaustion → sendPermanentFailureAlert is called inside step.run", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(step.run).toHaveBeenCalledWith(
      "ci-poll-exhausted",
      expect.any(Function),
    );
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });

  test("CI error → treated as pending, continues polling, eventually succeeds", async () => {
    mockGetTask
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValueOnce(makeTask())
      .mockReturnValue(makeTask());

    mockGetPrCheckStatus
      .mockResolvedValueOnce("error")
      .mockResolvedValueOnce("success");

    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc999");

    const step = createStep();
    const result = await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    expect(step.sleep).toHaveBeenCalledWith("ci-poll-wait-1", "30s");
    expect(result).toMatchObject({ status: "merged" });
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
  });

  test("poll exhaustion → no duplicate explicit createComment call (alert handles it)", async () => {
    mockGetTask.mockReturnValue(makeTask());
    mockGetPrCheckStatus.mockResolvedValue("pending");

    const step = createStep();
    await runCiGateAndMerge(
      step as never,
      "TEST-1",
      42,
      "orca/TEST-1-inv-1",
      new Date().toISOString(),
    );

    const exhaustionComments = mockLinearClient.createComment.mock.calls.filter(
      ([_id, msg]: [string, string]) =>
        msg.includes("240") || msg.includes("poll exhausted"),
    );
    expect(exhaustionComments.length).toBe(0);
    expect(mockSendPermanentFailureAlert).toHaveBeenCalledTimes(1);
  });
});
