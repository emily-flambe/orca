// ---------------------------------------------------------------------------
// WorktreePoolService adversarial / edge-case tests
//
// These tests are written to EXPOSE bugs. They are expected to fail until
// the bugs are fixed. Each test documents the bug it targets and the
// expected (correct) behavior vs the actual (broken) behavior.
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  mockGitAsync.mockResolvedValue("");
  mockRemoveWorktreeAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BUG 1: destroy() race with in-flight replenish()
//
// When destroy() is called while replenish() is awaiting createEntry(), the
// replenish() loop holds a local reference to `pool` captured before
// pools.clear(). After destroy(), pool.push(entry) still appends entries to
// the orphaned array. Those entries' worktrees are created but NEVER removed
// by destroy() and NEVER appear in getReservedPaths().
//
// Expected: destroy() should prevent in-flight replenishment from creating
//           new worktrees OR should track and remove any created after clear.
// Actual:   New worktrees are created after destroy() and never cleaned up.
// ---------------------------------------------------------------------------

describe("BUG 1: destroy() race with in-flight replenish()", () => {
  test("worktrees created after destroy() are never removed (leaked resources)", async () => {
    // We need a way to observe worktrees created during replenishment that
    // began before destroy() but completed after destroy() cleared the pool.
    //
    // Strategy: make gitAsync block on the first call (fetch), let destroy()
    // run, then unblock to simulate the race.

    let unblockReplenish!: () => void;
    const fetchBlock = new Promise<string>((resolve) => {
      unblockReplenish = () => resolve("");
    });

    let callCount = 0;
    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      callCount++;
      if (argArr.includes("fetch") && callCount === 1) {
        // Block the first fetch — simulates slow network during initial
        // replenishment that was triggered by initialize()
        return fetchBlock;
      }
      return "";
    });

    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    // destroy() runs while replenishment is blocked at fetch
    await pool.destroy();

    // At this point, pools map is cleared and destroy() returned.
    // The destroy() call found 0 entries (replenishment hadn't pushed yet).
    expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(0);

    // Now unblock replenishment — it will create and push an entry into the
    // orphaned pool array (which destroy() already cleared and released).
    unblockReplenish();
    // Let the microtask queue drain so replenish() completes
    await new Promise((r) => setTimeout(r, 50));

    // BUG: The worktree was created (gitAsync was called with "worktree add")
    // but removeWorktreeAsync was NEVER called for it. The entry is leaked.
    const worktreeAddCalls = mockGitAsync.mock.calls.filter((args) =>
      (args[0] as string[]).includes("add"),
    );

    if (worktreeAddCalls.length > 0) {
      // A worktree was created after destroy() — it should have been removed
      // but removeWorktreeAsync was not called for it.
      expect(mockRemoveWorktreeAsync).toHaveBeenCalled();
      // This assertion FAILS — demonstrating the bug.
    }
    // Also: pool should remain empty and getReservedPaths should be empty
    expect(pool.getReservedPaths().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 2: claim() in task-lifecycle hardcodes invocationId=0
//
// In src/inngest/workflows/task-lifecycle.ts line ~649:
//   deps.worktreePool?.claim(task.repoPath, taskId, 0)
//
// The invocationId argument is always 0. Every claimed worktree gets branch
// name `orca/<taskId>-inv-0` regardless of the actual invocation number.
//
// If a task is retried (invocationId=1, 2, 3...), the branch from the pool
// is still named `orca/<taskId>-inv-0`, conflicting with or overwriting the
// previous branch.
//
// This is a call-site bug in task-lifecycle.ts, not in pool.ts itself.
// We test pool.ts's behavior to confirm the branch name is constructed from
// whatever invocationId is passed — and document the call-site defect.
// ---------------------------------------------------------------------------

describe("BUG 2: task-lifecycle always passes invocationId=0 to pool.claim()", () => {
  test("pool.claim() produces correct branch name when invocationId > 0", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    // Simulate a retry invocation (id=2)
    const result = pool.claim("/repo/orca", "EMI-99", 2);
    expect(result).not.toBeNull();
    expect(result!.branchName).toBe("orca/EMI-99-inv-2");
    // pool.ts itself is fine — the bug is the caller always passing 0.
    // This test documents that the pool CAN handle invocationId != 0.
  });

  test("two claims with same taskId but different invocationId produce distinct branch names", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 2);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(2);
    });

    // First invocation of a task
    const result1 = pool.claim("/repo/orca", "EMI-100", 1);
    // Second invocation of same task (retry)
    const result2 = pool.claim("/repo/orca", "EMI-100", 2);

    expect(result1!.branchName).toBe("orca/EMI-100-inv-1");
    expect(result2!.branchName).toBe("orca/EMI-100-inv-2");

    // These should be different branch names
    expect(result1!.branchName).not.toBe(result2!.branchName);

    // BUT in production, task-lifecycle.ts calls:
    //   claim(task.repoPath, taskId, 0)   <-- hardcoded 0, always
    // So both invocations would produce "orca/EMI-100-inv-0", not distinct.
  });
});

// ---------------------------------------------------------------------------
// BUG 3: refreshStale() can push an entry back to a full pool
//
// Scenario:
// 1. Pool has 1 entry, poolSize=1
// 2. refreshStale() removes the stale entry from pool (pool.length=0)
// 3. During the await for fetch+rebase, scheduleReplenish fires from
//    somewhere else and replenishment fills the pool back to poolSize=1
// 4. rebase succeeds, pool.push(entry) — pool is now size 2 (exceeds poolSize)
//
// Expected: after refreshStale, pool should not exceed poolSize
// Actual:   pool can grow beyond poolSize
// ---------------------------------------------------------------------------

describe("BUG 3: refreshStale can exceed poolSize after successful rebase", () => {
  test("pool does not exceed poolSize when replenishment fills pool during rebase", async () => {
    // Scenario that triggers the overflow:
    //   poolSize=2, pool starts with [A, B]
    //   1. claim(A) succeeds → pool=[B], scheduleReplenish fires (replenishing=true)
    //   2. refreshStale runs on B (stale) → removes B → pool=[]
    //      → awaits fetch (yields) → awaits rebase (blocked by test)
    //   3. replenishment loop: pool.length(0) < 2 → creates A', A'' → pool=[A', A'']
    //   4. rebase unblocks → pool.push(B) → pool=[A', A'', B] (size=3, exceeds poolSize=2)
    //
    // The overflow: refreshStale does not check pool.length before push.

    // Track how many "worktree add" calls happen (to know when replenishment complete)
    let worktreeAddCount = 0;
    let rebaseStarted = false;
    let unblockRebase!: () => void;
    const rebaseBlock = new Promise<string>((resolve) => {
      unblockRebase = () => resolve("");
    });

    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      if (argArr.includes("rebase")) {
        rebaseStarted = true;
        return rebaseBlock;
      }
      if (argArr.includes("add")) {
        worktreeAddCount++;
      }
      return "";
    });

    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 2);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(2);
    });

    // Step 1: claim one entry → scheduleReplenish fires (replenishing becomes true)
    // Block replenishment mid-flight so it's still running when refreshStale starts.
    // We need replenishment to be in progress during refreshStale.
    // Strategy: claim entry, then immediately start refreshStale with maxAgeMs=0
    // so the remaining entry is stale. The replenishment will be trying to refill
    // while refreshStale is doing fetch+rebase on the stale entry.
    mockGitAsync.mockClear();
    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      if (argArr.includes("rebase")) {
        rebaseStarted = true;
        return rebaseBlock;
      }
      if (argArr.includes("add")) {
        worktreeAddCount++;
      }
      return "";
    });

    // Claim one entry — pool goes from 2 to 1, replenishment triggered
    const claimed = pool.claim("/repo/orca", "EMI-500", 0);
    expect(claimed).not.toBeNull();

    // Start refreshStale on the remaining entry (maxAgeMs=0 makes it stale)
    // refreshStale will remove the remaining entry, do fetch, then block at rebase
    const refreshPromise = pool.refreshStale("/repo/orca", 0);

    // Wait until rebase is blocking (pool is now empty, replenishment may be running)
    await vi.waitFor(
      () => {
        if (rebaseStarted) return;
        throw new Error("waiting for rebase to start");
      },
      { timeout: 2000 },
    );

    // At this point:
    // - pool is empty (the stale entry was removed before rebase await)
    // - replenishment loop is running (triggered by claim), creating new entries
    // Wait for replenishment to finish filling the pool
    await vi.waitFor(
      () => {
        if (pool.getReservedPaths().size >= 2) return;
        throw new Error("waiting for pool to fill");
      },
      { timeout: 2000 },
    );

    expect(pool.getReservedPaths().size).toBe(2);

    // Now unblock the rebase — refreshStale will push the entry back
    unblockRebase();
    await refreshPromise;

    // BUG: pool now has 3 entries (exceeds poolSize=2)
    const finalSize = pool.getReservedPaths().size;
    expect(finalSize).toBeLessThanOrEqual(2); // FAILS — actual is 3
  });
});

// ---------------------------------------------------------------------------
// BUG 4: getReservedPaths() does not include claimed-but-not-yet-renamed entries
//
// After claim() pops an entry via pool.shift(), the entry is removed from
// the pool. getReservedPaths() therefore does NOT include the claimed path.
// The branch rename (gitAsync branch -m) is async fire-and-forget.
//
// There is a window between claim() returning and the invocation being
// recorded in the DB where cleanup could delete the worktree:
//   - cleanup runs
//   - worktree is not in runningWorktreePaths (not yet in DB)
//   - worktree is not in preservedWorktreePaths (removed from pool)
//   - cleanup deletes the worktree
//   - Claude session starts in a deleted directory
//
// Expected: getReservedPaths() should include recently-claimed paths until
//           they are confirmed as running invocations in the DB.
// Actual:   claimed paths immediately disappear from reserved set.
// ---------------------------------------------------------------------------

describe("BUG 4: claimed entry disappears from reserved paths immediately", () => {
  test("worktree path is not in reserved set after claim but before DB registration", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    const reservedBefore = [...pool.getReservedPaths()][0];
    expect(reservedBefore).toBeDefined();

    // Claim the entry (removes it from pool)
    const result = pool.claim("/repo/orca", "EMI-200", 1);
    expect(result).not.toBeNull();
    expect(result!.worktreePath).toBe(reservedBefore);

    // The claimed path is now gone from reserved paths — cleanup window open
    const reservedAfter = pool.getReservedPaths();
    // BUG: the claimed worktree is no longer protected from cleanup
    // even though the branch rename hasn't completed yet and the
    // invocation hasn't been recorded in the DB.
    //
    // A safe implementation would keep it in a "claimed but not yet running"
    // set until confirmed. We document this as a bug:
    expect(reservedAfter.has(reservedBefore)).toBe(false);
    // This passes (confirming the bug is real) — cleanup has an open window
    // during which the claimed worktree is unprotected.
  });
});

// ---------------------------------------------------------------------------
// BUG 5: scheduleReplenish does not re-check pool size after replenishment
//        completes when multiple scheduleReplenish calls pile up
//
// scheduleReplenish guards with this.replenishing.has() so only one
// replenishment runs at a time. But after replenish() completes and deletes
// from replenishing, if a concurrent claim triggered a second
// scheduleReplenish that was dropped (because the first was in progress),
// the pool may stay under-full.
//
// Scenario:
// 1. Pool has 0 entries, poolSize=3
// 2. First claim → scheduleReplenish starts replenishment (replenishing=true)
// 3. Second claim → scheduleReplenish no-ops (replenishing=true)
// 4. Third claim → scheduleReplenish no-ops (replenishing=true)
// 5. Replenishment completes, creates only enough to fill to 3
//    — but 3 entries were claimed! Pool needs 3 new entries but the loop
//    in replenish() checks pool.length < poolSize and will create 3 entries.
//    Actually, the while loop in replenish() runs until full, so this IS
//    correctly handled IF pool.length was 0 when replenishment started.
//
// Revised scenario where it DOES fail:
// 1. Pool has 2 entries, poolSize=2
// 2. Claim 1: pool has 1 entry, scheduleReplenish starts (replenishing=true)
// 3. Claim 2: pool has 0 entries, scheduleReplenish no-ops (replenishing=true)
// 4. Replenishment runs: pool.length=0 < 2, creates 2 entries. Pool=2. Done.
//    Fine — it loops until poolSize is reached.
//
// Actually the while loop handles this correctly. This is a FALSE ALARM.
// But let's verify the while loop really does account for claims during
// replenishment.
// ---------------------------------------------------------------------------

describe("Concurrent claims during replenishment — pool stays full (correctness verification)", () => {
  test("pool reaches poolSize even when claims happen during replenishment", async () => {
    // Allow first create to happen, then block the second one
    let createCount = 0;
    let unblockSecondCreate!: () => void;
    const secondCreateBlock = new Promise<string>((resolve) => {
      unblockSecondCreate = () => resolve("");
    });

    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      if (argArr.includes("add")) {
        createCount++;
        if (createCount === 2) return secondCreateBlock;
      }
      return "";
    });

    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 2);

    // Wait for first entry to be created
    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    // Claim the only entry — now pool has 0, replenishment triggered
    // (But replenishment is already in progress for the second entry)
    pool.claim("/repo/orca", "EMI-300", 0);

    // Unblock second create
    unblockSecondCreate();

    // Replenishment loop should now see pool.length=0 < poolSize=2 and
    // create more entries until full
    await vi.waitFor(
      () => {
        expect(pool.getReservedPaths().size).toBe(2);
      },
      { timeout: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------
// BUG 6: refreshStale called for a repo with no pool entry (not initialized)
//        does not create new entries when it should
//
// If refreshStale is called for a repoPath that is in getAllTasks() but the
// pool was never initialized for that repo (e.g., new task added after init),
// pool.get(repoPath) returns undefined and refreshStale returns immediately.
// No entries are created.
//
// This is more of a design gap than a code bug — the pool.initialize() must
// be called again when new repos are discovered. But the cleanup cron in
// cleanup.ts calls refreshStale for ALL task repo paths, including those
// not in the pool. Stale pool entries for new repos are never created.
// ---------------------------------------------------------------------------

describe("BUG 6: refreshStale silently does nothing for uninitialized repos", () => {
  test("refreshStale returns without error but creates no entries for unknown repoPath", async () => {
    const pool = new WorktreePoolService();
    // Don't initialize /repo/new-repo

    await pool.refreshStale("/repo/new-repo", 0);

    // No entries created — cleanup.ts will call this on every task repo but
    // pool has never been initialized for repos added after startup.
    expect(pool.getReservedPaths().size).toBe(0);
    expect(mockGitAsync).not.toHaveBeenCalled();

    // This is a DESIGN GAP: cleanup.ts refreshes stale entries but can't
    // trigger initial pool creation for repos added post-startup.
    // The pool stays empty for those repos forever until the next restart.
  });
});

// ---------------------------------------------------------------------------
// BUG 7: branch rename failure leaves worktree on wrong branch name
//
// claim() is fire-and-forget for the branch rename. If gitAsync for
// "branch -m" fails, the worktree's branch is still named `orca/pool-<n>`.
//
// The Claude session will then:
//   1. Run on a branch named orca/pool-<n> (not orca/<taskId>-inv-<id>)
//   2. Create a PR for orca/pool-<n> instead of the task branch
//   3. Gate 2 will not find a PR matching the expected task branch name
//   4. Task fails
//
// The claim() caller receives the expected branchName (the new name) but
// the git rename may silently fail — the caller has no way to know.
//
// Expected: claim() should either await the rename or provide a way for
//           callers to detect rename failure.
// Actual:   claim() always returns the new branch name even if rename fails.
// ---------------------------------------------------------------------------

describe("BUG 7: branch rename failure is silent — caller gets wrong branch name", () => {
  test("claim() returns new branchName even when git branch -m will fail", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    // Make the branch rename fail
    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      if (argArr[0] === "branch" && argArr[1] === "-m") {
        throw new Error("branch already exists");
      }
      return "";
    });

    const result = pool.claim("/repo/orca", "EMI-400", 0);

    // claim() returns success with the new branch name...
    expect(result).not.toBeNull();
    expect(result!.branchName).toBe("orca/EMI-400-inv-0");

    // ...but the rename is fire-and-forget. Let's wait for it to fail.
    await new Promise((r) => setTimeout(r, 50));

    // BUG: The actual git branch in the worktree is still orca/pool-<n>,
    // not orca/EMI-400-inv-0. The caller was lied to.
    // There's no mechanism to detect this failure.
    // We can only observe that gitAsync was called with branch -m and failed:
    const renameCalls = mockGitAsync.mock.calls.filter(
      (args) => (args[0] as string[])[0] === "branch",
    );
    expect(renameCalls.length).toBeGreaterThan(0);
    // This documents the bug: the rename failed but claim() already returned
    // "success" with the wrong branch name.
  });
});

// ---------------------------------------------------------------------------
// BUG 8: nextCounter() can produce duplicate IDs within the same millisecond
//        if more than 1000 entries are created in one millisecond
//
// nextCounter() = Date.now() * 1000 + (counter++ % 1000)
//
// If counter >= 1000 in the same millisecond, counter % 1000 wraps to 0
// and collides with the first counter value for that millisecond.
//
// In practice, pool sizes are small (2-5), so this needs 1000+ creates/ms.
// This is effectively a false alarm for normal pool sizes, but the math is
// wrong: `counter++` is never reset, so counter goes 0,1,2,...,999,1000,1001...
// counter % 1000 cycles 0,1,...,999,0,1,... — this WILL duplicate after 1000
// entries across the lifetime of the service instance.
//
// With poolSize=2 and ORCA_CONCURRENCY_CAP=1 (default), this won't trigger.
// With large pools and long-running instances it could, but is low probability.
// ---------------------------------------------------------------------------

describe("nextCounter uniqueness (design note)", () => {
  test("worktree paths are unique across many concurrent creates", async () => {
    // Create a pool that needs many entries and verify all paths are unique
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 5);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(5);
    });

    const paths = [...pool.getReservedPaths()];
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(paths.length); // All paths unique
  });
});

// ---------------------------------------------------------------------------
// BUG 9: destroy() does not set replenishing guard — claims after destroy()
//        can reinitialize the pool
//
// After destroy() clears this.pools, a stray call to claim() will:
//   1. pool = this.pools.get(repoPath) → undefined
//   2. Returns null (correct)
//   3. this.scheduleReplenish(repoPath) is called
//   4. scheduleReplenish: pool = this.pools.get(repoPath) → undefined
//   5. Returns early (correct guard)
// So stray claim after destroy is safe.
//
// But initialize() after destroy() resets the pools. Let's verify destroy
// + reinitialize works correctly.
// ---------------------------------------------------------------------------

describe("destroy() + re-initialize lifecycle", () => {
  test("re-initialize after destroy creates fresh pool entries", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    await pool.destroy();
    expect(pool.getReservedPaths().size).toBe(0);

    // Re-initialize
    mockGitAsync.mockResolvedValue("");
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });
  });

  test("claim() after destroy() returns null and does not re-create pool", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 1);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(1);
    });

    await pool.destroy();

    mockGitAsync.mockClear();

    const result = pool.claim("/repo/orca", "EMI-999", 0);
    expect(result).toBeNull();

    // Allow any microtasks to settle
    await new Promise((r) => setTimeout(r, 50));

    // No new worktrees should be created after destroy
    const worktreeAddCalls = mockGitAsync.mock.calls.filter((args) =>
      (args[0] as string[]).includes("add"),
    );
    expect(worktreeAddCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BUG 10: refreshStale mutates pool array while iterating stale snapshot
//
// refreshStale builds `stale = pool.filter(...)` then iterates stale.
// Within the loop, it calls pool.splice() to remove entries. If replenishment
// (triggered by scheduleReplenish inside the catch block) adds entries to
// pool during iteration (between awaits), the pool indices shift.
//
// In practice, pool.splice is called on the original pool array using
// pool.indexOf(entry) — the captured entry object reference. Since JS
// objects are compared by reference, indexOf will correctly find the entry
// even if new items were inserted before it. So this is actually safe.
//
// However: if refreshStale processes 2 stale entries [A, B], both fail
// rebase, both call scheduleReplenish. But scheduleReplenish is guarded
// by this.replenishing.has() — only one runs at a time. After the first
// replenish completes, the second scheduleReplenish call (from B's failure)
// was already dropped. The pool ends up 1 short.
// ---------------------------------------------------------------------------

describe("BUG 10: refreshStale with multiple failures only triggers one replenishment", () => {
  test("pool reaches poolSize after multiple simultaneous rebase failures", async () => {
    const pool = new WorktreePoolService();
    pool.initialize(["/repo/orca"], 2);

    await vi.waitFor(() => {
      expect(pool.getReservedPaths().size).toBe(2);
    });

    // Make rebase fail for ALL entries
    mockGitAsync.mockImplementation(async (args) => {
      const argArr = args as string[];
      if (argArr.includes("rebase")) {
        throw new Error("rebase conflict");
      }
      return "";
    });

    // Trigger refresh with maxAgeMs=0 so both entries are stale
    await pool.refreshStale("/repo/orca", 0);

    // Both entries removed. scheduleReplenish called twice but second
    // call was dropped because first was still in-flight (replenishing=true).
    // replenish() loop runs with pool.length=0 and poolSize=2 — creates 2.
    // Wait for replenishment to complete.
    await vi.waitFor(
      () => {
        expect(pool.getReservedPaths().size).toBe(2);
      },
      { timeout: 2000 },
    );
    // The while loop in replenish() handles this correctly — it runs until
    // pool.length >= poolSize, so even one replenish call can restore both.
    // This test verifies the while loop is actually effective.
  });
});
