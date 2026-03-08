// ---------------------------------------------------------------------------
// Scheduler tests — dispatch logic, gating, completion handlers
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  getTask,
  getInvocationsByTask,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";
import {
  startScheduler,
  attachCompletionHandler,
  activeHandles,
} from "../src/scheduler/index.js";
import { spawnSession } from "../src/runner/index.js";
import { isDraining } from "../src/deploy.js";
import { createWorktree } from "../src/worktree/index.js";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Module mocks (must be at top level)
// ---------------------------------------------------------------------------

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/runner/index.js", () => ({
  spawnSession: vi.fn(),
  killSession: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  findPrForBranch: vi.fn(),
  findPrByUrl: vi.fn(),
  getMergeCommitSha: vi.fn(),
  getPrCheckStatus: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
  mergePr: vi.fn(),
  getPrMergeState: vi.fn(),
  updatePrBranch: vi.fn(),
  closeSupersededPrs: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/git.js", () => ({
  isTransientGitError: vi.fn().mockReturnValue(false),
  isDllInitError: vi.fn().mockReturnValue(false),
  git: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
  evaluateParentStatuses: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitInvocationStarted: vi.fn(),
  emitInvocationCompleted: vi.fn(),
  emitStatusUpdated: vi.fn(),
}));

vi.mock("../src/cleanup/index.js", () => ({
  cleanupStaleResources: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

let taskCounter = 0;

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: TaskStatus;
    priority: number;
    retryCount: number;
    prBranchName: string | null;
    reviewCycleCount: number;
    isParent: number;
    parentIdentifier: string | null;
    createdAt: string;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `SCHED-${++taskCounter}-${Date.now().toString(36)}`;
  const ts = overrides.createdAt ?? now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "implement the feature",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    prBranchName: overrides.prBranchName ?? null,
    reviewCycleCount: overrides.reviewCycleCount ?? 0,
    isParent: overrides.isParent ?? 0,
    parentIdentifier: overrides.parentIdentifier ?? null,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    fixReason: null,
    mergeAttemptCount: 0,
    doneAt: null,
    projectName: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 3600, // long interval — we trigger ticks manually
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10000, // large value to skip cleanup during tests
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    projectRepoMap: new Map(),
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    ...overrides,
  };
}

function makeDeps(db: OrcaDb, config: OrcaConfig = testConfig()) {
  return {
    db,
    config,
    graph: {
      isDispatchable: vi.fn().mockReturnValue(true),
      computeEffectivePriority: vi
        .fn()
        .mockImplementation(
          (taskId: string, getPrio: (id: string) => number) => getPrio(taskId),
        ),
      rebuild: vi.fn(),
    } as any,
    client: {
      createComment: vi.fn().mockResolvedValue(undefined),
      createAttachment: vi.fn().mockResolvedValue(undefined),
    } as any,
    stateMap: new Map(),
  };
}

/** Return a never-resolving session handle mock. */
function makeNeverResolvingHandle() {
  return {
    done: new Promise<never>(() => {}),
    sessionId: "mock-session-123",
    process: { exitCode: null } as any,
    invocationId: 0,
    result: null,
  };
}

// ---------------------------------------------------------------------------
// Wait utilities
// ---------------------------------------------------------------------------

/** Wait for a condition to be true, polling at 10ms intervals. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Common afterEach
// ---------------------------------------------------------------------------

afterEach(() => {
  activeHandles.clear();
});

// ===========================================================================
// 1. Dispatch priority ordering
// ===========================================================================

describe("Dispatch priority ordering", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    // Re-apply defaults cleared by clearAllMocks
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("in_review task is dispatched before ready task", async () => {
    const readyId = seedTask(db, { linearIssueId: "PRIO-READY-1", orcaStatus: "ready" });
    const inReviewId = seedTask(db, {
      linearIssueId: "PRIO-REVIEW-1",
      orcaStatus: "in_review",
      prBranchName: "orca/PRIO-REVIEW-1/1",
    });

    let dispatchedTaskId: string | undefined;
    vi.mocked(createWorktree).mockImplementation((_repoPath, taskId) => {
      dispatchedTaskId = taskId as string;
      return { worktreePath: "/tmp/fake-worktree", branchName: "orca/test/1" };
    });
    vi.mocked(spawnSession).mockReturnValue(makeNeverResolvingHandle() as any);

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => dispatchedTaskId !== undefined);
    handle.stop();

    expect(dispatchedTaskId).toBe(inReviewId);
    expect(getTask(db, readyId)?.orcaStatus).toBe("ready");
  });

  test("changes_requested task is dispatched before ready task", async () => {
    const readyId = seedTask(db, { linearIssueId: "PRIO-READY-2", orcaStatus: "ready" });
    const changesId = seedTask(db, {
      linearIssueId: "PRIO-CHANGES-1",
      orcaStatus: "changes_requested",
      prBranchName: "orca/PRIO-CHANGES-1/1",
    });

    let dispatchedTaskId: string | undefined;
    vi.mocked(createWorktree).mockImplementation((_repoPath, taskId) => {
      dispatchedTaskId = taskId as string;
      return { worktreePath: "/tmp/fake-worktree", branchName: "orca/test/1" };
    });
    vi.mocked(spawnSession).mockReturnValue(makeNeverResolvingHandle() as any);

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => dispatchedTaskId !== undefined);
    handle.stop();

    expect(dispatchedTaskId).toBe(changesId);
    expect(getTask(db, readyId)?.orcaStatus).toBe("ready");
  });

  test("within ready phase: lower priority number dispatched first", async () => {
    const ts1 = "2024-01-01T00:00:00.000Z";
    const ts2 = "2024-01-01T00:00:01.000Z";
    const highPrioId = seedTask(db, {
      linearIssueId: "PRIO-HIGH-1",
      orcaStatus: "ready",
      priority: 1,
      createdAt: ts1,
    });
    const lowPrioId = seedTask(db, {
      linearIssueId: "PRIO-LOW-1",
      orcaStatus: "ready",
      priority: 0,
      createdAt: ts2,
    });

    let dispatchedTaskId: string | undefined;
    vi.mocked(createWorktree).mockImplementation((_repoPath, taskId) => {
      dispatchedTaskId = taskId as string;
      return { worktreePath: "/tmp/fake-worktree", branchName: "orca/test/1" };
    });
    vi.mocked(spawnSession).mockReturnValue(makeNeverResolvingHandle() as any);

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => dispatchedTaskId !== undefined);
    handle.stop();

    // priority 0 (lowPrioId) should go first despite being created later
    expect(dispatchedTaskId).toBe(lowPrioId);
    expect(getTask(db, highPrioId)?.orcaStatus).toBe("ready");
  });

  test("within same phase and priority: earlier createdAt dispatched first", async () => {
    const ts1 = "2024-01-01T00:00:00.000Z";
    const ts2 = "2024-01-01T01:00:00.000Z";
    const earlierId = seedTask(db, {
      linearIssueId: "PRIO-EARLY-1",
      orcaStatus: "ready",
      priority: 0,
      createdAt: ts1,
    });
    seedTask(db, {
      linearIssueId: "PRIO-LATE-1",
      orcaStatus: "ready",
      priority: 0,
      createdAt: ts2,
    });

    let dispatchedTaskId: string | undefined;
    vi.mocked(createWorktree).mockImplementation((_repoPath, taskId) => {
      dispatchedTaskId = taskId as string;
      return { worktreePath: "/tmp/fake-worktree", branchName: "orca/test/1" };
    });
    vi.mocked(spawnSession).mockReturnValue(makeNeverResolvingHandle() as any);

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => dispatchedTaskId !== undefined);
    handle.stop();

    expect(dispatchedTaskId).toBe(earlierId);
  });
});

// ===========================================================================
// 2. Concurrency cap enforcement
// ===========================================================================

describe("Concurrency cap enforcement", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("does not dispatch when active sessions >= concurrencyCap", async () => {
    const config = testConfig({ concurrencyCap: 1 });

    // Insert a running invocation to consume the cap
    const runningTaskId = seedTask(db, {
      linearIssueId: "CAP-RUNNING-1",
      orcaStatus: "running",
    });
    insertInvocation(db, {
      linearIssueId: runningTaskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // Seed a ready task that should NOT be dispatched
    seedTask(db, { linearIssueId: "CAP-READY-1", orcaStatus: "ready" });

    const deps = makeDeps(db, config);
    const handle = startScheduler(deps);

    // Wait a short time and confirm spawnSession was not called
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    handle.stop();

    expect(spawnSession).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. Budget exhaustion gating
// ===========================================================================

describe("Budget exhaustion gating", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("does not dispatch when budget is exhausted", async () => {
    const config = testConfig({ budgetMaxCostUsd: 10.0, budgetWindowHours: 4 });

    // Insert a budget event that exceeds the cap
    const helperTaskId = seedTask(db, {
      linearIssueId: "BUDGET-HELPER-1",
      orcaStatus: "done",
    });
    const helperId = insertInvocation(db, {
      linearIssueId: helperTaskId,
      startedAt: now(),
      status: "completed",
      phase: "implement",
      model: "sonnet",
    });
    insertBudgetEvent(db, {
      invocationId: helperId,
      costUsd: 15.0,
      recordedAt: new Date().toISOString(),
    });

    // Seed a ready task that should NOT be dispatched
    seedTask(db, { linearIssueId: "BUDGET-READY-1", orcaStatus: "ready" });

    const deps = makeDeps(db, config);
    const handle = startScheduler(deps);

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    handle.stop();

    expect(spawnSession).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Drain state
// ===========================================================================

describe("Drain state", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("does not dispatch when isDraining returns true", async () => {
    vi.mocked(isDraining).mockReturnValue(true);

    seedTask(db, { linearIssueId: "DRAIN-READY-1", orcaStatus: "ready" });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    handle.stop();

    expect(spawnSession).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. Stale session handling
// ===========================================================================

describe("Stale session handling", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("stale session error clears sessionId and re-queues without incrementing retryCount", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "STALE-1",
      orcaStatus: "running",
      retryCount: 0,
    });

    // Insert the currently "running" invocation
    const runningInvId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // Insert a completed implement invocation with a sessionId (source of resume)
    const sourceInvId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      phase: "implement",
      model: "sonnet",
      sessionId: "stale-session-abc123",
    });

    const staleResult = {
      subtype: "error_during_execution",
      outputSummary: "No conversation found with session ID abc123",
      costUsd: null,
      numTurns: null,
      rateLimitResetsAt: null,
      exitCode: 1,
      exitSignal: null,
    };

    let doneResolve!: (result: any) => void;
    const donePromise = new Promise<any>((resolve) => {
      doneResolve = resolve;
    });

    const mockHandle = {
      done: donePromise,
      sessionId: null,
      process: { exitCode: null } as any,
      invocationId: runningInvId,
      result: null,
    };

    const deps = makeDeps(db);
    attachCompletionHandler(
      deps,
      taskId,
      runningInvId,
      mockHandle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    // Trigger the completion
    doneResolve(staleResult);

    // Wait for the handler to process
    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "ready";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(0); // NOT incremented

    // Source invocation's sessionId should be cleared
    const invocations = getInvocationsByTask(db, taskId);
    const sourceInv = invocations.find((i) => i.id === sourceInvId);
    expect(sourceInv).toBeDefined();
    expect(sourceInv!.sessionId).toBeNull();
  });
});

// ===========================================================================
// 6. Retry limit enforcement
// ===========================================================================

describe("Retry limit enforcement", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("failure under retry limit: task gets retryCount incremented and status reset to ready", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "RETRY-UNDER-1",
      orcaStatus: "running",
      retryCount: 0,
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    const failResult = {
      subtype: "error_during_execution",
      outputSummary: "some execution error",
      costUsd: null,
      numTurns: null,
      rateLimitResetsAt: null,
      exitCode: 1,
      exitSignal: null,
    };

    let doneResolve!: (result: any) => void;
    const donePromise = new Promise<any>((resolve) => {
      doneResolve = resolve;
    });

    const mockHandle = {
      done: donePromise,
      sessionId: null,
      process: { exitCode: null } as any,
      invocationId: invId,
      result: null,
    };

    const deps = makeDeps(db, testConfig({ maxRetries: 3 }));
    attachCompletionHandler(
      deps,
      taskId,
      invId,
      mockHandle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    doneResolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "ready";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(1);
  });

  test("failure at retry limit: task stays failed", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "RETRY-AT-LIMIT-1",
      orcaStatus: "running",
      retryCount: 3, // already at maxRetries
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    const failResult = {
      subtype: "error_during_execution",
      outputSummary: "some execution error",
      costUsd: null,
      numTurns: null,
      rateLimitResetsAt: null,
      exitCode: 1,
      exitSignal: null,
    };

    let doneResolve!: (result: any) => void;
    const donePromise = new Promise<any>((resolve) => {
      doneResolve = resolve;
    });

    const mockHandle = {
      done: donePromise,
      sessionId: null,
      process: { exitCode: null } as any,
      invocationId: invId,
      result: null,
    };

    const deps = makeDeps(db, testConfig({ maxRetries: 3 }));
    attachCompletionHandler(
      deps,
      taskId,
      invId,
      mockHandle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    doneResolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "failed";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("failed");
    // retryCount stays at 3 (not incremented when at limit)
    expect(task.retryCount).toBe(3);
  });
});

// ===========================================================================
// 7. Session resume: max-turns detected
// ===========================================================================

describe("Session resume on max-turns", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
  });

  test("dispatches with resumeSessionId when max-turns invocation exists and worktree is present", async () => {
    // Make existsSync return true so the scheduler sees the preserved worktree
    vi.mocked(existsSync).mockReturnValue(true);

    const taskId = seedTask(db, {
      linearIssueId: "RESUME-MAXTURNS-1",
      orcaStatus: "ready",
    });

    // Insert a previous max-turns invocation (the query checks for "max turns reached" in outputSummary)
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
      phase: "implement",
      model: "sonnet",
      sessionId: "prev-session-xyz",
      worktreePath: "/tmp/preserved-worktree",
      outputSummary: "max turns reached",
    });

    let capturedArgs: any;
    vi.mocked(spawnSession).mockImplementation((args) => {
      capturedArgs = args;
      return makeNeverResolvingHandle() as any;
    });

    const deps = makeDeps(db, testConfig({ resumeOnMaxTurns: true }));
    const handle = startScheduler(deps);

    await waitFor(() => capturedArgs !== undefined);
    handle.stop();

    expect(capturedArgs.resumeSessionId).toBe("prev-session-xyz");
  });
});

// ===========================================================================
// 8. Parent tasks are never dispatched
// ===========================================================================

describe("Parent tasks are never dispatched", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("parent task with isParent=1 is never dispatched", async () => {
    seedTask(db, {
      linearIssueId: "PARENT-SKIP-1",
      orcaStatus: "ready",
      isParent: 1,
    });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    handle.stop();

    expect(spawnSession).not.toHaveBeenCalled();
  });

  test("non-parent ready task is dispatched even when parent task exists", async () => {
    seedTask(db, {
      linearIssueId: "PARENT-SKIP-2",
      orcaStatus: "ready",
      isParent: 1,
    });

    const childId = seedTask(db, {
      linearIssueId: "CHILD-SKIP-2",
      orcaStatus: "ready",
      isParent: 0,
    });

    let dispatchedTaskId: string | undefined;
    vi.mocked(createWorktree).mockImplementation((_repoPath, taskId) => {
      dispatchedTaskId = taskId as string;
      return { worktreePath: "/tmp/fake-worktree", branchName: "orca/test/1" };
    });
    vi.mocked(spawnSession).mockReturnValue(makeNeverResolvingHandle() as any);

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => dispatchedTaskId !== undefined);
    handle.stop();

    expect(dispatchedTaskId).toBe(childId);
  });
});

// ===========================================================================
// 9. in_review tasks with exhausted review cycles are skipped
// ===========================================================================

describe("Review cycle cap", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("in_review task with reviewCycleCount >= maxReviewCycles is not dispatched", async () => {
    const config = testConfig({ maxReviewCycles: 3 });

    seedTask(db, {
      linearIssueId: "REVIEW-CAP-1",
      orcaStatus: "in_review",
      reviewCycleCount: 3, // at limit
      prBranchName: "orca/REVIEW-CAP-1/1",
    });

    const deps = makeDeps(db, config);
    const handle = startScheduler(deps);

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    handle.stop();

    expect(spawnSession).not.toHaveBeenCalled();
  });
});
