// ---------------------------------------------------------------------------
// Adversarial tests for WorktreePoolService
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  gitAsync: vi.fn().mockResolvedValue(""),
  cleanStaleLockFiles: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn().mockResolvedValue(undefined),
}));

let existingPaths: Set<string> = new Set();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => existingPaths.has(String(p))),
    readdirSync: vi.fn().mockReturnValue([]),
    copyFileSync: vi.fn(),
  };
});

// execFile mock: default is success (no npm install failures)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      if (typeof cb === "function") (cb as (...a: unknown[]) => void)(null, "", "");
      return {} as ReturnType<typeof actual.execFile>;
    }),
  };
});

import { join, dirname, basename } from "node:path";
import { WorktreePoolService } from "../src/worktree/pool.js";
import { gitAsync } from "../src/git.js";
import { removeWorktreeAsync } from "../src/worktree/index.js";
import { execFile } from "node:child_process";

const mockGitAsync = vi.mocked(gitAsync);
const mockRemoveWorktreeAsync = vi.mocked(removeWorktreeAsync);
const mockExecFile = vi.mocked(execFile);

async function flushAsync(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const REPO_PATH = "/repos/myapp";

beforeEach(() => {
  vi.clearAllMocks();
  mockGitAsync.mockResolvedValue("");
  mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  // Restore default execFile success behavior after each test
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      if (typeof cb === "function") (cb as (...a: unknown[]) => void)(null, "", "");
      return {} as ReturnType<typeof execFile>;
    }
  );
  existingPaths = new Set();
});

// ---------------------------------------------------------------------------
// BUG 1: Race condition — two concurrent claims on same repo
//
// `claim()` calls `reserves.shift()` synchronously to pop a reserve, then
// does async git ops. If two claims fire before either git op completes,
// both will successfully shift() from the array — one gets a real reserve
// (index 0), the other gets undefined... wait, actually shift() is called
// immediately and removes the item. The REAL race is: if two claims fire
// between `reserves.length > 0` check and `reserves.shift()`. Since JS is
// single-threaded, shift() completes before the next microtask. So the
// first `shift()` gets the reserve, and the second call hits
// `reserves.length === 0` and returns null.
//
// Verdict: NO race condition exists due to JS single-threaded nature.
// `shift()` is atomic within the microtask queue.
// ---------------------------------------------------------------------------
describe("claim concurrency (single-threaded JS)", () => {
  test("sequential concurrent claims: first gets reserve, second returns null", async () => {
    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    expect(pool.getReservePaths().size).toBe(1);

    // Fire both claims — in JS, the second claim() won't execute until
    // the first claim()'s synchronous portion (including shift()) completes
    const [result1, result2] = await Promise.all([
      pool.claim(REPO_PATH, "TASK-1", 0),
      pool.claim(REPO_PATH, "TASK-2", 0),
    ]);

    // Exactly one should succeed
    const successes = [result1, result2].filter((r) => r !== null);
    const nulls = [result1, result2].filter((r) => r === null);
    expect(successes.length).toBe(1);
    expect(nulls.length).toBe(1);

    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 2: fillRepo filling lock silently drops replenishment when a fill
// is already in progress. This means if claim() fires a replenishment while
// an original fill is still running, the replenishment call returns immediately
// as a no-op. If the original fill was started with `needed=N` based on the
// pre-claim pool size, after the fill completes and the claimed reserve is
// removed, the pool may be 1 short of its target until the NEXT fill cycle.
//
// This is documented behavior (comment says "Only one fill per repo at a time")
// but it means the pool can temporarily underserve after a claim during fill.
// ---------------------------------------------------------------------------
describe("filling lock: behavior when fillRepo called concurrently", () => {
  test("second startFilling call for same repo is a no-op while fill in progress", async () => {
    // The filling set prevents concurrent fills per repo.
    // If startFilling is called twice rapidly, the second call fires fillRepo
    // which returns immediately because `this.filling.has(repoPath)`.
    // This is correct behavior — but the pool still ends up at the right size.
    const pool = new WorktreePoolService(2);
    pool.startFilling([REPO_PATH]);
    pool.startFilling([REPO_PATH]); // second call while fill may be in progress

    await flushAsync(30);

    // Pool should reach its target size despite the second redundant call
    expect(pool.getReservePaths().size).toBe(2);
    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 3: branch name collision on retry
//
// `claim()` always creates branch `orca/<taskId>-inv-<invocationId>`.
// task-lifecycle.ts always calls `pool.claim(repoPath, taskId, 0)` — passing
// hardcoded invocationId=0. On a task retry, the PREVIOUS invocation created
// branch `orca/<taskId>-inv-0`. If cleanup hasn't run yet, `checkout -b`
// will fail with "branch already exists".
// ---------------------------------------------------------------------------
describe("branch name collision on retry", () => {
  test("claim with checkout -b failure cleans up the moved taskPath (not old pool path)", async () => {
    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    expect(pool.getReservePaths().size).toBe(1);

    // Simulate retry: checkout -b fails because branch orca/TASK-1-inv-0 already exists
    mockGitAsync
      .mockResolvedValueOnce("") // worktree move succeeds
      .mockRejectedValueOnce(new Error("fatal: a branch named 'orca/TASK-1-inv-0' already exists"));

    const result = await pool.claim(REPO_PATH, "TASK-1", 0);

    // Claim returns null — task-lifecycle falls back to createWorktree()
    expect(result).toBeNull();

    // After the fix: removeWorktreeAsync is called with taskPath (where worktree was moved)
    // NOT the old pool path — the move already succeeded so that path no longer exists
    const taskPath = join(dirname(REPO_PATH), `${basename(REPO_PATH)}-TASK-1`);
    expect(mockRemoveWorktreeAsync).toHaveBeenCalledWith(taskPath);

    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 4: partial createReserve failure — orphaned worktree
//
// If `git worktree add` succeeds but `npm install` fails, the worktree
// exists on disk and is registered in git but is NOT in the pool's reserves.
// It will eventually be cleaned up by the cleanup cron, but only after the
// 60-minute age gate.
// ---------------------------------------------------------------------------
describe("createReserve partial failure: orphaned worktree", () => {
  test("worktree is removed when npm install fails after git worktree add", async () => {
    // Make existsSync return true for package.json so npm install is triggered
    vi.mocked((await import("node:fs")).existsSync).mockImplementation(
      (p: unknown) => String(p).endsWith("package.json")
    );

    // npm install fails
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        if (typeof cb === "function") {
          (cb as (...a: unknown[]) => void)(
            Object.assign(new Error("npm install failed"), { stderr: "ENOENT" }),
            "",
            "ENOENT"
          );
        }
        return {} as ReturnType<typeof execFile>;
      }
    );

    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    // Pool has 0 reserves — createReserve threw
    expect(pool.getReservePaths().size).toBe(0);

    // git worktree add WAS called (succeeded before npm install)
    const gitCalls = mockGitAsync.mock.calls.map((c) => c[0] as string[]);
    const worktreeAddCalled = gitCalls.some(
      (args) => args[0] === "worktree" && args[1] === "add"
    );
    expect(worktreeAddCalled).toBe(true);

    // After the fix: removeWorktreeAsync IS called to clean up the orphaned worktree
    expect(mockRemoveWorktreeAsync).toHaveBeenCalled();

    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 5: pool.claim() passes invocationId to createWorktree but task-lifecycle
// always passes invocationId=0, not the actual DB invocation ID.
//
// The actual invocation inserted into the DB gets an auto-incremented ID (e.g. 42).
// But the pool branch is always `orca/<taskId>-inv-0`, not `orca/<taskId>-inv-42`.
// This means:
// 1. The branch name in the DB won't match the actual invocation ID
// 2. On retry, `checkout -b orca/<taskId>-inv-0` will fail if the branch exists
// ---------------------------------------------------------------------------
describe("invocationId mismatch", () => {
  test("pool always creates branch with inv-0 regardless of actual invocation ID", async () => {
    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    mockGitAsync.mockClear();

    // task-lifecycle always passes 0 as invocationId
    const result = await pool.claim(REPO_PATH, "TASK-42", 0);
    expect(result).not.toBeNull();
    expect(result!.branchName).toBe("orca/TASK-42-inv-0");

    // The actual DB invocation ID might be 150, not 0.
    // There is a mismatch between the branch name and the invocation record.
    // This is documented as a design limitation.
    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 6: singleton is never reset between test runs or re-initializations.
// `initWorktreePool()` replaces the module-level `_pool` pointer, but the
// old WorktreePoolService instance keeps its reserves in memory and running
// background fills. The old reserves are orphaned.
// ---------------------------------------------------------------------------
describe("singleton re-initialization", () => {
  test("re-initializing singleton destroys old pool's reserves", async () => {
    const { initWorktreePool, getWorktreePool } = await import("../src/worktree/pool.js");

    // Reset mockGitAsync to succeed (may have been modified by previous test)
    mockGitAsync.mockResolvedValue("");

    const pool1 = initWorktreePool(1);
    pool1.startFilling([REPO_PATH]);
    await flushAsync(20);

    // pool1 has 1 reserve
    expect(pool1.getReservePaths().size).toBe(1);

    // Re-initialize — after fix, this calls pool1.destroy() before replacing
    const pool2 = initWorktreePool(1);

    // getWorktreePool() returns pool2
    expect(getWorktreePool()).toBe(pool2);
    expect(getWorktreePool()).not.toBe(pool1);

    // pool2 has no reserves yet (hasn't been filled)
    expect(pool2.getReservePaths().size).toBe(0);

    // After flush, pool1's destroy() completes and reserves are cleared
    await flushAsync(10);
    expect(pool1.getReservePaths().size).toBe(0);

    // Cleanup
    await pool2.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 7: refreshStale modifies the reserves array while iterating via splice,
// using a pre-built staleIndices list. The `reverse()` ensures correct splice
// indices. But after a successful refresh, `reserve.createdAt` is mutated
// in-place. If the same reserve appears in staleIndices twice (impossible
// since indices are unique), or if splice shifts indices for a later element,
// this is safe. Verify the reverse-splice logic is actually correct.
// ---------------------------------------------------------------------------
describe("refreshStale splice correctness", () => {
  test("multiple stale reserves are all refreshed in reverse-index order", async () => {
    const pool = new WorktreePoolService(3);
    pool.startFilling([REPO_PATH]);
    await flushAsync(30);

    expect(pool.getReservePaths().size).toBe(3);

    // Advance past stale threshold for all reserves
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);

    // All three refreshes succeed
    mockGitAsync.mockResolvedValue("");

    await pool.refreshStale();

    // All 3 reserves should still be in pool (refresh succeeded)
    expect(pool.getReservePaths().size).toBe(3);

    vi.restoreAllMocks();
    await pool.destroy();
  });

  test("stale reserves: failure on first, success on second — both handled independently", async () => {
    const pool = new WorktreePoolService(2);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    expect(pool.getReservePaths().size).toBe(2);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);

    // First refresh call (fetch) fails, second succeeds
    let callCount = 0;
    mockGitAsync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fetch failed"));
      return Promise.resolve("");
    });

    await pool.refreshStale();

    // One reserve removed (failed refresh), one refreshed
    expect(pool.getReservePaths().size).toBe(1);
    expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 8: `git worktree move` was added in git 2.29.
// The implementation uses it unconditionally with no version check or fallback.
// If the user has git < 2.29, every claim() will fail with
// "git: 'worktree' is not a git command" or similar.
// ---------------------------------------------------------------------------
describe("git worktree move availability", () => {
  test("BUG: claim fails silently when git worktree move is not available", async () => {
    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    expect(pool.getReservePaths().size).toBe(1);

    // Simulate git < 2.29 where `git worktree move` doesn't exist
    mockGitAsync.mockRejectedValueOnce(
      new Error("error: unknown switch `m'\nusage: git worktree <add|list|lock|prune|remove|repair|unlock>")
    );

    const result = await pool.claim(REPO_PATH, "TASK-1", 0);

    // Falls back to null — task-lifecycle creates worktree synchronously
    // This is graceful degradation, but there's no warning/detection.
    expect(result).toBeNull();

    // Reserve is discarded and cleanup attempted (on wrong path — old pool path)
    expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(1);

    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 9: pool.claim() moves worktree to taskPath, then calls `checkout -b`.
// If `checkout -b` fails (branch exists), the outer catch calls
// `removeWorktreeAsync(reserve.worktreePath)` — the OLD pool path.
// But the directory has already been MOVED to taskPath. The old path no
// longer exists. The worktree at taskPath is never cleaned up — it leaks.
// ---------------------------------------------------------------------------
describe("worktree cleanup after failed checkout -b", () => {
  test("taskPath is cleaned up when checkout -b fails after successful move", async () => {
    const pool = new WorktreePoolService(1);
    pool.startFilling([REPO_PATH]);
    await flushAsync(20);

    const reservePaths = [...pool.getReservePaths()];
    expect(reservePaths.length).toBe(1);
    const originalReservePath = reservePaths[0]!;

    // Move succeeds, checkout -b fails
    mockGitAsync
      .mockResolvedValueOnce("") // git worktree move
      .mockRejectedValueOnce(new Error("branch already exists")); // git checkout -b

    await pool.claim(REPO_PATH, "TASK-1", 0);

    // After fix: removeWorktreeAsync is called with taskPath (where worktree was moved)
    const taskPath = join(dirname(REPO_PATH), `${basename(REPO_PATH)}-TASK-1`);
    expect(mockRemoveWorktreeAsync).toHaveBeenCalledWith(taskPath);

    // NOT the old reserve path — that was already moved
    const allRemovals = mockRemoveWorktreeAsync.mock.calls.map(
      (c) => c[0] as string
    );
    expect(allRemovals).not.toContain(originalReservePath);

    await pool.destroy();
  });
});

// ---------------------------------------------------------------------------
// BUG 10: pool is NOT initialized before `setSchedulerDeps` runs.
// In cli/index.ts:
//   - worktree pool is initialized at line ~352 (before setTimeout)
//   - setSchedulerDeps runs inside setTimeout after 15s grace period
//
// However, task-lifecycle.ts calls getWorktreePool() inside a step.run().
// Steps don't execute until after setSchedulerDeps() is called (because
// workflows don't start until Inngest registration after the grace period).
// So the timing should be fine in production.
//
// But: if ORCA_WORKTREE_POOL_SIZE > 0 and projectRepoMap is empty at init
// time (before fullSync populates it), no repos are passed to startFilling().
// The pool creates NO reserves because repoPaths = [] in cli/index.ts line ~354.
// ---------------------------------------------------------------------------
describe("pool initialization with empty projectRepoMap", () => {
  test("pool with no repoPaths creates no reserves", async () => {
    const pool = new WorktreePoolService(2);
    // Pass empty repos array — simulates config.projectRepoMap being empty
    pool.startFilling([]);
    await flushAsync(20);

    // No reserves created — pool is effectively disabled
    expect(pool.getReservePaths().size).toBe(0);

    // When task arrives for a repo not in startFilling, claim returns null
    const result = await pool.claim(REPO_PATH, "TASK-1", 0);
    expect(result).toBeNull();

    await pool.destroy();
  });

  test("pool can be filled for repos added after construction", async () => {
    const pool = new WorktreePoolService(1);
    // Start filling with one repo, then start filling with another
    pool.startFilling([REPO_PATH]);
    pool.startFilling(["/repos/otherapp"]);
    await flushAsync(20);

    // Both repos should have reserves
    const paths = pool.getReservePaths();
    expect(paths.size).toBe(2);

    await pool.destroy();
  });
});
