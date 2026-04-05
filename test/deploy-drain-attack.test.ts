// ---------------------------------------------------------------------------
// deploy-drain-attack.test.ts — adversarial tests for EMI-359 drain logic
//
// Tests are written to EXPOSE bugs. They are expected to fail if the
// implementation has the defects described in each test.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest before any imports)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  };
});

vi.mock("../src/inngest/deps.js", () => ({
  getSchedulerDeps: vi.fn().mockReturnValue({
    config: { concurrencyCap: 1 },
  }),
}));

vi.mock("../src/db/queries.js", () => ({
  countActiveSessions: vi.fn().mockReturnValue(0),
  getTask: vi.fn(),
  claimTaskForDispatch: vi.fn(),
  updateTaskStatus: vi.fn(),
  insertInvocation: vi.fn().mockReturnValue(1),
  updateInvocation: vi.fn(),
  getDispatchableTasks: vi.fn().mockReturnValue([]),
  getFailedTasksWithRetriesRemaining: vi.fn().mockReturnValue([]),
  getRunningInvocations: vi.fn().mockReturnValue([]),
  incrementStaleSessionRetryCount: vi.fn(),
  insertSystemEvent: vi.fn(),
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
  resetStaleSessionRetryCount: vi.fn(),
  clearSessionIds: vi.fn(),
}));

vi.mock("../src/inngest/resource-check.js", () => ({
  getResourceSnapshot: vi.fn().mockReturnValue({
    memAvailableMb: 9999,
    cpuLoadPercent: 0,
  }),
  isResourceConstrained: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
  sweepExitedHandles: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}));

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(() => ({ id: "mock-function" })),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitInvocationStarted: vi.fn(),
  emitInvocationCompleted: vi.fn(),
}));

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn().mockReturnValue({
    worktreePath: "/tmp/worktree",
    branchName: "orca/TEST-1-inv-1",
  }),
  removeWorktree: vi.fn(),
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn().mockReturnValue({
    done: new Promise(() => {}),
    sessionId: "sess-123",
    kill: vi.fn(),
  }),
  killSession: vi.fn().mockResolvedValue(undefined),
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
    sendAlert: vi.fn(),
    sendAlertThrottled: vi.fn(),
  };
});

vi.mock("../src/scheduler/stuck-task-detector.js", () => ({
  detectAndAlertStuckTasks: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import { isDraining, setDraining, clearDraining } from "../src/deploy.js";
import { assertSessionCapacity } from "../src/inngest/workflows/task-lifecycle.js";
import { countActiveSessions } from "../src/db/queries.js";
import { activeHandles } from "../src/session-handles.js";
import { inngest } from "../src/inngest/client.js";
import { getSchedulerDeps } from "../src/inngest/deps.js";
import { runReconciliation } from "../src/inngest/workflows/reconcile-stuck-tasks.js";
import {
  getDispatchableTasks,
  getRunningInvocations,
  getFailedTasksWithRetriesRemaining,
} from "../src/db/queries.js";

const mockDb = {} as never;

// ---------------------------------------------------------------------------
// Helper: reset drain state between tests
// ---------------------------------------------------------------------------
function resetDrainState(): void {
  // Force-clear drain state by reading it and clearing if set.
  // We can't use clearDraining when not draining, so check first.
  if (isDraining()) {
    clearDraining();
  }
}

// ---------------------------------------------------------------------------
// Tests: clearDraining recovery
// ---------------------------------------------------------------------------

describe("deploy drain — clearDraining recovery", () => {
  beforeEach(() => {
    resetDrainState();
    vi.clearAllMocks();
    vi.mocked(getSchedulerDeps).mockReturnValue({
      config: { concurrencyCap: 1 },
    } as never);
    vi.mocked(countActiveSessions).mockReturnValue(0);
    (activeHandles as Map<number, unknown>).clear();
  });

  test("clearDraining restores isDraining to false after setDraining", () => {
    // Bug target: if clearDraining is broken, isDraining stays true after
    // /api/deploy/unpause is called, permanently blocking all new sessions.
    setDraining();
    expect(isDraining()).toBe(true);

    clearDraining();
    // THIS MUST BE FALSE — recovery must work
    expect(isDraining()).toBe(false);
  });

  test("after clearDraining, a second drain cycle works correctly", () => {
    // Bug target: a second drain (sequential deploys) should work.
    setDraining();
    clearDraining();
    setDraining(); // second deploy cycle
    expect(isDraining()).toBe(true);
    clearDraining();
    expect(isDraining()).toBe(false);
  });

  test("clearDraining is idempotent when not draining", () => {
    expect(isDraining()).toBe(false);
    expect(() => clearDraining()).not.toThrow();
    expect(isDraining()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: assertSessionCapacity drain interaction
// ---------------------------------------------------------------------------

describe("assertSessionCapacity — drain integration", () => {
  beforeEach(() => {
    resetDrainState();
    vi.clearAllMocks();
    vi.mocked(getSchedulerDeps).mockReturnValue({
      config: { concurrencyCap: 1 },
    } as never);
    vi.mocked(countActiveSessions).mockReturnValue(0);
    (activeHandles as Map<number, unknown>).clear();
  });

  test("assertSessionCapacity throws with drain-specific message when draining", () => {
    // Bug target: the error message must contain "draining" so callers
    // can distinguish drain errors from concurrency cap errors in logs.
    setDraining();

    let thrownError: Error | null = null;
    try {
      assertSessionCapacity(mockDb);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toContain("draining");
  });

  test("assertSessionCapacity does NOT throw after clearDraining (sessions=0, under cap)", () => {
    // Bug target: after /api/deploy/unpause is called, new sessions must be
    // allowed again. If clearDraining is broken, this throws permanently.
    setDraining();
    clearDraining(); // simulate unpause endpoint

    // Must NOT throw — the instance is unpaused
    expect(() => assertSessionCapacity(mockDb)).not.toThrow();
  });

  test("drain error takes priority over concurrency cap error", () => {
    // Bug target: if concurrency cap is checked first and is at capacity,
    // the error would say "session cap reached" instead of "draining".
    // The caller in start-implement logs the reason and resets with
    // reason "spawn_blocked_capacity" — which is confusing for drain.
    // Drain MUST be checked first.
    vi.mocked(countActiveSessions).mockReturnValue(99);
    // Mock activeHandles.size to be large
    const handles = activeHandles as Map<number, unknown>;
    for (let i = 0; i < 5; i++) {
      handles.set(i, {});
    }

    setDraining();

    let thrownError: Error | null = null;
    try {
      assertSessionCapacity(mockDb);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    // Must say "draining", NOT "session cap reached"
    expect(thrownError!.message).toMatch(/draining/i);
    expect(thrownError!.message).not.toMatch(/session cap reached/i);
  });

  test("assertSessionCapacity does not throw when not draining and under cap", () => {
    // Baseline: normal operation — no drain, under cap
    expect(isDraining()).toBe(false);
    vi.mocked(countActiveSessions).mockReturnValue(0);
    expect(() => assertSessionCapacity(mockDb)).not.toThrow();
  });

  test("assertSessionCapacity throws for concurrency cap when NOT draining", () => {
    // Verify cap still works when not draining
    vi.mocked(countActiveSessions).mockReturnValue(1);
    vi.mocked(getSchedulerDeps).mockReturnValue({
      config: { concurrencyCap: 1 },
    } as never);

    expect(isDraining()).toBe(false);
    expect(() => assertSessionCapacity(mockDb)).toThrow(/session cap reached/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: reconciler does NOT check isDraining before re-dispatching
// ---------------------------------------------------------------------------

describe("reconciler re-dispatch-ready-tasks gap during drain", () => {
  beforeEach(() => {
    resetDrainState();
    vi.clearAllMocks();

    const mockConfig = {
      maxRetries: 3,
    } as never;

    vi.mocked(getSchedulerDeps).mockReturnValue({
      db: mockDb,
      config: mockConfig,
    } as never);
    vi.mocked(getDispatchableTasks).mockReturnValue([]);
    vi.mocked(getRunningInvocations).mockReturnValue([]);
    vi.mocked(getFailedTasksWithRetriesRemaining).mockReturnValue([]);
  });

  test("runReconciliation does not emit task/ready while draining (stranded task reset)", async () => {
    // Verify that when an instance is draining and a stranded task exists,
    // runReconciliation resets it to ready WITHOUT re-emitting task/ready.
    //
    // The running instance is draining — it should NOT send new Inngest events
    // to avoid triggering workflows on itself right before shutdown.
    //
    // BUG: runReconciliation currently emits task/ready via inngest.send()
    // for stranded tasks regardless of drain state. This means the dying
    // instance is creating new task/ready events for itself to consume,
    // which will all fail the drain check — wasted work.

    setDraining();

    const strandedTask = {
      linearIssueId: "TEST-99",
      lifecycleStage: "active",
      currentPhase: "implement",
      retryCount: 0,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old
      repoPath: "/repo",
      priority: 0,
      projectName: "test",
      taskType: "feature",
      createdAt: new Date().toISOString(),
    };

    vi.mocked(getDispatchableTasks).mockReturnValue([strandedTask] as never);
    vi.mocked(getRunningInvocations).mockReturnValue([]);
    const { incrementStaleSessionRetryCount } =
      await import("../src/db/queries.js");
    vi.mocked(incrementStaleSessionRetryCount).mockReturnValue(1);

    const mockConfig = {
      maxRetries: 3,
    } as never;

    const inngestSend = vi.mocked(inngest.send);
    inngestSend.mockClear();

    await runReconciliation({ db: mockDb, config: mockConfig });

    // The reconciler WILL emit task/ready for the stranded task.
    // When draining, it SHOULD NOT do this — but currently it does.
    // This test documents the gap: it will FAIL (inngestSend IS called)
    // until the reconciler checks isDraining() before emitting task/ready.
    expect(inngestSend).not.toHaveBeenCalled();
  });
});
