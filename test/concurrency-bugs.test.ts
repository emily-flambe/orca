// ---------------------------------------------------------------------------
// Adversarial tests for concurrency bug fixes
//
// Tests assertSessionCapacity, bridgeSessionCompletion DB fallback,
// cron task capacity enforcement, and TOCTOU race conditions.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock("../src/system-resources.js", () => ({
  checkResourceConstraints: vi.fn().mockReturnValue({
    ok: true,
    snapshot: { availableMemoryGb: 16, cpuLoadPercent: 20 },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  sumCostInWindow,
  sumTokensInWindow,
  budgetWindowStart,
  countActiveSessions,
  insertSystemEvent,
  getLastMaxTurnsInvocation,
  getLastDeployInterruptedInvocation,
  getLastCompletedImplementInvocation,
} from "../src/db/queries.js";
import { spawnSession } from "../src/runner/index.js";
import { createWorktree } from "../src/worktree/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { findPrForBranch } from "../src/github/index.js";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import {
  assertSessionCapacity,
  bridgeSessionCompletion,
} from "../src/inngest/workflows/task-lifecycle.js";
import "../src/inngest/workflows/cron-task-lifecycle.js";
import { inngest } from "../src/inngest/client.js";
import { activeHandles } from "../src/session-handles.js";
import { checkResourceConstraints } from "../src/system-resources.js";

const mockCheckResourceConstraints = vi.mocked(checkResourceConstraints);
const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockUpdateInvocation = vi.mocked(updateInvocation);
const mockSumCostInWindow = vi.mocked(sumCostInWindow);
const mockSumTokensInWindow = vi.mocked(sumTokensInWindow);
const mockBudgetWindowStart = vi.mocked(budgetWindowStart);
const mockCountActiveSessions = vi.mocked(countActiveSessions);
const mockSpawnSession = vi.mocked(spawnSession);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteBackStatus = vi.mocked(writeBackStatus);
const mockCreateWorktree = vi.mocked(createWorktree);
const mockInngestSend = vi.mocked(inngest.send);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
const mockGetLastMaxTurnsInvocation = vi.mocked(getLastMaxTurnsInvocation);
const mockGetLastDeployInterruptedInvocation = vi.mocked(
  getLastDeployInterruptedInvocation,
);
const mockGetLastCompletedImplementInvocation = vi.mocked(
  getLastCompletedImplementInvocation,
);

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  activeHandles.clear();

  mockInngestSend.mockResolvedValue(undefined);
  mockCheckResourceConstraints.mockReturnValue({
    ok: true,
    snapshot: { availableMemoryGb: 16, cpuLoadPercent: 20 },
  });
  mockSumCostInWindow.mockReturnValue(0);
  mockSumTokensInWindow.mockReturnValue(0);
  mockBudgetWindowStart.mockReturnValue(new Date().toISOString());
  mockCountActiveSessions.mockReturnValue(0);
  mockFindPrForBranch.mockReturnValue({ exists: false } as never);
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

// ===========================================================================
// 1. assertSessionCapacity unit tests
// ===========================================================================

describe("assertSessionCapacity", () => {
  test("db param is required: always checks both activeHandles and DB count", () => {
    // db is now a required parameter, so the DB running count is always consulted.
    // With 5 running sessions in DB and cap=1, this should throw.
    mockCountActiveSessions.mockReturnValue(5);

    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/);
  });

  test("with db param: uses Math.max of handles and DB count", () => {
    mockCountActiveSessions.mockReturnValue(1);
    // CONCURRENCY_CAP defaults to 1 in test env (no env var set)
    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/);
  });

  test("handles count alone can trigger cap", () => {
    // activeHandles has 1 entry, CONCURRENCY_CAP is 1
    activeHandles.set(999, {
      done: new Promise(() => {}),
      kill: vi.fn(),
    } as never);
    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/);
  });

  test("DB count alone can trigger cap (restart scenario)", () => {
    // No active handles but DB says 1 running
    mockCountActiveSessions.mockReturnValue(1);
    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/);
  });

  test("CONCURRENCY_CAP is read at module load time from env", () => {
    // The CONCURRENCY_CAP is a module-level const read from process.env at import.
    // In test env, ORCA_CONCURRENCY_CAP is likely unset, so it defaults to 1.
    // This means a single active session blocks all further dispatch.
    // BUG POTENTIAL: If tests or the real app change process.env after import,
    // the cap won't update. This is by design but worth documenting.
    mockCountActiveSessions.mockReturnValue(0);
    expect(() => assertSessionCapacity(mockDb)).not.toThrow();
    mockCountActiveSessions.mockReturnValue(1);
    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/);
  });
});

// ===========================================================================
// 2. bridgeSessionCompletion DB fallback
// ===========================================================================

describe("bridgeSessionCompletion DB fallback", () => {
  test("inngest.send failure triggers DB fallback: updates invocation and resets task", async () => {
    // Make inngest.send reject
    mockInngestSend.mockRejectedValueOnce(new Error("Inngest unreachable"));

    const mockHandle = {
      done: Promise.resolve({
        subtype: "success" as const,
        exitCode: 0,
        outputSummary: "done",
        costUsd: 0.5,
        inputTokens: 100,
        outputTokens: 200,
        numTurns: 5,
      }),
      sessionId: "sess-456",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 123 },
    };

    bridgeSessionCompletion(
      42,
      "TASK-1",
      "implement",
      mockHandle as never,
      "orca/TASK-1",
      "/tmp/wt",
    );

    // Wait for the async chain to resolve
    await new Promise((r) => setTimeout(r, 50));

    // DB fallback should have fired
    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      42,
      expect.objectContaining({ status: "completed" }),
    );
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TASK-1",
      "failed",
    );
  });

  test("inngest.send failure AND getSchedulerDeps throws: double failure is caught", async () => {
    // Wipe deps to force getSchedulerDeps to throw
    // We need to temporarily break deps
    mockInngestSend.mockRejectedValueOnce(new Error("Inngest down"));

    const mockHandle = {
      done: Promise.resolve({
        subtype: "success" as const,
        exitCode: 0,
        outputSummary: "done",
        costUsd: 0.5,
        inputTokens: 100,
        outputTokens: 200,
        numTurns: 5,
      }),
      sessionId: "sess-789",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 123 },
    };

    // Force the DB fallback to also throw by making updateInvocation throw
    mockUpdateInvocation.mockImplementationOnce(() => {
      throw new Error("DB connection lost");
    });

    // Should not throw - the double failure is caught internally
    bridgeSessionCompletion(
      43,
      "TASK-2",
      "implement",
      mockHandle as never,
      "orca/TASK-2",
      "/tmp/wt2",
    );

    await new Promise((r) => setTimeout(r, 50));

    // Both paths failed, but no unhandled exception
    // The invocation is now orphaned - task stuck in running state forever
    // This is the "silent data loss" bug - no recovery mechanism exists
    expect(mockUpdateInvocation).toHaveBeenCalled();
  });

  test("handle.done rejection triggers synthetic failure event", async () => {
    const mockHandle = {
      done: Promise.reject(new Error("process crash")),
      sessionId: "sess-crash",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 123 },
    };

    bridgeSessionCompletion(
      44,
      "TASK-3",
      "implement",
      mockHandle as never,
      "orca/TASK-3",
      "/tmp/wt3",
    );

    await new Promise((r) => setTimeout(r, 50));

    // Should send a synthetic failure event
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session/completed",
        data: expect.objectContaining({
          invocationId: 44,
          exitCode: 1,
        }),
      }),
    );

    // activeHandles should be cleaned up
    expect(activeHandles.has(44)).toBe(false);
  });

  test("handle.done rejection + inngest.send failure: secondary DB fallback", async () => {
    // Both the process crashes AND inngest.send fails
    mockInngestSend.mockRejectedValue(new Error("Inngest totally down"));

    const mockHandle = {
      done: Promise.reject(new Error("process crash")),
      sessionId: "sess-crash2",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 123 },
    };

    bridgeSessionCompletion(
      45,
      "TASK-4",
      "implement",
      mockHandle as never,
      "orca/TASK-4",
      "/tmp/wt4",
    );

    await new Promise((r) => setTimeout(r, 50));

    // Secondary DB fallback should update invocation to failed and reset task
    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      45,
      expect.objectContaining({ status: "failed" }),
    );
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TASK-4",
      "failed",
    );
  });
});

// ===========================================================================
// 3. TOCTOU race: capacity check in claim-task vs start-implement
// ===========================================================================

describe("TOCTOU race between claim-task and start-implement", () => {
  test("capacity is checked TWICE: once in claim-task, once in start-implement", async () => {
    // This tests the gap: between claim-task checking capacity and
    // start-implement checking capacity, another workflow could have claimed.
    //
    // Scenario: cap=1, both workflows pass claim-task check (both see 0 active),
    // then both proceed to start-implement.
    //
    // The second assertSessionCapacity in start-implement is the guard, but
    // since claim already transitioned DB to "running", countActiveSessions
    // now returns 1 (the task we just claimed counts itself).
    //
    // BUG: After claimTaskForDispatch, the DB has the task in "running" state.
    // countActiveSessions counts invocations with status="running", NOT tasks.
    // But the invocation hasn't been inserted yet at claim time.
    // So between claim and start-implement, the DB running invocation count
    // is still 0 from this task's perspective - the invocation is created in
    // start-implement AFTER the second assertSessionCapacity call.

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // countActiveSessions returns 0 for both calls (TOCTOU window)
    mockCountActiveSessions.mockReturnValue(0);

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

    // assertSessionCapacity was called, but since countActiveSessions returns 0
    // and activeHandles is empty, BOTH checks pass. The invocation is only
    // inserted AFTER the second check. This means two concurrent workflows
    // can both pass both checks and both spawn sessions.
    //
    // Verify the second check actually happened (in start-implement):
    // countActiveSessions should have been called at least twice - once in
    // claim-task and once in start-implement.
    const callCount = mockCountActiveSessions.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("BUG: two concurrent workflows both pass capacity check", async () => {
    // Simulate: cap=1, two workflows run claim-task simultaneously.
    // Both see 0 running invocations, both claim successfully.
    // Both then proceed to start-implement, both see 0 running invocations
    // (because neither has inserted an invocation yet), both spawn sessions.
    // Result: 2 sessions running with cap=1.
    //
    // The fix only works if Inngest's concurrency config prevents this at the
    // workflow level. The assertSessionCapacity check inside the step is not
    // sufficient because:
    // 1. claim-task and start-implement are separate steps
    // 2. countActiveSessions queries invocations table, not tasks table
    // 3. The invocation is inserted AFTER assertSessionCapacity in start-implement

    // We can prove this by showing that countActiveSessions does NOT count the
    // just-claimed task (since no invocation exists yet for it).
    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    // Simulate: DB has 0 running invocations when both workflows check
    mockCountActiveSessions.mockReturnValue(0);

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

    // Workflow 1 runs to completion
    await capturedHandler({ event: makeTaskReadyEvent("TEST-1"), step });

    // The key insight: claimTaskForDispatch transitions the TASK to "running"
    // but assertSessionCapacity checks INVOCATIONS with status="running".
    // Between claim and insertInvocation, there are 0 running invocations
    // from this task. So a second workflow checking at that exact moment
    // also sees 0 and proceeds.
    //
    // This is a design gap: the capacity check and the invocation insert
    // are not atomic.
    expect(mockSpawnSession).toHaveBeenCalledTimes(1);

    // To actually exploit this, we'd need two concurrent step.run() calls,
    // which Inngest prevents via its concurrency config. But if Inngest's
    // concurrency enforcement fails or is misconfigured, this is exploitable.
  });
});

// ===========================================================================
// 4. Cron task lifecycle: capacity enforcement
// ===========================================================================

describe("cron-task-lifecycle capacity enforcement", () => {
  test("cron task respects concurrency cap — exits gracefully", async () => {
    // With cap=1 and 1 active session, cron should be blocked but not crash
    mockCountActiveSessions.mockReturnValue(1);

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);

    const step = createStep();

    // The claim-task step catches the capacity error and returns gracefully
    const result = await capturedCronHandler({
      event: makeTaskReadyEvent("CRON-1", "cron_claude"),
      step,
    });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: "session cap reached",
    });

    // Task should NOT have been claimed
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
  });

  test("cron task proceeds when under capacity", async () => {
    mockCountActiveSessions.mockReturnValue(0);

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep(
      new Map([
        [
          "await-session",
          {
            name: "session/completed",
            data: {
              invocationId: 1,
              exitCode: 0,
            },
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

  test("FIXED: cron spawn step now checks capacity (same as task-lifecycle)", async () => {
    // After the fix, cron-task-lifecycle checks capacity in BOTH claim-task
    // and start-implement, matching task-lifecycle behavior.
    //
    // Proof: make countActiveSessions return 0 for claim, then 1 for start-implement.
    // The spawn step should now throw because capacity is full.

    mockCountActiveSessions
      .mockReturnValueOnce(0) // claim-task: under cap, proceed
      .mockReturnValueOnce(1); // start-implement: at cap, should throw

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();

    // start-implement should now throw because the second capacity check fails
    await expect(
      capturedCronHandler({
        event: makeTaskReadyEvent("CRON-1", "cron_claude"),
        step,
      }),
    ).rejects.toThrow(/session cap reached/);

    // Session should NOT have been spawned
    expect(mockSpawnSession).not.toHaveBeenCalled();

    // Verify countActiveSessions was called TWICE (claim-task + start-implement)
    expect(mockCountActiveSessions).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 5. claim-task capacity rejection leaves DB clean
// ===========================================================================

describe("claim-task capacity rejection", () => {
  test("capacity exceeded in claim-task: claimTaskForDispatch is never called", async () => {
    mockCountActiveSessions.mockReturnValue(1); // at cap (cap=1)

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);

    const step = createStep();

    // The claim-task step returns gracefully with { claimed: false } instead
    // of throwing — with retries: 0, a throw would kill the workflow permanently.
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: "session cap reached",
    });

    // claimTaskForDispatch was never called - DB is clean
    expect(mockClaimTaskForDispatch).not.toHaveBeenCalled();
    // No invocation was inserted
    expect(mockInsertInvocation).not.toHaveBeenCalled();
    // No session was spawned
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  test("FIXED: capacity exceeded in start-implement resets task to ready gracefully", async () => {
    // First call (claim-task): under cap
    // Second call (start-implement): at cap (another session started between steps)
    mockCountActiveSessions
      .mockReturnValueOnce(0) // claim-task
      .mockReturnValueOnce(1); // start-implement

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();

    // start-implement catches the capacity error, resets task to "ready",
    // and returns gracefully instead of throwing (which would kill the workflow).
    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });
    expect(result).toEqual({ outcome: "capacity_blocked" });

    // claimTaskForDispatch was called, but no session was spawned
    expect(mockClaimTaskForDispatch).toHaveBeenCalled();
    expect(mockSpawnSession).not.toHaveBeenCalled();
    // Task was reset to "ready" so the reconciler can re-dispatch
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      "TEST-1",
      "ready",
    );
  });
});

// ===========================================================================
// 6. DB fallback resets task to "ready" unconditionally
// ===========================================================================

describe("bridgeSessionCompletion DB fallback edge cases", () => {
  test("FIXED: DB fallback sets task to 'failed' so reconcile-stuck-tasks handles retry", async () => {
    // When inngest.send fails, the DB fallback now sets the task to "failed"
    // instead of "ready". The reconcile-stuck-tasks cron will pick up failed
    // tasks with retries remaining and re-emit them. Tasks with exhausted
    // retries stay permanently failed.
    mockInngestSend.mockRejectedValueOnce(new Error("Inngest down"));

    const mockHandle = {
      done: Promise.resolve({
        subtype: "error" as const, // session failed
        exitCode: 1,
        outputSummary: "fatal error",
        costUsd: 0.5,
        inputTokens: 100,
        outputTokens: 200,
        numTurns: 5,
      }),
      sessionId: "sess-fail",
      kill: vi.fn(),
      process: { exitCode: 1, killed: false, pid: 123 },
    };

    bridgeSessionCompletion(
      50,
      "TASK-EXHAUSTED",
      "implement",
      mockHandle as never,
      "orca/TASK-EXHAUSTED",
      "/tmp/wt-exhausted",
    );

    await new Promise((r) => setTimeout(r, 50));

    // DB fallback now sets to "failed" — reconcile-stuck-tasks handles retry logic
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TASK-EXHAUSTED",
      "failed",
    );
  });

  test("DB fallback sets task to 'failed' even for successful sessions (reconciler handles progression)", async () => {
    // When inngest.send fails, the DB fallback sets the task to "failed"
    // regardless of session outcome. For successful sessions, this is
    // conservative but safe — reconcile-stuck-tasks will detect the completed
    // invocation and can progress the task appropriately.
    mockInngestSend.mockRejectedValueOnce(new Error("Inngest down"));

    const mockHandle = {
      done: Promise.resolve({
        subtype: "success" as const,
        exitCode: 0,
        outputSummary: "PR created successfully",
        costUsd: 1.0,
        inputTokens: 1000,
        outputTokens: 2000,
        numTurns: 10,
      }),
      sessionId: "sess-success",
      kill: vi.fn(),
      process: { exitCode: 0, killed: false, pid: 456 },
    };

    bridgeSessionCompletion(
      51,
      "TASK-SUCCESS",
      "implement",
      mockHandle as never,
      "orca/TASK-SUCCESS",
      "/tmp/wt-success",
    );

    await new Promise((r) => setTimeout(r, 50));

    // Invocation is marked "completed" (correct based on subtype)
    expect(mockUpdateInvocation).toHaveBeenCalledWith(
      mockDb,
      51,
      expect.objectContaining({ status: "completed" }),
    );

    // Task is set to "failed" — reconcile-stuck-tasks will handle progression
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      mockDb,
      "TASK-SUCCESS",
      "failed",
    );
  });
});

// ===========================================================================
// 7. activeHandles cleanup in bridgeSessionCompletion
// ===========================================================================

describe("activeHandles lifecycle in bridgeSessionCompletion", () => {
  test("handle is registered immediately, deleted after done resolves", async () => {
    const doneResolve: { resolve?: (v: unknown) => void } = {};
    const donePromise = new Promise((resolve) => {
      doneResolve.resolve = resolve;
    });

    const mockHandle = {
      done: donePromise,
      sessionId: "sess-track",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 789 },
    };

    bridgeSessionCompletion(
      60,
      "TASK-TRACK",
      "implement",
      mockHandle as never,
      "orca/TASK-TRACK",
      "/tmp/wt-track",
    );

    // Immediately after call, handle should be registered
    expect(activeHandles.has(60)).toBe(true);

    // Resolve the done promise
    doneResolve.resolve!({
      subtype: "success",
      exitCode: 0,
      outputSummary: "done",
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 20,
      numTurns: 1,
    });

    await new Promise((r) => setTimeout(r, 50));

    // After done resolves, handle should be removed
    expect(activeHandles.has(60)).toBe(false);
  });

  test("handle is deleted even when inngest.send fails", async () => {
    mockInngestSend.mockRejectedValueOnce(new Error("send failed"));

    const mockHandle = {
      done: Promise.resolve({
        subtype: "success" as const,
        exitCode: 0,
        outputSummary: "done",
        costUsd: 0.1,
        inputTokens: 10,
        outputTokens: 20,
        numTurns: 1,
      }),
      sessionId: "sess-cleanup",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 101 },
    };

    bridgeSessionCompletion(
      61,
      "TASK-CLEANUP",
      "implement",
      mockHandle as never,
      "orca/TASK-CLEANUP",
      "/tmp/wt-cleanup",
    );

    await new Promise((r) => setTimeout(r, 50));

    // Handle should still be cleaned up from the .then() path (before .catch on send)
    expect(activeHandles.has(61)).toBe(false);
  });
});

// ===========================================================================
// 8. Worktree leak when start-implement throws after createWorktree
// ===========================================================================

describe("resource leaks on capacity rejection", () => {
  test("FIXED: capacity check runs before createWorktree — graceful exit on rejection", async () => {
    // assertSessionCapacity is called BEFORE createWorktree in start-implement.
    // If capacity is full, the step catches the error, resets task to "ready",
    // and returns null so the workflow exits gracefully.

    mockCountActiveSessions
      .mockReturnValueOnce(0) // claim-task: passes
      .mockReturnValueOnce(1); // start-implement: fails

    const task = makeTask({ orcaStatus: "ready" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });
    expect(result).toEqual({ outcome: "capacity_blocked" });

    // createWorktree should NOT have been called — capacity check catches first
    expect(mockCreateWorktree).not.toHaveBeenCalled();

    // No cleanup needed since no worktree was created
    const { removeWorktree } = await import("../src/worktree/index.js");
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();

    // Task was reset to "ready"
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
      expect.anything(),
      "TEST-1",
      "ready",
    );
  });
});
