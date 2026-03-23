// ---------------------------------------------------------------------------
// WorktreePoolService tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock gitAsync used for worktree creation, claim, and freshness
vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  gitAsync: vi.fn().mockResolvedValue(""),
  cleanStaleLockFiles: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

// Mock removeWorktreeAsync used on claim failure and destroy
vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn().mockResolvedValue(undefined),
}));

// Track what paths "exist" for each test
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

// Mock child_process to prevent real npm install
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
import { WorktreePoolService, initWorktreePool, getWorktreePool } from "../src/worktree/pool.js";
import { gitAsync } from "../src/git.js";
import { removeWorktreeAsync } from "../src/worktree/index.js";

const mockGitAsync = vi.mocked(gitAsync);
const mockRemoveWorktreeAsync = vi.mocked(removeWorktreeAsync);

/** Wait for all pending microtasks and setImmediate callbacks. */
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
  // By default paths don't exist (so existsSync returns false)
  existingPaths = new Set();
});

describe("WorktreePoolService", () => {
  describe("startFilling + fill", () => {
    test("creates N worktrees in background on startFilling", async () => {
      const pool = new WorktreePoolService(2);
      pool.startFilling([REPO_PATH]);

      await flushAsync(20);

      const paths = pool.getReservePaths();
      expect(paths.size).toBe(2);
      await pool.destroy();
    });

    test("does not over-create beyond pool size", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);

      await flushAsync(20);

      const paths = pool.getReservePaths();
      expect(paths.size).toBe(1);
      await pool.destroy();
    });

    test("handles gitAsync errors gracefully by stopping fill", async () => {
      mockGitAsync.mockRejectedValueOnce(new Error("git fetch failed"));

      const pool = new WorktreePoolService(2);
      pool.startFilling([REPO_PATH]);

      await flushAsync(10);

      // Pool stays at 0 or partial — no throw
      const paths = pool.getReservePaths();
      expect(paths.size).toBeLessThan(2);
      await pool.destroy();
    });
  });

  describe("claim", () => {
    test("returns worktree path with new branch on successful claim", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(1);

      // Task target path must NOT exist for claim to proceed
      existingPaths = new Set(); // taskPath not in set

      const result = await pool.claim(REPO_PATH, "EMI-123", 7);

      expect(result).not.toBeNull();
      expect(result!.branchName).toBe("orca/EMI-123-inv-7");
      // Path includes taskId suffix (platform-agnostic check)
      expect(result!.worktreePath).toMatch(/myapp-EMI-123$/);
      await pool.destroy();
    });

    test("pool reserve count decreases immediately after claim", async () => {
      const pool = new WorktreePoolService(2);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(2);

      await pool.claim(REPO_PATH, "EMI-1", 1);

      // Immediately after claim, pool has 1 reserve (replenish runs async)
      expect(pool.getReservePaths().size).toBe(1);
      await pool.destroy();
    });

    test("returns null when pool is empty", async () => {
      const pool = new WorktreePoolService(1);
      // Don't call startFilling — pool stays empty
      const result = await pool.claim(REPO_PATH, "EMI-999", 0);
      expect(result).toBeNull();
      await pool.destroy();
    });

    test("returns null and restores reserve when target path exists", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(1);

      // Make target path exist (retry scenario) — use join to get platform-correct path
      const taskPath = join(dirname(REPO_PATH), `${basename(REPO_PATH)}-EMI-42`);
      existingPaths.add(taskPath);

      const result = await pool.claim(REPO_PATH, "EMI-42", 0);
      expect(result).toBeNull();
      // Reserve should be restored
      expect(pool.getReservePaths().size).toBe(1);

      await pool.destroy();
    });

    test("triggers replenish after successful claim", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      await pool.claim(REPO_PATH, "EMI-5", 0);
      // Pool drained to 0

      // Wait for background replenish
      await flushAsync(30);

      // Should be back to 1
      expect(pool.getReservePaths().size).toBe(1);
      await pool.destroy();
    });

    test("discards reserve and returns null on gitAsync failure during claim", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(1);

      // Make git worktree move fail
      mockGitAsync.mockResolvedValueOnce("") // fill calls already ran — this is for the move
        .mockRejectedValueOnce(new Error("worktree move failed"));

      const result = await pool.claim(REPO_PATH, "EMI-77", 0);
      expect(result).toBeNull();
      expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(1);
      await pool.destroy();
    });

    test("uses git worktree move, checkout -b, and branch -D at claim time", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      // Clear mock history from fill phase
      mockGitAsync.mockClear();

      await pool.claim(REPO_PATH, "EMI-10", 3);

      const calls = mockGitAsync.mock.calls.map((c) => c[0] as string[]);
      expect(calls.some((args) => args[0] === "worktree" && args[1] === "move")).toBe(true);
      expect(calls.some((args) => args[0] === "checkout" && args[1] === "-b")).toBe(true);
      expect(calls.some((args) => args[0] === "branch" && args[1] === "-D")).toBe(true);
      await pool.destroy();
    });
  });

  describe("getReservePaths", () => {
    test("returns empty set when pool is empty", () => {
      const pool = new WorktreePoolService(2);
      expect(pool.getReservePaths().size).toBe(0);
    });

    test("pool reserve paths do not include claimed path after claim", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      const originalPath = [...pool.getReservePaths()][0]!;
      expect(originalPath).toContain("pool-");

      await pool.claim(REPO_PATH, "EMI-5", 0);

      // Reserve was consumed — no longer in pool
      const after = pool.getReservePaths();
      expect(after.has(originalPath)).toBe(false);
      await pool.destroy();
    });
  });

  describe("destroy", () => {
    test("cleans up all reserves on destroy", async () => {
      const pool = new WorktreePoolService(2);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(2);

      await pool.destroy();

      expect(pool.getReservePaths().size).toBe(0);
      expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(2);
    });

    test("destroy() is idempotent", async () => {
      const pool = new WorktreePoolService(1);
      await pool.destroy();
      await expect(pool.destroy()).resolves.not.toThrow();
    });
  });

  describe("multiple repos", () => {
    test("manages separate pools per repo", async () => {
      const repo1 = "/repos/app1";
      const repo2 = "/repos/app2";

      const pool = new WorktreePoolService(1);
      pool.startFilling([repo1, repo2]);
      await flushAsync(30);

      const paths = pool.getReservePaths();
      expect(paths.size).toBe(2);

      const app1Paths = [...paths].filter((p) => p.includes("app1-pool-"));
      const app2Paths = [...paths].filter((p) => p.includes("app2-pool-"));
      expect(app1Paths.length).toBe(1);
      expect(app2Paths.length).toBe(1);

      await pool.destroy();
    });
  });

  describe("refreshStale", () => {
    test("rebases reserves older than 1 hour and updates createdAt", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(1);

      // Backdating createdAt via the reserve's reference is not directly accessible,
      // so we use a subclass to expose internals for testing.
      // Instead, use vi.setSystemTime to make "now" be > 1 hour ahead.
      const originalNow = Date.now;
      const futureNow = Date.now() + 61 * 60 * 1000; // 61 minutes later
      vi.spyOn(Date, "now").mockReturnValue(futureNow);

      mockGitAsync.mockClear();
      await pool.refreshStale();

      // fetch + reset --hard should have been called for the stale reserve
      const calls = mockGitAsync.mock.calls.map((c) => c[0] as string[]);
      expect(calls.some((args) => args[0] === "fetch")).toBe(true);
      expect(calls.some((args) => args[0] === "reset" && args.includes("--hard"))).toBe(true);

      // Reserve should still be present (refresh succeeded)
      expect(pool.getReservePaths().size).toBe(1);

      vi.spyOn(Date, "now").mockRestore();
      await pool.destroy();
    });

    test("does not rebase reserves that are still fresh", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      mockGitAsync.mockClear();
      await pool.refreshStale(); // reserves are fresh (< 1 hour old)

      const calls = mockGitAsync.mock.calls.map((c) => c[0] as string[]);
      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      expect(pool.getReservePaths().size).toBe(1);

      await pool.destroy();
    });

    test("discards reserve and removes worktree when refresh fails", async () => {
      const pool = new WorktreePoolService(1);
      pool.startFilling([REPO_PATH]);
      await flushAsync(20);

      expect(pool.getReservePaths().size).toBe(1);

      // Advance time past stale threshold
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);

      // Make git fetch fail during refresh
      mockGitAsync.mockRejectedValueOnce(new Error("network error"));

      await pool.refreshStale();

      // Reserve should be removed from pool
      expect(pool.getReservePaths().size).toBe(0);
      // removeWorktreeAsync should have been called for the discarded reserve
      expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(1);

      vi.spyOn(Date, "now").mockRestore();
      await pool.destroy();
    });

    test("is a no-op when pool is empty", async () => {
      const pool = new WorktreePoolService(1);
      // No startFilling — pool is empty
      await expect(pool.refreshStale()).resolves.not.toThrow();
      await pool.destroy();
    });
  });

  describe("singleton helpers", () => {
    test("initWorktreePool creates and stores singleton", () => {
      const pool = initWorktreePool(2);
      expect(pool).toBeInstanceOf(WorktreePoolService);
      expect(getWorktreePool()).toBe(pool);
    });

    test("getWorktreePool returns the initialized instance", () => {
      // After initWorktreePool is called, getWorktreePool returns it
      const existing = getWorktreePool();
      expect(existing).toBeInstanceOf(WorktreePoolService);
    });
  });
});
