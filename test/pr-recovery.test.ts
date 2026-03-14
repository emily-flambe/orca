// ---------------------------------------------------------------------------
// PR recovery tests — handleRetry routes tasks with open PRs to the correct
// state instead of retrying from scratch.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  getTask,
  updateTaskPrBranch,
  updateTaskFields,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";
import {
  attachCompletionHandler,
  activeHandles,
} from "../src/scheduler/index.js";
import { isDraining } from "../src/deploy.js";
import { existsSync } from "node:fs";
import { findPrForBranch, getPrCheckStatusSync } from "../src/github/index.js";

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
  getPrCheckStatusSync: vi.fn(),
  getWorkflowRunStatus: vi.fn(),
  mergePr: vi.fn(),
  getPrMergeState: vi.fn(),
  updatePrBranch: vi.fn(),
  rebasePrBranch: vi.fn().mockReturnValue({ success: true }),
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
  cleanupOldInvocationLogs: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
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
    prNumber: number | null;
    reviewCycleCount: number;
    isParent: number;
    parentIdentifier: string | null;
    createdAt: string;
  }> = {},
): string {
  const id =
    overrides.linearIssueId ??
    `PR-REC-${++taskCounter}-${Date.now().toString(36)}`;
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
    prNumber: overrides.prNumber ?? null,
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
    schedulerIntervalSec: 3600,
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
    cleanupIntervalMin: 10000,
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
        .mockImplementation((taskId: string, getPrio: (id: string) => number) =>
          getPrio(taskId),
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

/** Wait for a condition to be true, polling at 10ms intervals. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** Build a controlled promise + a mock SessionHandle around it. */
function makeControllableHandle(invId: number) {
  let doneResolve!: (result: any) => void;
  const donePromise = new Promise<any>((resolve) => {
    doneResolve = resolve;
  });
  const handle = {
    done: donePromise,
    sessionId: null,
    process: { exitCode: null } as any,
    invocationId: invId,
    result: null,
  };
  return { handle, resolve: doneResolve };
}

const failResult = {
  subtype: "error_during_execution",
  outputSummary: "DLL_INIT error during worktree creation",
  costUsd: null,
  numTurns: null,
  rateLimitResetsAt: null,
  exitCode: 1,
  exitSignal: null,
};

// ---------------------------------------------------------------------------
// Common afterEach
// ---------------------------------------------------------------------------

afterEach(() => {
  activeHandles.clear();
});

// ===========================================================================
// PR recovery tests
// ===========================================================================

describe("PR recovery in handleRetry", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  test("task with green CI PR is routed to awaiting_ci instead of retrying", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "PR-REC-GREEN-1",
      orcaStatus: "running",
      retryCount: 0,
      prBranchName: "orca/PR-REC-GREEN-1/1",
      repoPath: "/tmp/fake-repo",
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // findPrForBranch returns an open, unmerged PR
    vi.mocked(findPrForBranch).mockReturnValue({
      exists: true,
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      merged: false,
      headBranch: "orca/PR-REC-GREEN-1/1",
    });
    // CI is passing
    vi.mocked(getPrCheckStatusSync).mockReturnValue("success");

    const deps = makeDeps(db);
    const { handle, resolve } = makeControllableHandle(invId);

    attachCompletionHandler(
      deps,
      taskId,
      invId,
      handle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    resolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "awaiting_ci";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("awaiting_ci");
    // retryCount should NOT have been incremented — we bypassed the retry
    expect(task.retryCount).toBe(0);
  });

  test("task with failing CI PR is routed to changes_requested instead of retrying", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "PR-REC-FAIL-1",
      orcaStatus: "running",
      retryCount: 0,
      prBranchName: "orca/PR-REC-FAIL-1/1",
      repoPath: "/tmp/fake-repo",
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // findPrForBranch returns an open, unmerged PR
    vi.mocked(findPrForBranch).mockReturnValue({
      exists: true,
      url: "https://github.com/owner/repo/pull/99",
      number: 99,
      merged: false,
      headBranch: "orca/PR-REC-FAIL-1/1",
    });
    // CI is failing
    vi.mocked(getPrCheckStatusSync).mockReturnValue("failure");

    const deps = makeDeps(db);
    const { handle, resolve } = makeControllableHandle(invId);

    attachCompletionHandler(
      deps,
      taskId,
      invId,
      handle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    resolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "changes_requested";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("changes_requested");
    // retryCount should NOT have been incremented
    expect(task.retryCount).toBe(0);
    // reviewCycleCount should have been incremented to signal a fix cycle
    expect(task.reviewCycleCount).toBe(1);
  });

  test("task with no open PR proceeds with normal retry", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "PR-REC-NONE-1",
      orcaStatus: "running",
      retryCount: 0,
      prBranchName: "orca/PR-REC-NONE-1/1",
      repoPath: "/tmp/fake-repo",
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // findPrForBranch finds no PR
    vi.mocked(findPrForBranch).mockReturnValue({ exists: false });

    const deps = makeDeps(db, testConfig({ maxRetries: 3 }));
    const { handle, resolve } = makeControllableHandle(invId);

    attachCompletionHandler(
      deps,
      taskId,
      invId,
      handle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    resolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "ready";
    });

    const task = getTask(db, taskId)!;
    expect(task.orcaStatus).toBe("ready");
    // Normal retry: retryCount incremented
    expect(task.retryCount).toBe(1);
  });

  test("task with pending CI PR falls through to normal retry", async () => {
    const taskId = seedTask(db, {
      linearIssueId: "PR-REC-PENDING-1",
      orcaStatus: "running",
      retryCount: 0,
      prBranchName: "orca/PR-REC-PENDING-1/1",
      repoPath: "/tmp/fake-repo",
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      phase: "implement",
      model: "sonnet",
    });

    // PR exists but CI is still pending
    vi.mocked(findPrForBranch).mockReturnValue({
      exists: true,
      url: "https://github.com/owner/repo/pull/77",
      number: 77,
      merged: false,
      headBranch: "orca/PR-REC-PENDING-1/1",
    });
    vi.mocked(getPrCheckStatusSync).mockReturnValue("pending");

    const deps = makeDeps(db, testConfig({ maxRetries: 3 }));
    const { handle, resolve } = makeControllableHandle(invId);

    attachCompletionHandler(
      deps,
      taskId,
      invId,
      handle as any,
      "/tmp/fake-worktree",
      "implement",
      false,
    );

    resolve(failResult);

    await waitFor(() => {
      const task = getTask(db, taskId);
      return task?.orcaStatus === "ready";
    });

    const task = getTask(db, taskId)!;
    // Should fall through to normal retry since CI is pending
    expect(task.orcaStatus).toBe("ready");
    expect(task.retryCount).toBe(1);
  });
});
