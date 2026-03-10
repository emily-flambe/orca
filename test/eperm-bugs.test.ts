// ---------------------------------------------------------------------------
// Tests exposing bugs in the EPERM/transient error handling (EMI-230)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  getInvocationsByTask,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";
import { startScheduler, activeHandles } from "../src/scheduler/index.js";
import { spawnSession } from "../src/runner/index.js";
import { isDraining } from "../src/deploy.js";
import { createWorktree } from "../src/worktree/index.js";
import { existsSync } from "node:fs";
import { isTransientGitError, isDllInitError } from "../src/git.js";

// ---------------------------------------------------------------------------
// Module mocks
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

let taskCounter = 2000;

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
  const id =
    overrides.linearIssueId ??
    `EPERM-${++taskCounter}-${Date.now().toString(36)}`;
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
    schedulerIntervalSec: 3600,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    implementModel: "claude-3-5-sonnet",
    reviewModel: "claude-3-5-haiku",
    fixModel: "claude-3-5-sonnet",
    reviewMaxTurns: 30,
    disallowedTools: "",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10000,
    cleanupBranchMaxAgeMin: 60,
    invocationLogRetentionHours: 24,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    maxWorktreeRetries: 3,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    githubWebhookSecret: undefined,
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

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Run N scheduler ticks sequentially.
 * Each tick: start scheduler (triggers immediate tick) → wait for invocation
 * count to increase (indicates the tick ran) → stop.
 *
 * Uses schedulerIntervalSec: 3600 so only the immediate first tick fires.
 */
async function runNTicks(
  db: OrcaDb,
  deps: ReturnType<typeof makeDeps>,
  taskId: string,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const prevCount = getInvocationsByTask(db, taskId).length;
    const handle = startScheduler(deps);
    await waitFor(() => getInvocationsByTask(db, taskId).length > prevCount);
    handle.stop();
    // Small pause to allow stop cleanup
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const handle of activeHandles.values()) {
    handle.process?.kill?.("SIGKILL");
  }
  activeHandles.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BUG 1: EPERM errors are double-counted via isTransientGitError
//
// The scheduler's dispatch() catch block handles EPERM at lines 335-364:
//   1. Increments transientFailureCounts
//   2. If count < TRANSIENT_FAILURE_LIMIT(5): re-queue and RETURN
//   3. If count >= TRANSIENT_FAILURE_LIMIT: delete count, log "burning retry",
//      fall through to the isTransientGitError block
//
// However, isTransientGitError (git.ts lines 97-101) ALSO returns true for EPERM:
//   if (err.message.includes("EPERM") || code === "EPERM") return true;
//
// After the EPERM block deletes transientFailureCounts and falls through,
// the isTransientGitError block runs with a fresh count (0+1=1 < LIMIT=5),
// re-queuing the task AGAIN instead of calling handleRetry.
//
// Result: after TRANSIENT_FAILURE_LIMIT EPERM failures, the scheduler intends
// to "burn a retry" but the task is silently re-queued with retryCount still 0.
// The task can loop this way up to TRANSIENT_FAILURE_LIMIT^2 = 25 times
// before eventually burning a retry (if the second isTransientGitError counter
// also reaches LIMIT).
// ---------------------------------------------------------------------------

describe("BUG 1: EPERM double-counted by isTransientGitError after limit", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(isDllInitError).mockReturnValue(false);
  });

  test("after TRANSIENT_FAILURE_LIMIT EPERM failures, task should burn a retry (not re-queue again)", async () => {
    const taskId = seedTask(db, { orcaStatus: "ready", retryCount: 0 });

    const epermError = Object.assign(
      new Error("EPERM: operation not permitted, rmdir"),
      { code: "EPERM" },
    );

    // Mock isTransientGitError to behave like the real implementation:
    // EPERM errors match the EPERM check in git.ts lines 97-101.
    vi.mocked(isTransientGitError).mockImplementation((err: unknown) => {
      if (!(err instanceof Error)) return false;
      const code = (err as NodeJS.ErrnoException).code;
      return code === "EPERM" || err.message.includes("EPERM");
    });

    // createWorktree throws synchronously (as it does in production — it's not async)
    vi.mocked(createWorktree).mockImplementation(() => {
      throw epermError;
    });

    const deps = makeDeps(db);

    // Run TRANSIENT_FAILURE_LIMIT (5) ticks — ticks 1-4 re-queue (count < 5)
    // Tick 5: count reaches 5 >= LIMIT, EPERM block deletes count, falls through
    //         isTransientGitError fires, reads count=1, re-queues AGAIN (BUG)
    await runNTicks(db, deps, taskId, 5);

    // After 5 ticks: ticks 1-4 increment count to 4, tick 5 should burn retry.
    // BUG: tick 5 re-queues instead (isTransientGitError re-increments from 0).
    const taskAfter5 = getTask(db, taskId);
    const invsAfter5 = getInvocationsByTask(db, taskId);

    // After 5 ticks: if bug exists, task is still 'ready' with retryCount=0
    // After 5 ticks: if bug fixed, task should have retryCount > 0 or be in 'failed'

    // Run one more tick (tick 6) — if the bug exists, tick 6 finds the task still
    // re-queued as 'ready' with transientFailureCounts[taskId]=1 (not at limit)
    const prevCount6 = getInvocationsByTask(db, taskId).length;
    const handle6 = startScheduler(deps);
    await waitFor(() => getInvocationsByTask(db, taskId).length > prevCount6);
    handle6.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const taskAfter6 = getTask(db, taskId);

    // After the fix: at tick 5 the EPERM limit is hit, handleRetry is called
    // directly (without falling through to isTransientGitError), retryCount is
    // incremented, and the task is re-queued for the next retry cycle.
    expect(taskAfter6?.retryCount).toBeGreaterThan(0); // retry was burned
  });
});

// ---------------------------------------------------------------------------
// BUG 2: isEpermError crashes on non-Error thrown values
//
// isEpermError at src/scheduler/index.ts:159-161:
//   function isEpermError(err: unknown): boolean {
//     return (err as NodeJS.ErrnoException).code === "EPERM";
//   }
//
// When `err` is null, accessing `.code` throws:
//   TypeError: Cannot read properties of null (reading 'code')
//
// Compare with isTransientGitError (src/git.ts:65):
//   if (!(err instanceof Error)) return false;  // safe guard
//
// If createWorktree throws null (not a real Error) — which can happen if
// a dependency internally does `throw null` or `Promise.reject(null)` —
// the catch block will crash at `isEpermError(null)`, the exception bubbles
// through the catch block, and `guardedTick` logs "tick error" instead of
// properly updating the task/invocation state. The invocation record is left
// with status 'running' and the task stays in 'dispatched'.
// ---------------------------------------------------------------------------

describe("BUG 2: isEpermError crashes on null input", () => {
  test("isEpermError(null) throws TypeError instead of returning false", () => {
    // Direct simulation of what isEpermError does (it's not exported):
    //   return (err as NodeJS.ErrnoException).code === "EPERM";
    // When err is null, (null as NodeJS.ErrnoException).code throws.

    let threwTypeError = false;
    try {
      void (null as unknown as NodeJS.ErrnoException).code;
    } catch (e) {
      if (e instanceof TypeError) threwTypeError = true;
    }

    // BUG: This is true — accessing .code on null throws TypeError.
    // The fix is to guard with: if (!(err instanceof Error)) return false;
    expect(threwTypeError).toBe(true);
  });

  test("scheduler leaves invocation in running state when createWorktree throws null", async () => {
    const db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(isDllInitError).mockReturnValue(false);
    vi.mocked(isTransientGitError).mockReturnValue(false);

    const taskId = seedTask(db, { orcaStatus: "ready", retryCount: 0 });

    // createWorktree throws null — triggers isEpermError(null) crash
    vi.mocked(createWorktree).mockImplementation(() => {
      throw null;
    });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    // Wait for tick to complete (or crash)
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    handle.stop();

    const invs = getInvocationsByTask(db, taskId);
    if (invs.length > 0) {
      // BUG: When isEpermError(null) throws, the catch block's remaining code
      // (updateTaskStatus, updateInvocation) never runs. The invocation is left
      // as 'running' and the task stays in 'dispatched' state.
      const lastInv = invs[invs.length - 1]!;
      // After the fix: isEpermError(null) returns false (guarded), and the null
      // error falls through to the non-transient path which marks the invocation failed.
      expect(lastInv.status).toBe("failed");
    }
  });
});

// ---------------------------------------------------------------------------
// BUG 3: Orphaned directory cleanup uses bare rmSync (no EPERM retry)
//
// src/cleanup/index.ts lines ~280-285 (orphaned directory section):
//   killProcessesInDirectory(fullPath);
//   rmSync(fullPath, { recursive: true, force: true });  // <-- bare rmSync
//
// The EMI-230 fix added killProcessesInDirectory before rmSync in the orphan
// cleanup section. But rmSyncWithRetry (defined in worktree/index.ts, retries
// 3 times with 2s pauses on EPERM) was NOT used here.
//
// This is inconsistent with the createWorktree stale-dir path which correctly
// calls killProcessesInDirectory + rmSyncWithRetry. After killProcessesInDirectory
// kills a process, there can be a brief OS delay before file handles are released.
// Without rmSyncWithRetry, the cleanup will still fail on EPERM immediately.
// ---------------------------------------------------------------------------

describe("BUG 3: Cleanup uses bare rmSync without retry for orphaned directories", () => {
  test("src/cleanup/index.ts calls bare rmSync (not rmSyncWithRetry) for orphaned directories", async () => {
    // Read the actual source file (bypassing the node:fs mock)
    const { readFileSync: realReadFileSync } = await vi.importActual<
      typeof import("node:fs")
    >("node:fs");

    // On Windows, fileURLToPath produces a path like C:\Users\...\src\cleanup\index.ts
    const url = new URL("../src/cleanup/index.ts", import.meta.url);
    // Strip leading slash from Windows paths
    const filePath = url.pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const source = realReadFileSync(filePath, "utf8");

    // Find the orphaned directory section
    const orphanSectionStart = source.indexOf(
      "Also clean up unregistered directories",
    );
    expect(orphanSectionStart).toBeGreaterThan(0);
    const orphanSection = source.slice(orphanSectionStart, orphanSectionStart + 2000);

    // Verify that killProcessesInDirectory IS called (the partial fix is there)
    expect(orphanSection).toContain("killProcessesInDirectory");

    // BUG: rmSyncWithRetry should be used but bare rmSync is used instead.
    // This assertion FAILS because the code uses bare rmSync:
    expect(orphanSection).toContain("rmSyncWithRetry");
    // ^ If the bug is fixed this should pass.
    // Currently fails because orphanSection contains:
    //   rmSync(fullPath, { recursive: true, force: true })
    // instead of:
    //   rmSyncWithRetry(fullPath)
  });
});

// ---------------------------------------------------------------------------
// Regression tests: EPERM happy path correctly re-queues without burning retry
// (These SHOULD pass — they test correct behavior for ticks < LIMIT)
// ---------------------------------------------------------------------------

describe("EPERM re-queue happy path (should pass)", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
    vi.mocked(isDraining).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(isDllInitError).mockReturnValue(false);
    // isTransientGitError returns false here so only EPERM block fires
    vi.mocked(isTransientGitError).mockReturnValue(false);
  });

  test("first EPERM failure re-queues task as ready without burning retryCount", async () => {
    const taskId = seedTask(db, { orcaStatus: "ready", retryCount: 0 });

    const epermError = Object.assign(
      new Error("EPERM: operation not permitted, rmdir"),
      { code: "EPERM" },
    );
    vi.mocked(createWorktree).mockImplementation(() => {
      throw epermError;
    });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => getInvocationsByTask(db, taskId).length >= 1);
    handle.stop();

    const task = getTask(db, taskId);
    expect(task?.orcaStatus).toBe("ready");
    expect(task?.retryCount).toBe(0);
  });

  test("EPERM on in_review task: status restored to in_review, not ready", async () => {
    const taskId = seedTask(db, {
      orcaStatus: "in_review",
      retryCount: 0,
      prBranchName: "orca/test-eperm/1",
    });

    const epermError = Object.assign(
      new Error("EPERM: operation not permitted, rmdir"),
      { code: "EPERM" },
    );
    vi.mocked(createWorktree).mockImplementation(() => {
      throw epermError;
    });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => getInvocationsByTask(db, taskId).length >= 1);
    handle.stop();

    const task = getTask(db, taskId);
    expect(task?.orcaStatus).toBe("in_review");
    expect(task?.retryCount).toBe(0);
  });

  test("EPERM on changes_requested task: status restored to changes_requested", async () => {
    const taskId = seedTask(db, {
      orcaStatus: "changes_requested",
      retryCount: 0,
      prBranchName: "orca/test-eperm/1",
    });

    const epermError = Object.assign(
      new Error("EPERM: operation not permitted, rmdir"),
      { code: "EPERM" },
    );
    vi.mocked(createWorktree).mockImplementation(() => {
      throw epermError;
    });

    const deps = makeDeps(db);
    const handle = startScheduler(deps);

    await waitFor(() => getInvocationsByTask(db, taskId).length >= 1);
    handle.stop();

    const task = getTask(db, taskId);
    expect(task?.orcaStatus).toBe("changes_requested");
    expect(task?.retryCount).toBe(0);
  });
});
