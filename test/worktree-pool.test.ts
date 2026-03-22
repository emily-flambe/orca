// ---------------------------------------------------------------------------
// WorktreePoolService unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../src/git.js", () => ({
  gitAsync: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/worktree/index.js", () => ({
  removeWorktreeAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        cb: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        cb(null, { stdout: "" });
        return {} as ReturnType<typeof actual.execFile>;
      },
    ),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    copyFileSync: vi.fn(),
  };
});

import { WorktreePoolService } from "../src/worktree/pool.js";
import { gitAsync } from "../src/git.js";
import { removeWorktreeAsync } from "../src/worktree/index.js";

const mockGitAsync = vi.mocked(gitAsync);
const mockRemoveWorktreeAsync = vi.mocked(removeWorktreeAsync);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreePoolService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gitAsync succeeds
    mockGitAsync.mockResolvedValue("");
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe("initialize", () => {
    test("creates pool entry for repoPath after background replenishment", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      // Allow async replenishment to complete
      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      // gitAsync should have been called for fetch + worktree add
      expect(mockGitAsync).toHaveBeenCalledWith(
        ["fetch", "origin"],
        expect.objectContaining({ cwd: "/repo/orca" }),
      );
      expect(mockGitAsync).toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add", "-b"]),
        expect.objectContaining({ cwd: "/repo/orca" }),
      );
    });

    test("creates poolSize entries per repo", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 2);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });
    });

    test("handles multiple repo paths independently", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/alpha", "/repo/beta"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // claim
  // -------------------------------------------------------------------------

  describe("claim", () => {
    test("returns null when pool is empty", () => {
      const pool = new WorktreePoolService();
      // Don't call initialize — pool is empty
      const result = pool.claim("/repo/orca", "TASK-1", 0);
      expect(result).toBeNull();
    });

    test("returns null when repoPath not in pool", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/alpha"], 1);
      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      // Claim for a different repo
      const result = pool.claim("/repo/beta", "TASK-1", 0);
      expect(result).toBeNull();
    });

    test("returns entry and removes it from pool", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      const sizeBefore = pool.getReservedPaths().size;
      expect(sizeBefore).toBeGreaterThan(0);

      const result = pool.claim("/repo/orca", "EMI-1", 0);
      expect(result).not.toBeNull();
      expect(result!.branchName).toBe("orca/EMI-1-inv-0");
      expect(result!.worktreePath).toContain("orca-pool-");
    });

    test("pool size decreases by 1 after claim (before replenishment)", async () => {
      // Use poolSize=2 and claim once synchronously after pool is full
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 2);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });

      // Block further replenishment to measure the immediate state
      mockGitAsync.mockImplementation(() => new Promise(() => {})); // never resolves

      pool.claim("/repo/orca", "EMI-1", 0);

      // Pool should have 1 entry now (replenishment won't complete due to mock)
      expect(pool.getReservedPaths().size).toBe(1);
    });

    test("triggers background replenishment after claim", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(1);
      });

      mockGitAsync.mockClear();
      mockGitAsync.mockResolvedValue("");

      pool.claim("/repo/orca", "EMI-1", 0);

      // Replenishment should fire after claim
      await vi.waitFor(() => {
        // gitAsync called again to create a new pool entry
        expect(mockGitAsync).toHaveBeenCalled();
      });
    });

    test("branch name includes taskId and invocationId", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      const result = pool.claim("/repo/orca", "EMI-42", 7);
      expect(result!.branchName).toBe("orca/EMI-42-inv-7");
    });
  });

  // -------------------------------------------------------------------------
  // getReservedPaths
  // -------------------------------------------------------------------------

  describe("getReservedPaths", () => {
    test("returns empty set before initialization", () => {
      const pool = new WorktreePoolService();
      expect(pool.getReservedPaths().size).toBe(0);
    });

    test("returns all pool paths across multiple repos", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/alpha", "/repo/beta"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });

      const paths = pool.getReservedPaths();
      // Each path should be in the correct parent dir
      for (const p of paths) {
        expect(p).toMatch(/alpha-pool-|beta-pool-/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // refreshStale
  // -------------------------------------------------------------------------

  describe("refreshStale", () => {
    test("does nothing when pool is empty", async () => {
      const pool = new WorktreePoolService();
      // No initialization
      await pool.refreshStale("/repo/orca", 60_000);
      expect(mockGitAsync).not.toHaveBeenCalled();
    });

    test("does not rebase entries younger than maxAgeMs", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      mockGitAsync.mockClear();

      // Use a very large maxAgeMs so nothing is stale
      await pool.refreshStale("/repo/orca", 999_999_999);

      // Should not have called fetch/rebase for refresh
      const rebaseCalls = mockGitAsync.mock.calls.filter((args) =>
        (args[0] as string[]).includes("rebase"),
      );
      expect(rebaseCalls).toHaveLength(0);
    });

    test("rebases entries older than maxAgeMs", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      mockGitAsync.mockClear();
      mockGitAsync.mockResolvedValue("");

      // Backdate entry's createdAt so it appears stale
      // Access internal pool state via claim-then-re-add trick:
      // Instead, use maxAgeMs=0 to make everything stale
      await pool.refreshStale("/repo/orca", 0);

      const rebaseCalls = mockGitAsync.mock.calls.filter((args) =>
        (args[0] as string[]).includes("rebase"),
      );
      expect(rebaseCalls.length).toBeGreaterThan(0);
    });

    test("removes and replenishes entry when rebase fails", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBeGreaterThan(0);
      });

      mockGitAsync.mockClear();

      // Make rebase fail
      mockGitAsync.mockImplementation(async (args) => {
        const argArr = args as string[];
        if (argArr.includes("rebase")) throw new Error("rebase conflict");
        return "";
      });

      await pool.refreshStale("/repo/orca", 0);

      // The failed entry should be removed
      expect(mockRemoveWorktreeAsync).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe("destroy", () => {
    test("removes all pool worktrees", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 2);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });

      await pool.destroy();

      expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(2);
      expect(pool.getReservedPaths().size).toBe(0);
    });

    test("clears pool map after destroy", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 1);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(1);
      });

      await pool.destroy();
      expect(pool.getReservedPaths().size).toBe(0);
    });

    test("does not throw when pool is already empty", async () => {
      const pool = new WorktreePoolService();
      await expect(pool.destroy()).resolves.not.toThrow();
    });

    test("continues destroying remaining entries even if one fails", async () => {
      const pool = new WorktreePoolService();
      pool.initialize(["/repo/orca"], 2);

      await vi.waitFor(() => {
        expect(pool.getReservedPaths().size).toBe(2);
      });

      let callCount = 0;
      mockRemoveWorktreeAsync.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("removal failed");
      });

      // Should not throw even when one removal fails
      await expect(pool.destroy()).resolves.not.toThrow();
      expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(2);
    });
  });
});
