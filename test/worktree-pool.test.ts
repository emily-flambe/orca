// ---------------------------------------------------------------------------
// WorktreePoolService tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that transitively use them
// ---------------------------------------------------------------------------

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  resetWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  cleanStaleLockFiles: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain setImmediate queue by awaiting a promise that resolves after current microtasks. */
async function drainSetImmediate(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorktreePoolService", () => {
  let mockCreateWorktree: ReturnType<typeof vi.fn>;
  let mockResetWorktree: ReturnType<typeof vi.fn>;
  let mockRemoveWorktree: ReturnType<typeof vi.fn>;
  let mockGit: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;

  // Use a unique counter per test to avoid import caching affecting call counts
  let worktreeCounter = 0;

  beforeEach(async () => {
    const worktreeModule = await import("../src/worktree/index.js");
    mockCreateWorktree = vi.mocked(worktreeModule.createWorktree);
    mockResetWorktree = vi.mocked(worktreeModule.resetWorktree);
    mockRemoveWorktree = vi.mocked(worktreeModule.removeWorktree);

    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);

    mockGit.mockReturnValue("");
    mockExistsSync.mockReturnValue(true);

    // Default: createWorktree returns a unique path per call
    mockCreateWorktree.mockImplementation(() => {
      worktreeCounter++;
      return {
        worktreePath: `/repo/pool-wt-${worktreeCounter}`,
        branchName: `pool-${worktreeCounter.toString(36).padStart(8, "0")}`,
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Pool creation: start() enqueues background creation
  // -------------------------------------------------------------------------

  describe("start()", () => {
    test("pool is empty immediately after start() — creation is async", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);

      // Before setImmediate fires, pool should be empty
      expect(pool.getPooledPaths().size).toBe(0);
    });

    test("pool entries appear after setImmediate drains", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);

      await drainSetImmediate();

      expect(mockCreateWorktree).toHaveBeenCalledWith("/repo", expect.stringMatching(/^pool-/), 0);
      expect(pool.getPooledPaths().size).toBe(2);
    });

    test("start() with multiple repos pre-creates for each", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo-a", "/repo-b"]);

      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(2);
      // createWorktree called once for each repo
      expect(mockCreateWorktree).toHaveBeenCalledTimes(2);
    });

    test("calling start() twice for same repo does not double-create", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const firstCount = mockCreateWorktree.mock.calls.length;

      // Second call should see pool already full and not create more
      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(mockCreateWorktree.mock.calls.length).toBe(firstCount);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Claim hit: claim() returns pooled entry
  // -------------------------------------------------------------------------

  describe("claim() — pool hit", () => {
    test("returns worktreePath and renamed branchName from pool", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const result = pool.claim("/repo", "TASK-1", 42);

      expect(result).not.toBeNull();
      expect(result!.worktreePath).toMatch(/^\/repo\/pool-wt-/);
      expect(result!.branchName).toBe("orca/TASK-1-inv-42");
    });

    test("pool size decreases by 1 after claim", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(2);

      pool.claim("/repo", "TASK-1", 1);

      // After claim, before replenishment settles
      expect(pool.getPooledPaths().size).toBe(1);
    });

    test("claim calls git branch -m with old and new branch names", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // Read the actual branch name stored in the pool entry (white-box)
      // @ts-ignore
      const entries = pool.pool.get("/repo")!;
      expect(entries.length).toBe(1);
      const storedBranchName = entries[0]!.branchName;

      // Reset git mock so we only see calls from claim(), not from creation
      mockGit.mockClear();

      pool.claim("/repo", "TASK-99", 7);

      expect(mockGit).toHaveBeenCalledWith(
        ["branch", "-m", storedBranchName, "orca/TASK-99-inv-7"],
        { cwd: "/repo" },
      );
    });

    test("invocationId as string is handled correctly in branch name", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const result = pool.claim("/repo", "TASK-5", "abc-123");

      expect(result!.branchName).toBe("orca/TASK-5-inv-abc-123");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Claim miss: claim() returns null when pool is empty
  // -------------------------------------------------------------------------

  describe("claim() — pool miss", () => {
    test("returns null when pool has no entries for repo", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      // Never called start() so no pool for this repo
      const result = pool.claim("/repo", "TASK-1", 1);

      expect(result).toBeNull();
    });

    test("returns null when pool entries exist for different repo", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo-a"]);
      await drainSetImmediate();

      const result = pool.claim("/repo-b", "TASK-1", 1);

      expect(result).toBeNull();
    });

    test("returns null after pool is exhausted by claims", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      // Use poolSize=1, immediately block replenishment by making createWorktree hang
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // First claim succeeds
      expect(pool.claim("/repo", "TASK-1", 1)).not.toBeNull();

      // Second claim before replenishment: pool is empty
      // (replenishment is enqueued but not yet run)
      expect(pool.claim("/repo", "TASK-2", 2)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Branch rename: exact git call verification
  // -------------------------------------------------------------------------

  describe("branch rename on claim()", () => {
    test("renames branch in the repo directory (not worktree directory)", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/my/repo"]);
      await drainSetImmediate();

      pool.claim("/my/repo", "EMI-42", 99);

      const renameCalls = mockGit.mock.calls.filter(
        (call) => call[0][0] === "branch" && call[0][1] === "-m",
      );

      expect(renameCalls).toHaveLength(1);
      // cwd must be the REPO path, not the worktree path
      expect(renameCalls[0][1]).toEqual({ cwd: "/my/repo" });
    });

    test("claim returns original branchName when git rename fails (safe fallback)", async () => {
      // When git branch -m fails, claim() should return the original pool branch name
      // so the caller can still work with the worktree on the correct branch.
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const createResult = mockCreateWorktree.mock.results[mockCreateWorktree.mock.results.length - 1].value as {
        worktreePath: string;
        branchName: string;
      };
      const originalBranch = createResult.branchName;

      // Make git rename fail
      mockGit.mockImplementation(() => {
        throw new Error("fatal: branch rename failed");
      });

      const result = pool.claim("/repo", "TASK-1", 1);

      expect(result).not.toBeNull();
      // Fixed: returns the original branch name when rename fails, not the requested name
      expect(result!.branchName).toBe(originalBranch);
      expect(result!.branchName).not.toBe("orca/TASK-1-inv-1");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Replenishment after claim
  // -------------------------------------------------------------------------

  describe("replenishment after claim()", () => {
    test("pool returns to target size after claim + drainSetImmediate", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(2);

      pool.claim("/repo", "TASK-1", 1);

      expect(pool.getPooledPaths().size).toBe(1);

      // Wait for replenishment
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(2);
    });

    test("multiple claims trigger multiple replenishments", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(3);

      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(3);

      pool.claim("/repo", "TASK-1", 1);
      pool.claim("/repo", "TASK-2", 2);
      pool.claim("/repo", "TASK-3", 3);

      expect(pool.getPooledPaths().size).toBe(0);

      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. In-flight tracking: no over-creation
  // -------------------------------------------------------------------------

  describe("in-flight tracking", () => {
    test("does not create more worktrees than poolSize even with concurrent replenishment calls", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);

      // Trigger replenishment multiple times before any settle
      // @ts-ignore — accessing private method for white-box testing
      pool._scheduleReplenishment("/repo");
      // @ts-ignore
      pool._scheduleReplenishment("/repo");

      await drainSetImmediate();

      // Should never exceed poolSize
      expect(pool.getPooledPaths().size).toBeLessThanOrEqual(2);
      expect(mockCreateWorktree).toHaveBeenCalledTimes(2);
    });

    test("in-flight count goes to 0 after creation completes", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // After settling, no in-flight should remain
      // @ts-ignore — white-box: check inFlight map
      const inFlight = pool.inFlight.get("/repo") ?? 0;
      expect(inFlight).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. getPooledPaths()
  // -------------------------------------------------------------------------

  describe("getPooledPaths()", () => {
    test("returns empty set when pool not started", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      expect(pool.getPooledPaths().size).toBe(0);
    });

    test("returns correct paths after pool fills", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const paths = pool.getPooledPaths();
      expect(paths.size).toBe(2);

      // All paths should start with the expected prefix
      for (const p of paths) {
        expect(p).toMatch(/^\/repo\/pool-wt-/);
      }
    });

    test("claimed paths are no longer in getPooledPaths()", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const pathsBefore = Array.from(pool.getPooledPaths());
      const claimedPath = pool.claim("/repo", "TASK-1", 1)!.worktreePath;

      const pathsAfter = pool.getPooledPaths();

      expect(pathsBefore).toContain(claimedPath);
      expect(pathsAfter.has(claimedPath)).toBe(false);
    });

    test("returns paths from multiple repos", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo-a", "/repo-b"]);
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 8. refresh() — stale entry handling
  // -------------------------------------------------------------------------

  describe("refresh()", () => {
    test("does not touch entries younger than 1 hour", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      pool.refresh();

      expect(mockResetWorktree).not.toHaveBeenCalled();
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    test("calls resetWorktree for entries older than 1 hour and updates createdAt", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // Artificially age the pool entry
      // @ts-ignore — white-box access to private pool map
      const entries = pool.pool.get("/repo")!;
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      const agedTimestamp = Date.now() - 61 * 60 * 1000; // 61 minutes ago
      entry.createdAt = agedTimestamp;

      mockExistsSync.mockReturnValue(true);

      pool.refresh();

      expect(mockResetWorktree).toHaveBeenCalledWith(entry.worktreePath);
      // createdAt should be updated past the stale timestamp
      expect(entry.createdAt).toBeGreaterThan(agedTimestamp);
    });

    test("removes entry and schedules replenishment if path does not exist", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // @ts-ignore
      const entries = pool.pool.get("/repo")!;
      entries[0]!.createdAt = Date.now() - 61 * 60 * 1000;

      // Path doesn't exist
      mockExistsSync.mockReturnValue(false);
      const createCallsBefore = mockCreateWorktree.mock.calls.length;

      pool.refresh();

      // Entry should be removed
      expect(entries.length).toBe(0);
      // resetWorktree should NOT have been called (path didn't exist)
      expect(mockResetWorktree).not.toHaveBeenCalled();

      // Replenishment should be scheduled
      await drainSetImmediate();
      expect(mockCreateWorktree.mock.calls.length).toBeGreaterThan(createCallsBefore);
    });

    test("removes entry and calls removeWorktree when resetWorktree throws", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // @ts-ignore
      const entries = pool.pool.get("/repo")!;
      const stalePath = entries[0]!.worktreePath;
      entries[0]!.createdAt = Date.now() - 61 * 60 * 1000;

      mockExistsSync.mockReturnValue(true);
      mockResetWorktree.mockImplementation(() => {
        throw new Error("reset failed");
      });

      pool.refresh();

      // Entry should be removed from pool
      expect(entries.length).toBe(0);
      // removeWorktree should be called as best-effort cleanup
      expect(mockRemoveWorktree).toHaveBeenCalledWith(stalePath);
    });

    test("continues processing remaining entries even after one reset fails", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(3);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // @ts-ignore
      const entries = pool.pool.get("/repo")!;
      expect(entries.length).toBe(3);

      // Age all entries
      entries.forEach((e) => {
        e.createdAt = Date.now() - 61 * 60 * 1000;
      });

      mockExistsSync.mockReturnValue(true);

      let resetCount = 0;
      mockResetWorktree.mockImplementation(() => {
        resetCount++;
        if (resetCount === 1) throw new Error("reset failed for first entry");
        // Others succeed
      });

      pool.refresh();

      // First entry removed (reset failed), other two refreshed
      expect(entries.length).toBe(2);
      expect(mockResetWorktree).toHaveBeenCalledTimes(3);
    });

    test("pool stays empty when no entries (no crash)", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      // Never start — no pool initialized at all
      expect(() => pool.refresh()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Graceful fallback: createWorktree throws → pool stays empty
  // -------------------------------------------------------------------------

  describe("createWorktree failure handling", () => {
    test("pool stays empty if createWorktree throws — no crash", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      mockCreateWorktree.mockImplementation(() => {
        throw new Error("git worktree add failed");
      });

      pool.start(["/repo"]);
      await drainSetImmediate();

      // Pool should be empty — no crash, no throw
      expect(pool.getPooledPaths().size).toBe(0);
    });

    test("in-flight count is decremented even when createWorktree throws", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      mockCreateWorktree.mockImplementation(() => {
        throw new Error("worktree creation failed");
      });

      pool.start(["/repo"]);
      await drainSetImmediate();

      // @ts-ignore
      const inFlight = pool.inFlight.get("/repo") ?? 0;
      expect(inFlight).toBe(0);
    });

    test("partial failure: one createWorktree succeeds, one fails", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      let callCount = 0;
      mockCreateWorktree.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { worktreePath: "/repo/pool-wt-ok", branchName: "pool-ok" };
        }
        throw new Error("second creation failed");
      });

      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(pool.getPooledPaths().size).toBe(1);
      expect(pool.getPooledPaths().has("/repo/pool-wt-ok")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Cleanup protection: pool paths are skipped in cleanupStaleResources
  // -------------------------------------------------------------------------

  describe("cleanup protection via pooledWorktreePaths", () => {
    test("getPooledPaths() returns a Set usable as pooledWorktreePaths", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const pooledPaths = pool.getPooledPaths();
      expect(pooledPaths).toBeInstanceOf(Set);
      expect(pooledPaths.size).toBe(2);
    });

    test("getPooledPaths() returns a new Set — mutations don't affect internal pool", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const paths = pool.getPooledPaths();
      const sizeBefore = pool.getPooledPaths().size;

      // Mutate the returned set
      for (const p of paths) {
        paths.delete(p);
      }

      // Internal pool should be unaffected
      expect(pool.getPooledPaths().size).toBe(sizeBefore);
    });
  });

  // -------------------------------------------------------------------------
  // 11. Edge cases and boundary conditions
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    test("poolSize = 0 creates no worktrees", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(0);

      pool.start(["/repo"]);
      await drainSetImmediate();

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(pool.getPooledPaths().size).toBe(0);
    });

    test("claim on unknown repo (never started) returns null without throwing", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      expect(() => pool.claim("/never-started", "TASK-1", 1)).not.toThrow();
      expect(pool.claim("/never-started", "TASK-1", 2)).toBeNull();
    });

    test("BUG PROBE: removeWorktree failure in refresh does not crash", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      // @ts-ignore
      const entries = pool.pool.get("/repo")!;
      entries[0]!.createdAt = Date.now() - 61 * 60 * 1000;

      mockExistsSync.mockReturnValue(true);
      mockResetWorktree.mockImplementation(() => {
        throw new Error("reset failed");
      });
      mockRemoveWorktree.mockImplementation(() => {
        throw new Error("remove also failed");
      });

      // Should not throw — removeWorktree failure is best-effort
      expect(() => pool.refresh()).not.toThrow();
    });

    test("start() with empty array does nothing", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(2);

      // Drain any leftover setImmediate callbacks from prior tests before this assertion
      await drainSetImmediate();
      mockCreateWorktree.mockClear();

      expect(() => pool.start([])).not.toThrow();
      await drainSetImmediate();

      expect(mockCreateWorktree).not.toHaveBeenCalled();
      expect(pool.getPooledPaths().size).toBe(0);
    });

    test("claim with numeric invocationId formats correctly", async () => {
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);
      await drainSetImmediate();

      const result = pool.claim("/repo", "TASK-1", 0);
      expect(result!.branchName).toBe("orca/TASK-1-inv-0");
    });

    test("BUG PROBE: _createEntry with cleared pool map entry does not crash", async () => {
      // If the pool map entry is somehow cleared between _enqueueCreation and
      // _createEntry execution, the worktree would be created but never tracked.
      const { WorktreePoolService } = await import("../src/worktree/pool.js");
      const pool = new WorktreePoolService(1);

      pool.start(["/repo"]);

      // Clear the pool entry before setImmediate fires
      // @ts-ignore
      pool.pool.delete("/repo");

      await drainSetImmediate();

      // createWorktree may or may not be called (it runs in the already-queued task)
      // But crucially, it must not throw/crash
      // The entry won't be tracked (pool.get(repoPath) returns undefined)
      // This is the leak scenario — the worktree is created but not stored
      if (mockCreateWorktree.mock.calls.length > 0) {
        // If creation ran, the result should be orphaned (not in any pool)
        expect(pool.getPooledPaths().size).toBe(0);
      }
    });
  });
});
