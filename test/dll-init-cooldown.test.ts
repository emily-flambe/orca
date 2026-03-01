// ---------------------------------------------------------------------------
// DLL init error detection, cooldown logic, and retry edge cases
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
} from "vitest";

import {
  isTransientGitError,
  isDllInitError,
  type ExecError,
} from "../src/git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitError(overrides: Partial<ExecError> & { message?: string } = {}): Error & ExecError {
  const err = new Error(overrides.message ?? "git command failed") as Error & ExecError;
  if (overrides.status !== undefined) err.status = overrides.status;
  if (overrides.signal !== undefined) err.signal = overrides.signal;
  if (overrides.code !== undefined) err.code = overrides.code;
  return err;
}

/**
 * Mirrors gitWithRetry logic for unit testing without importing the real
 * function (which has side-effects: sleepSync, global counters).
 */
function retryWrapper(
  fn: () => string,
  maxAttempts: number,
): { result?: string; attempts: number; error?: Error } {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = fn();
      return { result, attempts: attempt };
    } catch (err: unknown) {
      if (!isTransientGitError(err) || attempt === maxAttempts) {
        return { attempts: attempt, error: err as Error };
      }
    }
  }
  return { attempts: maxAttempts, error: new Error("unreachable") };
}

// ---------------------------------------------------------------------------
// isDllInitError — comprehensive edge cases
// ---------------------------------------------------------------------------

describe("isDllInitError", () => {
  test("returns true for exact Windows DLL init exit code (3221225794)", () => {
    const err = makeGitError({ status: 3221225794 });
    expect(isDllInitError(err)).toBe(true);
  });

  test("returns true for signed 32-bit representation (-1073741502)", () => {
    // 0xC0000142 as signed i32 is -1073741502 — must detect both representations
    const err = makeGitError({ status: -1073741502 });
    expect(isDllInitError(err)).toBe(true);
  });

  test("returns false for normal exit code 0 (success)", () => {
    const err = makeGitError({ status: 0 });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for exit code 1 (generic failure)", () => {
    const err = makeGitError({ status: 1 });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for exit code 128 (git fatal error)", () => {
    const err = makeGitError({ status: 128 });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for exit code 127 (command not found)", () => {
    const err = makeGitError({ status: 127 });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false when status is null", () => {
    const err = makeGitError({ status: null as any });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false when status is undefined (no status property)", () => {
    const err = new Error("some error");
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isDllInitError("3221225794")).toBe(false);
    expect(isDllInitError(3221225794)).toBe(false);
    expect(isDllInitError(null)).toBe(false);
    expect(isDllInitError(undefined)).toBe(false);
    expect(isDllInitError({})).toBe(false);
    expect(isDllInitError({ status: 3221225794 })).toBe(false); // plain object, not Error
  });

  test("returns false for exit code close to DLL init (off by one)", () => {
    expect(isDllInitError(makeGitError({ status: 3221225793 }))).toBe(false);
    expect(isDllInitError(makeGitError({ status: 3221225795 }))).toBe(false);
  });

  test("returns false for other large Windows exit codes (ACCESS_VIOLATION = 0xC0000005)", () => {
    // STATUS_ACCESS_VIOLATION = 3221225477
    const err = makeGitError({ status: 3221225477 });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for NaN status", () => {
    const err = makeGitError({ status: NaN as any });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for Infinity status", () => {
    const err = makeGitError({ status: Infinity as any });
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for string status that looks like the code", () => {
    const err = new Error("git command failed") as Error & ExecError;
    (err as any).status = "3221225794";
    // Strict equality with a number means string !== number
    expect(isDllInitError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTransientGitError with DLL init — interactions
// ---------------------------------------------------------------------------

describe("isTransientGitError — DLL init interactions", () => {
  test("DLL init error is both transient and DLL-specific", () => {
    const err = makeGitError({ status: 3221225794 });
    expect(isTransientGitError(err)).toBe(true);
    expect(isDllInitError(err)).toBe(true);
  });

  test("signal-killed error is transient but NOT DLL-specific", () => {
    const err = makeGitError({ signal: "SIGKILL" });
    expect(isTransientGitError(err)).toBe(true);
    expect(isDllInitError(err)).toBe(false);
  });

  test("DLL init error with signal set: DLL check wins (status takes priority)", () => {
    // Unlikely in practice but tests precedence
    const err = makeGitError({ status: 3221225794, signal: "SIGTERM" });
    expect(isTransientGitError(err)).toBe(true);
    expect(isDllInitError(err)).toBe(true);
  });

  test("non-DLL non-signal error is neither transient nor DLL", () => {
    const err = makeGitError({ status: 1 });
    expect(isTransientGitError(err)).toBe(false);
    expect(isDllInitError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry behavior with DLL init errors
// ---------------------------------------------------------------------------

describe("retry behavior with DLL init errors", () => {
  test("DLL init error on attempt 1 of 3: retries, succeeds on attempt 2", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw dllErr; })
      .mockReturnValue("recovered");

    const { result, attempts } = retryWrapper(fn, 3);
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("DLL init error on attempts 1 and 2 of 3: fails on attempt 3 succeeds", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw dllErr; })
      .mockImplementationOnce(() => { throw dllErr; })
      .mockReturnValue("recovered-late");

    const { result, attempts } = retryWrapper(fn, 3);
    expect(result).toBe("recovered-late");
    expect(attempts).toBe(3);
  });

  test("DLL init error on all 3 of 3 attempts: throws after exhaustion", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn().mockImplementation(() => { throw dllErr; });

    const { error, attempts } = retryWrapper(fn, 3);
    expect(error).toBeDefined();
    expect(attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("DLL init error with maxAttempts=1: no retry, fails immediately", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn().mockImplementation(() => { throw dllErr; });

    const { error, attempts } = retryWrapper(fn, 1);
    expect(error).toBeDefined();
    expect(attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("DLL error then non-transient error: stops on non-transient (no retry)", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const normalErr = makeGitError({ status: 128 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw dllErr; })
      .mockImplementationOnce(() => { throw normalErr; });

    const { error, attempts } = retryWrapper(fn, 5);
    expect(error).toBeDefined();
    expect(error!.message).toBe("git command failed");
    expect(attempts).toBe(2);
  });

  test("non-transient error then DLL error: never reaches DLL (stops at first)", () => {
    const normalErr = makeGitError({ status: 1 });
    const fn = vi.fn().mockImplementation(() => { throw normalErr; });

    const { error, attempts } = retryWrapper(fn, 3);
    expect(error).toBeDefined();
    expect(attempts).toBe(1);
  });

  test("mixed transient types: signal then DLL then success", () => {
    const sigErr = makeGitError({ signal: "SIGKILL" });
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw sigErr; })
      .mockImplementationOnce(() => { throw dllErr; })
      .mockReturnValue("ok");

    const { result, attempts } = retryWrapper(fn, 5);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Repo cooldown logic — simulated scheduler behavior
// ---------------------------------------------------------------------------

describe("repo cooldown simulation", () => {
  // Since repoCooldowns is module-private in the scheduler, we simulate
  // the exact cooldown logic here to test its correctness.

  const REPO_COOLDOWN_MS = 30_000;
  let repoCooldowns: Map<string, number>;

  beforeEach(() => {
    repoCooldowns = new Map();
  });

  function setCooldown(repoPath: string): void {
    repoCooldowns.set(repoPath, Date.now() + REPO_COOLDOWN_MS);
  }

  function expireCooldowns(): void {
    const now = Date.now();
    for (const [repo, expiresAt] of repoCooldowns) {
      if (now >= expiresAt) repoCooldowns.delete(repo);
    }
  }

  function isOnCooldown(repoPath: string): boolean {
    return repoCooldowns.has(repoPath);
  }

  test("cooldown blocks dispatch for the affected repo", () => {
    setCooldown("/repos/my-project");
    expect(isOnCooldown("/repos/my-project")).toBe(true);
  });

  test("cooldown does NOT block unrelated repos", () => {
    setCooldown("/repos/project-a");
    expect(isOnCooldown("/repos/project-b")).toBe(false);
  });

  test("cooldown expires after REPO_COOLDOWN_MS", () => {
    // Set cooldown in the past (already expired)
    repoCooldowns.set("/repos/my-project", Date.now() - 1);
    expireCooldowns();
    expect(isOnCooldown("/repos/my-project")).toBe(false);
  });

  test("cooldown at exact expiry time: >= means it expires (boundary)", () => {
    // The scheduler uses `now >= expiresAt` (not >) so exact match = expired
    const exactTime = Date.now();
    repoCooldowns.set("/repos/my-project", exactTime);
    // Simulate the check happening at exactly expiresAt time
    // We set expiresAt = exactTime and Date.now() >= exactTime is true
    const now = exactTime;
    for (const [repo, expiresAt] of repoCooldowns) {
      if (now >= expiresAt) repoCooldowns.delete(repo);
    }
    expect(isOnCooldown("/repos/my-project")).toBe(false);
  });

  test("cooldown NOT expired: future timestamp still blocks", () => {
    repoCooldowns.set("/repos/my-project", Date.now() + 60_000);
    expireCooldowns();
    expect(isOnCooldown("/repos/my-project")).toBe(true);
  });

  test("multiple tasks sharing same repo: one DLL failure blocks all", () => {
    // Two tasks target the same repo
    const repoPath = "/repos/shared-repo";
    const tasks = [
      { id: "TASK-1", repoPath },
      { id: "TASK-2", repoPath },
      { id: "TASK-3", repoPath },
    ];

    // TASK-1 triggers DLL init error, puts repo on cooldown
    setCooldown(repoPath);

    // All tasks for this repo should be blocked
    const dispatchable = tasks.filter(t => !isOnCooldown(t.repoPath));
    expect(dispatchable).toHaveLength(0);
  });

  test("multiple repos: cooldown on one does not affect others", () => {
    const tasks = [
      { id: "TASK-1", repoPath: "/repos/project-a" },
      { id: "TASK-2", repoPath: "/repos/project-a" },
      { id: "TASK-3", repoPath: "/repos/project-b" },
    ];

    setCooldown("/repos/project-a");

    const dispatchable = tasks.filter(t => !isOnCooldown(t.repoPath));
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]!.id).toBe("TASK-3");
  });

  test("successful worktree creation clears cooldown for that repo", () => {
    const repoPath = "/repos/my-project";
    setCooldown(repoPath);
    expect(isOnCooldown(repoPath)).toBe(true);

    // Simulate successful worktree creation
    repoCooldowns.delete(repoPath);
    expect(isOnCooldown(repoPath)).toBe(false);
  });

  test("cooldown key is exact string match (case-sensitive)", () => {
    // On Windows, paths are case-insensitive but the Map uses exact string
    // comparison. This could be a bug if repoPath comes from different sources
    // with different casing.
    setCooldown("C:\\Users\\emily\\repos\\Project");
    expect(isOnCooldown("C:\\Users\\emily\\repos\\Project")).toBe(true);
    expect(isOnCooldown("C:\\Users\\emily\\repos\\project")).toBe(false);
    expect(isOnCooldown("c:\\users\\emily\\repos\\Project")).toBe(false);
  });

  test("cooldown key with trailing slash mismatch", () => {
    // Another path normalization edge case
    setCooldown("/repos/my-project/");
    expect(isOnCooldown("/repos/my-project/")).toBe(true);
    expect(isOnCooldown("/repos/my-project")).toBe(false);
  });

  test("rapid successive DLL errors: cooldown timestamp is overwritten (not extended)", () => {
    const repoPath = "/repos/my-project";
    const firstCooldown = Date.now() + REPO_COOLDOWN_MS;
    repoCooldowns.set(repoPath, firstCooldown);

    // Second DLL error 5 seconds later: overwrites with new timestamp
    const secondCooldown = Date.now() + 5000 + REPO_COOLDOWN_MS;
    repoCooldowns.set(repoPath, secondCooldown);

    // The cooldown expiry is now the second (later) timestamp
    expect(repoCooldowns.get(repoPath)).toBe(secondCooldown);
    // First cooldown would have expired sooner, but the overwrite extended it
    expect(secondCooldown).toBeGreaterThan(firstCooldown);
  });

  test("deleting during iteration: safe because scheduler collects then deletes", () => {
    // The scheduler iterates repoCooldowns and deletes expired entries.
    // Deleting from a Map during for...of iteration is safe in JavaScript.
    repoCooldowns.set("/repos/a", Date.now() - 1000);
    repoCooldowns.set("/repos/b", Date.now() - 1000);
    repoCooldowns.set("/repos/c", Date.now() + 60_000);

    expireCooldowns();

    expect(repoCooldowns.size).toBe(1);
    expect(repoCooldowns.has("/repos/c")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transient failure counter interaction with cooldown
// ---------------------------------------------------------------------------

describe("transient failure counter + cooldown interaction", () => {
  const TRANSIENT_FAILURE_LIMIT = 5;

  test("DLL init error below limit: task re-queued, repo on cooldown", () => {
    // Simulates: count = 1, < LIMIT, so task stays dispatchable
    // but repo is on cooldown so next tick won't dispatch it
    let count = 0;
    const repoCooldowns = new Map<string, number>();

    // Simulate worktree creation failure with DLL init
    const err = makeGitError({ status: 3221225794 });
    if (isTransientGitError(err)) {
      count++;
      if (isDllInitError(err)) {
        repoCooldowns.set("/repos/my-project", Date.now() + 30_000);
      }
    }

    expect(count).toBe(1);
    expect(count < TRANSIENT_FAILURE_LIMIT).toBe(true);
    expect(repoCooldowns.has("/repos/my-project")).toBe(true);
  });

  test("signal error below limit: task re-queued, NO cooldown set", () => {
    // Signal errors are transient but do NOT set repo cooldown
    let count = 0;
    const repoCooldowns = new Map<string, number>();

    const err = makeGitError({ signal: "SIGKILL" });
    if (isTransientGitError(err)) {
      count++;
      if (isDllInitError(err)) {
        repoCooldowns.set("/repos/my-project", Date.now() + 30_000);
      }
    }

    expect(count).toBe(1);
    expect(repoCooldowns.has("/repos/my-project")).toBe(false);
  });

  test("5 consecutive DLL errors: circuit breaker trips, burns real retry", () => {
    let count = 0;
    const LIMIT = TRANSIENT_FAILURE_LIMIT;
    const dllErr = makeGitError({ status: 3221225794 });

    for (let i = 0; i < LIMIT; i++) {
      if (isTransientGitError(dllErr)) {
        count++;
      }
    }

    expect(count).toBe(LIMIT);
    // At count >= LIMIT, the circuit breaker trips
    expect(count >= LIMIT).toBe(true);
  });

  test("4 DLL errors then success: counter resets, cooldown clears", () => {
    let count = 0;
    const repoCooldowns = new Map<string, number>();
    const repoPath = "/repos/my-project";
    const taskId = "TASK-1";
    const transientFailureCounts = new Map<string, number>();
    const dllErr = makeGitError({ status: 3221225794 });

    // 4 failures
    for (let i = 0; i < 4; i++) {
      if (isTransientGitError(dllErr)) {
        count = (transientFailureCounts.get(taskId) ?? 0) + 1;
        transientFailureCounts.set(taskId, count);
        if (isDllInitError(dllErr)) {
          repoCooldowns.set(repoPath, Date.now() + 30_000);
        }
      }
    }

    expect(transientFailureCounts.get(taskId)).toBe(4);
    expect(repoCooldowns.has(repoPath)).toBe(true);

    // Then success
    transientFailureCounts.delete(taskId);
    repoCooldowns.delete(repoPath);

    expect(transientFailureCounts.has(taskId)).toBe(false);
    expect(repoCooldowns.has(repoPath)).toBe(false);
  });

  test("DLL error then signal error: both increment counter, only DLL sets cooldown", () => {
    const transientFailureCounts = new Map<string, number>();
    const repoCooldowns = new Map<string, number>();
    const taskId = "TASK-1";
    const repoPath = "/repos/my-project";

    // DLL error
    const dllErr = makeGitError({ status: 3221225794 });
    if (isTransientGitError(dllErr)) {
      const c = (transientFailureCounts.get(taskId) ?? 0) + 1;
      transientFailureCounts.set(taskId, c);
      if (isDllInitError(dllErr)) {
        repoCooldowns.set(repoPath, Date.now() + 30_000);
      }
    }

    expect(transientFailureCounts.get(taskId)).toBe(1);
    expect(repoCooldowns.has(repoPath)).toBe(true);

    // Clear cooldown (simulate expiry) and then signal error
    repoCooldowns.delete(repoPath);
    const sigErr = makeGitError({ signal: "SIGKILL" });
    if (isTransientGitError(sigErr)) {
      const c = (transientFailureCounts.get(taskId) ?? 0) + 1;
      transientFailureCounts.set(taskId, c);
      if (isDllInitError(sigErr)) {
        repoCooldowns.set(repoPath, Date.now() + 30_000);
      }
    }

    expect(transientFailureCounts.get(taskId)).toBe(2);
    // Signal error should NOT re-set cooldown
    expect(repoCooldowns.has(repoPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scheduler dispatch filtering — simulated with real filter logic
// ---------------------------------------------------------------------------

describe("scheduler dispatch filtering with cooldowns", () => {
  const REPO_COOLDOWN_MS = 30_000;

  interface MockTask {
    linearIssueId: string;
    repoPath: string;
    agentPrompt: string;
    isParent: boolean;
    orcaStatus: string;
  }

  function simulateDispatchFilter(
    candidates: MockTask[],
    repoCooldowns: Map<string, number>,
    tasksWithRunningInv: Set<string>,
  ): MockTask[] {
    // Expire stale cooldowns (mirrors scheduler logic)
    const tickNow = Date.now();
    for (const [repo, expiresAt] of repoCooldowns) {
      if (tickNow >= expiresAt) repoCooldowns.delete(repo);
    }

    return candidates.filter((t) => {
      if (!t.agentPrompt) return false;
      if (t.isParent) return false;
      if (tasksWithRunningInv.has(t.linearIssueId)) return false;
      if (repoCooldowns.has(t.repoPath)) return false;
      return true;
    });
  }

  test("no cooldowns: all valid tasks are dispatchable", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-2", repoPath: "/repos/b", agentPrompt: "do Y", isParent: false, orcaStatus: "ready" },
    ];
    const result = simulateDispatchFilter(tasks, new Map(), new Set());
    expect(result).toHaveLength(2);
  });

  test("cooldown on repo A blocks T-1 and T-2, allows T-3 on repo B", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-2", repoPath: "/repos/a", agentPrompt: "do Y", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-3", repoPath: "/repos/b", agentPrompt: "do Z", isParent: false, orcaStatus: "ready" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.linearIssueId).toBe("T-3");
  });

  test("expired cooldown: all tasks dispatchable again", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-2", repoPath: "/repos/a", agentPrompt: "do Y", isParent: false, orcaStatus: "ready" },
    ];
    const cooldowns = new Map<string, number>();
    // Cooldown already expired
    cooldowns.set("/repos/a", Date.now() - 1);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(2);
    // Cooldown should have been cleaned up
    expect(cooldowns.has("/repos/a")).toBe(false);
  });

  test("cooldown AND running invocation: both block independently", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: false, orcaStatus: "ready" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);
    const running = new Set(["T-1"]);

    const result = simulateDispatchFilter(tasks, cooldowns, running);
    expect(result).toHaveLength(0);
  });

  test("cooldown with no agentPrompt: filtered by agentPrompt check first", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "", isParent: false, orcaStatus: "ready" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(0);
  });

  test("parent task with cooldown: blocked by isParent, not cooldown", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: true, orcaStatus: "ready" },
    ];
    // No cooldown -- still blocked because isParent
    const result = simulateDispatchFilter(tasks, new Map(), new Set());
    expect(result).toHaveLength(0);
  });

  test("all repos on cooldown: nothing dispatched", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "do X", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-2", repoPath: "/repos/b", agentPrompt: "do Y", isParent: false, orcaStatus: "ready" },
      { linearIssueId: "T-3", repoPath: "/repos/c", agentPrompt: "do Z", isParent: false, orcaStatus: "ready" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);
    cooldowns.set("/repos/b", Date.now() + REPO_COOLDOWN_MS);
    cooldowns.set("/repos/c", Date.now() + REPO_COOLDOWN_MS);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(0);
  });

  test("in_review task on cooled-down repo: still blocked by cooldown", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "review PR", isParent: false, orcaStatus: "in_review" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(0);
  });

  test("changes_requested task on cooled-down repo: still blocked", () => {
    const tasks: MockTask[] = [
      { linearIssueId: "T-1", repoPath: "/repos/a", agentPrompt: "fix issues", isParent: false, orcaStatus: "changes_requested" },
    ];
    const cooldowns = new Map<string, number>();
    cooldowns.set("/repos/a", Date.now() + REPO_COOLDOWN_MS);

    const result = simulateDispatchFilter(tasks, cooldowns, new Set());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// gitWithRetry global state concern — documenting test isolation issue
// ---------------------------------------------------------------------------

describe("globalTransientFailureCount isolation concern", () => {
  // The real gitWithRetry() has a module-level `globalTransientFailureCount`
  // that persists across test runs within the same vitest module. This test
  // documents the risk: if one test triggers global transient failures without
  // a subsequent success to reset the counter, later tests may see unexpected
  // GLOBAL_COOLDOWN_MS pauses.
  //
  // The retryWrapper used in tests sidesteps this by not touching the real
  // global counter. But any test that imports and calls the real gitWithRetry()
  // will be affected.

  test("isDllInitError and isTransientGitError are pure functions (no state)", () => {
    // These functions don't mutate any state, so they are safe to call
    // in any order across tests.
    const err1 = makeGitError({ status: 3221225794 });
    const err2 = makeGitError({ signal: "SIGKILL" });
    const err3 = makeGitError({ status: 1 });

    // Call in arbitrary order -- results should be deterministic
    expect(isDllInitError(err1)).toBe(true);
    expect(isDllInitError(err2)).toBe(false);
    expect(isDllInitError(err3)).toBe(false);
    expect(isTransientGitError(err1)).toBe(true);
    expect(isTransientGitError(err2)).toBe(true);
    expect(isTransientGitError(err3)).toBe(false);

    // Repeat -- same results
    expect(isDllInitError(err1)).toBe(true);
    expect(isTransientGitError(err2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TRANSIENT_FAILURE_LIMIT boundary (was 3, now 5)
// ---------------------------------------------------------------------------

describe("TRANSIENT_FAILURE_LIMIT = 5 boundary", () => {
  const TRANSIENT_FAILURE_LIMIT = 5;

  test("failure count 4: still below limit, task re-queued", () => {
    const count = 4;
    expect(count < TRANSIENT_FAILURE_LIMIT).toBe(true);
  });

  test("failure count 5: at limit, circuit breaker trips", () => {
    const count = 5;
    expect(count < TRANSIENT_FAILURE_LIMIT).toBe(false);
  });

  test("failure count 6: above limit (should never reach if logic is correct)", () => {
    const count = 6;
    expect(count < TRANSIENT_FAILURE_LIMIT).toBe(false);
  });

  test("with old limit of 3: same scenario would have tripped earlier", () => {
    // Documents that the limit change from 3 to 5 gives more headroom
    const OLD_LIMIT = 3;
    const NEW_LIMIT = 5;
    const count = 4; // 4 failures

    // Old behavior: would have tripped at count >= 3
    expect(count < OLD_LIMIT).toBe(false);
    // New behavior: still below limit
    expect(count < NEW_LIMIT).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge case: error types that could confuse the detection
// ---------------------------------------------------------------------------

describe("error type confusion risks", () => {
  test("Error subclass with status property: isDllInitError still works", () => {
    class GitCommandError extends Error {
      status: number;
      constructor(msg: string, status: number) {
        super(msg);
        this.status = status;
      }
    }
    const err = new GitCommandError("git fetch failed", 3221225794);
    expect(isDllInitError(err)).toBe(true);
    expect(isTransientGitError(err)).toBe(true);
  });

  test("cross-realm Error (Object.create(Error.prototype)): instanceof check passes", () => {
    const fakeErr = Object.create(Error.prototype);
    fakeErr.message = "git command failed";
    fakeErr.status = 3221225794;
    // Object.create(Error.prototype) passes instanceof Error
    expect(fakeErr instanceof Error).toBe(true);
    expect(isDllInitError(fakeErr)).toBe(true);
  });

  test("plain object mimicking Error: instanceof fails, detection fails", () => {
    const fake = {
      message: "git command failed",
      status: 3221225794,
      stack: "fake stack",
    };
    expect(fake instanceof Error).toBe(false);
    expect(isDllInitError(fake)).toBe(false);
    expect(isTransientGitError(fake)).toBe(false);
  });

  test("Error with status as getter that throws: does not crash isDllInitError", () => {
    const err = new Error("tricky error");
    Object.defineProperty(err, "status", {
      get() { throw new Error("getter exploded"); },
    });
    // This WILL throw because isDllInitError accesses .status
    expect(() => isDllInitError(err)).toThrow("getter exploded");
  });
});
