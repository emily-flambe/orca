// ---------------------------------------------------------------------------
// Adversarial tests for workflow-task-lifecycle.ts — handle lifecycle bugs
//
// Focuses on edge cases not covered by workflow-task-lifecycle.test.ts:
//   1. Handle is NOT removed on normal session completion (bridgeSessionCompletion
//      removes it, but the workflow never calls delete on the success path).
//   2. Fix session timeout: handle removal for the fix phase.
//   3. Review session timeout: handle removal.
//   4. spawnSession throws: no handle registered, workflow does not crash with
//      a dangling handle.
//   5. Inngest step.run idempotency: spawnSession is called INSIDE step.run,
//      so Inngest can replay the step. On replay the handle is registered again
//      but bridgeSessionCompletion is also re-called — creating a second .then()
//      listener on the same handle.done. This is a design risk, not a crash,
//      but it means inngest.send() gets called twice for one session completion.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-var
var capturedHandler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>;
// eslint-disable-next-line no-var
var mockInngestSend: ReturnType<typeof vi.fn>;

vi.mock("../src/inngest/client.js", () => {
  mockInngestSend = vi.fn().mockResolvedValue(undefined);
  return {
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
      send: (...args: unknown[]) => mockInngestSend(...args),
    },
  };
});

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
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn(),
  killSession: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line no-var
var mockActiveHandlesMap: Map<number, unknown>;

vi.mock("../src/session-handles.js", () => {
  mockActiveHandlesMap = new Map();
  return {
    get activeHandles() {
      return mockActiveHandlesMap;
    },
  };
});

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
// Imports
// ---------------------------------------------------------------------------

import {
  getTask,
  claimTaskForDispatch,
  insertInvocation,
  getInvocation,
  updateTaskStatus,
  incrementRetryCount,
} from "../src/db/queries.js";
import { spawnSession, killSession } from "../src/runner/index.js";
import { findPrForBranch } from "../src/github/index.js";
import { existsSync } from "node:fs";
import { writeBackStatus } from "../src/linear/sync.js";
import { createWorktree } from "../src/worktree/index.js";
import { initTaskLifecycle } from "../src/inngest/workflows/task-lifecycle.js";

const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockInsertInvocation = vi.mocked(insertInvocation);
const mockGetInvocation = vi.mocked(getInvocation);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockIncrementRetryCount = vi.mocked(incrementRetryCount);
const mockSpawnSession = vi.mocked(spawnSession);
const mockKillSession = vi.mocked(killSession);
const mockFindPrForBranch = vi.mocked(findPrForBranch);
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

const mockDb = {} as never;
const mockStateMap = {};

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

function createStep(waitForEventResponses: Map<string, unknown> = new Map()) {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    waitForEvent: vi.fn(
      async (id: string, _opts: unknown) =>
        waitForEventResponses.get(id) ?? null,
    ),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockActiveHandlesMap.clear();

  mockKillSession.mockResolvedValue(undefined);
  vi.mocked(insertInvocation).mockReturnValue(1);
  mockLinearClient.createComment.mockResolvedValue({});
  mockLinearClient.createAttachment.mockResolvedValue({});
  mockExistsSync.mockReturnValue(false);
  mockWriteBackStatus.mockResolvedValue(undefined);
  mockCreateWorktree.mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  });
  mockSpawnSession.mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
    process: { exitCode: null, killed: false, pid: 9999 },
  } as never);
  mockInngestSend.mockResolvedValue(undefined);

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

describe("task-lifecycle — handle lifecycle adversarial", () => {
  // -------------------------------------------------------------------------
  // BUG: handle remains in activeHandles after successful session completion
  //
  // After spawnSession() → bridgeSessionCompletion() is set up. When the
  // session's .done resolves, bridgeSessionCompletion deletes the handle.
  // But in the tests, handle.done is `new Promise(() => {})` — it NEVER
  // resolves, so the bridge callback never fires. The workflow proceeds past
  // step.waitForEvent() because the test provides the event directly, but
  // the handle.done Promise is never settled. This means in production, if
  // bridgeSessionCompletion fires and deletes the handle, everything is fine.
  // But if bridgeSessionCompletion does NOT fire (e.g., inngest is down),
  // the sweep handles it. The key gap: the TEST SUITE never verifies that
  // after a NORMAL session completion (non-timeout path), the handle was
  // eventually removed. The timeout path deletes synchronously; the success
  // path relies entirely on bridgeSessionCompletion (async).
  //
  // This test documents that the test suite itself has a flaw: it never
  // settles handle.done, so bridgeSessionCompletion.then() never fires in
  // any test. The existing tests pass only because they test the timeout path
  // (which deletes synchronously) or don't check activeHandles after success.
  // -------------------------------------------------------------------------

  test("BUG: after successful implement, handle.done never settles in tests — bridgeSessionCompletion delete is untested", async () => {
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

    // A handle whose done RESOLVES (simulating real completion)
    let resolveDone!: (r: unknown) => void;
    const doneProm = new Promise((r) => {
      resolveDone = r;
    });

    const fakeHandle = {
      done: doneProm,
      sessionId: "sess-123",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 9999 },
    };
    mockSpawnSession.mockReturnValue(fakeHandle as never);
    mockActiveHandlesMap.set(1, fakeHandle);

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    // Provide the await-review-0 null response to stop the workflow after Gate 2
    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", null],
      ]),
    );

    await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    // After the workflow finishes with timed_out (review timeout), the
    // implement handle should have been cleaned up in the review timeout path.
    // But we seeded it manually at key=1; the review invocation would also be
    // at key=2. The implement handle at key=1 was NOT deleted by the workflow
    // (only the review handle gets deleted on review timeout).
    //
    // This exposes the gap: implement handle deletion relies solely on
    // bridgeSessionCompletion. Resolve the done promise now and verify the
    // deletion fires.

    resolveDone({ subtype: "success", exitCode: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 1, outputSummary: "", exitSignal: null, rateLimitResetsAt: undefined });

    // Wait for microtasks / promise resolution
    await new Promise((r) => setTimeout(r, 10));

    // The handle at key=1 should now be gone because bridgeSessionCompletion
    // was called and its .then() fired after doneProm resolved.
    // If this assertion FAILS, it means bridgeSessionCompletion was never
    // called or its delete was swallowed.
    expect(mockActiveHandlesMap.has(1)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG: review session timeout — verify handle is actually removed
  //
  // This mirrors the existing implement timeout test but targets the REVIEW
  // phase. The existing test suite has no test that checks activeHandles
  // cleanup specifically for the review timeout path.
  // -------------------------------------------------------------------------

  test("review timeout: handle at review invocationId removed from activeHandles", async () => {
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

    const reviewHandle = {
      done: new Promise(() => {}),
      sessionId: "sess-review",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 7777 },
    };

    // spawnSession returns implement handle first, then review handle
    mockSpawnSession
      .mockReturnValueOnce({
        done: new Promise(() => {}),
        sessionId: "sess-impl",
        kill: vi.fn(),
        process: { exitCode: null, killed: false, pid: 9999 },
      } as never)
      .mockReturnValueOnce(reviewHandle as never);

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    // Review times out
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
    // The review handle was registered with invocationId=2; it should be
    // removed by the timeout handler.
    expect(mockKillSession).toHaveBeenCalledWith(reviewHandle);
    expect(mockActiveHandlesMap.has(2)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG: fix session timeout — handle removal not tested
  //
  // The existing test suite has no test for the fix session timeout path.
  // The process-fix step has the same kill+delete pattern, but it is entirely
  // untested.
  // -------------------------------------------------------------------------

  test("fix timeout: handle at fix invocationId removed from activeHandles", async () => {
    const task = makeTask({ prNumber: 42, prBranchName: "orca/TEST-1-inv-1" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    // implement=1, review=2, fix=3
    mockInsertInvocation
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3);
    mockGetInvocation
      .mockReturnValueOnce({ outputSummary: "" }) // Gate 2
      .mockReturnValueOnce({ outputSummary: "REVIEW_RESULT:CHANGES_REQUESTED" }); // review cycle 0
    mockFindPrForBranch.mockReturnValue({
      exists: true,
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      headBranch: "orca/TEST-1-inv-1",
      merged: false,
    });

    const fixHandle = {
      done: new Promise(() => {}),
      sessionId: "sess-fix",
      kill: vi.fn(),
      process: { exitCode: null, killed: false, pid: 6666 },
    };

    mockSpawnSession
      .mockReturnValueOnce({
        done: new Promise(() => {}),
        sessionId: "sess-impl",
        kill: vi.fn(),
        process: { exitCode: null, killed: false, pid: 9999 },
      } as never)
      .mockReturnValueOnce({
        done: new Promise(() => {}),
        sessionId: "sess-review",
        kill: vi.fn(),
        process: { exitCode: null, killed: false, pid: 7777 },
      } as never)
      .mockReturnValueOnce(fixHandle as never);

    const implementEvent = makeSessionCompletedEvent({ invocationId: 1 });
    const reviewEvent = makeSessionCompletedEvent({
      invocationId: 2,
      phase: "review",
    });
    // Fix session times out
    const step = createStep(
      new Map([
        ["await-implement", implementEvent],
        ["await-review-0", reviewEvent],
        ["await-fix-0", null],
      ]),
    );

    const result = await capturedHandler({
      event: makeTaskReadyEvent(),
      step,
    });

    expect(result).toMatchObject({ outcome: "fix_timed_out" });
    // Fix handle (invocationId=3) must be killed and removed
    expect(mockKillSession).toHaveBeenCalledWith(fixHandle);
    expect(mockActiveHandlesMap.has(3)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG: spawnSession throws inside step.run — handle never registered,
  // but step.run would propagate the exception. Verify the workflow does NOT
  // leave a stale handle in activeHandles when spawnSession throws.
  // -------------------------------------------------------------------------

  test("spawnSession throws — no stale handle left in activeHandles", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockInsertInvocation.mockReturnValue(1);

    // spawnSession throws — this means activeHandles.set is never called
    mockSpawnSession.mockImplementation(() => {
      throw new Error("spawn failed: ENOENT");
    });

    const step = createStep();

    // The step.run mock calls the function immediately. If spawnSession throws,
    // step.run will throw, and the workflow should propagate this as an error.
    await expect(
      capturedHandler({ event: makeTaskReadyEvent(), step }),
    ).rejects.toThrow("spawn failed");

    // No handle should be in the map
    expect(mockActiveHandlesMap.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // BUG: double-delete race between abort endpoint and bridgeSessionCompletion
  //
  // Scenario:
  //   1. Session is running: activeHandles has invocationId → handle
  //   2. API abort endpoint fires: kills process, deletes from activeHandles
  //   3. bridgeSessionCompletion's .then() fires (process ended): tries to
  //      delete again — already gone, but Map.delete on a missing key is safe
  //
  // This is NOT a crash bug (Map.delete is idempotent), but the test suite
  // never verifies this. Document and test it.
  // -------------------------------------------------------------------------

  test("Map.delete on already-absent key is safe (idempotent) — double-delete is not a bug", () => {
    // This test documents that the double-delete scenario is safe.
    const map = new Map<number, unknown>();
    map.set(1, { process: {} });

    // First delete (abort endpoint)
    map.delete(1);
    expect(map.has(1)).toBe(false);

    // Second delete (bridgeSessionCompletion)
    expect(() => map.delete(1)).not.toThrow();
    expect(map.has(1)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG: Inngest step replay — spawnSession called twice for the same session
  //
  // When Inngest replays a step (e.g. server restart mid-step), the step.run
  // callback runs again. This means:
  //   - spawnSession() is called a second time
  //   - activeHandles.set(invocationId, newHandle) overwrites the old handle
  //   - bridgeSessionCompletion() is called a second time with the new handle
  //
  // The OLD done promise from the first spawn still has a .then() listener
  // that will fire when the first process exits — but the activeHandles entry
  // now points to a different handle. The listener's delete will remove the
  // WRONG entry (or the right one if they share the same invocationId key).
  //
  // This is flagged as a DESIGN RISK. We cannot write a failing unit test for
  // this without actually having Inngest replay logic, but we can document it
  // here and write a test that demonstrates the problem with a simplified
  // reproduction.
  // -------------------------------------------------------------------------

  test("DESIGN RISK: two bridgeSessionCompletion calls on same invocationId cause double inngest.send", async () => {
    // Simulate what happens when Inngest replays the start-implement step:
    // bridgeSessionCompletion is called twice for the same invocationId.

    const log: string[] = [];
    const map = new Map<number, unknown>();
    const invocationId = 1;

    // Simulate the bridge function (simplified version of bridgeSessionCompletion)
    function bridge(
      id: number,
      done: Promise<unknown>,
      sendLabel: string,
    ): void {
      done
        .then(() => {
          map.delete(id);
          log.push(`send:${sendLabel}`);
        })
        .catch(() => {});
    }

    // First spawn
    let resolveFirst!: (v: unknown) => void;
    const done1 = new Promise((r) => {
      resolveFirst = r;
    });
    map.set(invocationId, { label: "first" });
    bridge(invocationId, done1, "first");

    // Inngest replays: second spawn (same invocationId)
    let resolveSecond!: (v: unknown) => void;
    const done2 = new Promise((r) => {
      resolveSecond = r;
    });
    map.set(invocationId, { label: "second" }); // overwrites
    bridge(invocationId, done2, "second");

    // First process exits (late)
    resolveFirst({});
    await new Promise((r) => setTimeout(r, 0));

    // Second process exits
    resolveSecond({});
    await new Promise((r) => setTimeout(r, 0));

    // Both bridges fire — inngest.send is called TWICE for one session
    // This is the bug: the first bridge's .then() still runs even after
    // the handle was overwritten in the map.
    expect(log).toEqual(["send:first", "send:second"]);
    // This documents that replaying start-implement would cause two
    // session/completed events for invocationId=1 — Inngest deduplication
    // may or may not handle this correctly.
  });
});
