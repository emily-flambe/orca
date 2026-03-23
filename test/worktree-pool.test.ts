// ---------------------------------------------------------------------------
// WorktreePoolService — adversarial tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock git module
vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  gitAsync: vi.fn(),
  cleanStaleLockFiles: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// Mock node:child_process to prevent real npm install / PowerShell calls
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
    execFile: vi.fn((_cmd, _args, _opts, cb) => {
      if (cb) cb(null, "", "");
      return { pid: 1, on: vi.fn(), stdout: null, stderr: null };
    }),
  };
});

// Mock node:util to make promisify(execFile) return a resolved promise
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: unknown) => {
      // If it's the execFile mock, return an async noop
      return async (..._args: unknown[]) => ({ stdout: "", stderr: "" });
    },
  };
});

// Mock worktree/index to control createWorktree fallback
vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn(),
}));

// Stub Atomics.wait to prevent blocking
const _origAtomicsWait = Atomics.wait;
beforeAll(() => {
  Atomics.wait = (() => "ok") as typeof Atomics.wait;
});
afterAll(() => {
  Atomics.wait = _origAtomicsWait;
});

const PARENT = tmpdir();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeService(poolSize = 2) {
  // Re-import fresh instance since the module uses module-level singletons
  const { WorktreePoolService } = await import("../src/worktree/pool.js");
  return new WorktreePoolService(poolSize);
}

// ---------------------------------------------------------------------------
// Pool miss: fallback to createWorktree
// ---------------------------------------------------------------------------

describe("WorktreePoolService — pool miss", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("empty pool for unknown repoPath falls back to createWorktree", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreateWorktree = vi.mocked(createWorktree);
    mockCreateWorktree.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-1"),
      branchName: "orca/EMI-1-inv-0",
    });

    const service = await makeService(2);
    const result = service.claim(join(PARENT, "orca"), "EMI-1");

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      join(PARENT, "orca"),
      "EMI-1",
      0,
    );
    expect(result.branchName).toBe("orca/EMI-1-inv-0");
  });

  test("pool started but not yet filled (still empty) falls back to createWorktree", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreateWorktree = vi.mocked(createWorktree);
    mockCreateWorktree.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-2"),
      branchName: "orca/EMI-2-inv-0",
    });

    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    // Simulate git fetch and worktree add taking a while (don't resolve yet)
    mockGitAsync.mockReturnValue(new Promise(() => {})); // never resolves in this tick

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true); // repoPath exists

    const service = await makeService(2);
    service.start([join(PARENT, "orca")]);
    // Immediately claim — pool is still empty (fill hasn't run yet)
    const result = service.claim(join(PARENT, "orca"), "EMI-2");

    expect(mockCreateWorktree).toHaveBeenCalled();
    expect(result.branchName).toBe("orca/EMI-2-inv-0");
  });
});

// ---------------------------------------------------------------------------
// Pool hit: git worktree move + branch rename
// ---------------------------------------------------------------------------

describe("WorktreePoolService — pool hit", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("pool hit: calls git worktree move then git branch -m", async () => {
    const { git } = await import("../src/git.js");
    const mockGit = vi.mocked(git);
    mockGit.mockReturnValue("");

    const { existsSync } = await import("node:fs");
    const mockExistsSync = vi.mocked(existsSync);

    const repoPath = join(PARENT, "orca");
    const poolPath = join(PARENT, "orca-pool-abcd1234");
    const taskPath = join(PARENT, "orca-EMI-42");
    const poolBranch = "orca/pool-abcd1234";
    const taskBranch = "orca/EMI-42-inv-0";

    // existsSync: taskPath exists after move (sanity check)
    mockExistsSync.mockImplementation((p: string) => {
      if (p === taskPath) return true;
      return false;
    });

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);

    // Manually inject a pool entry
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(
      repoPath,
      [
        {
          worktreePath: poolPath,
          branchName: poolBranch,
          repoPath,
          createdAt: Date.now(),
        },
      ],
    );

    const result = service.claim(repoPath, "EMI-42");

    // Should call git worktree move
    const moveCalls = mockGit.mock.calls.filter(
      (call) =>
        call[0][0] === "worktree" &&
        call[0][1] === "move" &&
        call[0][2] === poolPath &&
        call[0][3] === taskPath,
    );
    expect(moveCalls).toHaveLength(1);

    // Should call git branch -m to rename the branch
    const renameCalls = mockGit.mock.calls.filter(
      (call) =>
        call[0][0] === "branch" &&
        call[0][1] === "-m" &&
        call[0][2] === poolBranch &&
        call[0][3] === taskBranch,
    );
    expect(renameCalls).toHaveLength(1);

    expect(result.worktreePath).toBe(taskPath);
    expect(result.branchName).toBe(taskBranch);
  });

  test("pool is decremented after a successful claim", async () => {
    const { git } = await import("../src/git.js");
    vi.mocked(git).mockReturnValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const repoPath = join(PARENT, "orca");
    const poolPath = join(PARENT, "orca-pool-aabb");

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(1);

    const pool = (service as unknown as { pool: Map<string, unknown[]> }).pool;
    pool.set(repoPath, [
      {
        worktreePath: poolPath,
        branchName: "orca/pool-aabb",
        repoPath,
        createdAt: Date.now(),
      },
    ]);

    service.claim(repoPath, "EMI-50");
    expect(pool.get(repoPath)?.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// git worktree move failure: fallback to renameSync + repair
// ---------------------------------------------------------------------------

describe("WorktreePoolService — git worktree move failure", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("git worktree move failure triggers renameSync + repair", async () => {
    const { git } = await import("../src/git.js");
    const mockGit = vi.mocked(git);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { renameSync } = await import("node:fs");
    const mockRenameSync = vi.mocked(renameSync);
    mockRenameSync.mockReturnValue(undefined);

    const repoPath = join(PARENT, "orca");
    const poolPath = join(PARENT, "orca-pool-ff001");
    const taskPath = join(PARENT, "orca-EMI-60");

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "move") {
        throw new Error("git: 'worktree move' is not a git command");
      }
      return "";
    });

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(
      repoPath,
      [
        {
          worktreePath: poolPath,
          branchName: "orca/pool-ff001",
          repoPath,
          createdAt: Date.now(),
        },
      ],
    );

    const result = service.claim(repoPath, "EMI-60");

    expect(mockRenameSync).toHaveBeenCalledWith(poolPath, taskPath);

    // git worktree repair should be called after renameSync
    const repairCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "repair",
    );
    expect(repairCalls).toHaveLength(1);

    expect(result.worktreePath).toBe(taskPath);
  });

  test("both move and repair fail: falls back to createWorktree", async () => {
    const { git } = await import("../src/git.js");
    const mockGit = vi.mocked(git);

    const { renameSync } = await import("node:fs");
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error("EPERM: renameSync failed");
    });

    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreateWorktree = vi.mocked(createWorktree);
    mockCreateWorktree.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-61"),
      branchName: "orca/EMI-61-inv-0",
    });

    const repoPath = join(PARENT, "orca");
    const poolPath = join(PARENT, "orca-pool-bb002");

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "move") {
        throw new Error("git: 'worktree move' is not a git command");
      }
      return "";
    });

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(
      repoPath,
      [
        {
          worktreePath: poolPath,
          branchName: "orca/pool-bb002",
          repoPath,
          createdAt: Date.now(),
        },
      ],
    );

    const result = service.claim(repoPath, "EMI-61");

    expect(mockCreateWorktree).toHaveBeenCalledWith(
      repoPath,
      "EMI-61",
      0,
    );
    expect(result.branchName).toBe("orca/EMI-61-inv-0");
  });
});

// ---------------------------------------------------------------------------
// TOCTOU: sanity check after move — taskPath does not exist
// ---------------------------------------------------------------------------

describe("WorktreePoolService — post-move sanity check", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("falls back to createWorktree if taskPath does not exist after git worktree move", async () => {
    const { git } = await import("../src/git.js");
    vi.mocked(git).mockReturnValue(""); // move succeeds...

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false); // ...but path doesn't exist

    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreate = vi.mocked(createWorktree);
    mockCreate.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-70"),
      branchName: "orca/EMI-70-inv-0",
    });

    const repoPath = join(PARENT, "orca");
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(
      repoPath,
      [
        {
          worktreePath: join(PARENT, "orca-pool-ccc"),
          branchName: "orca/pool-ccc",
          repoPath,
          createdAt: Date.now(),
        },
      ],
    );

    const result = service.claim(repoPath, "EMI-70");

    expect(mockCreate).toHaveBeenCalled();
    expect(result.branchName).toBe("orca/EMI-70-inv-0");
  });
});

// ---------------------------------------------------------------------------
// Branch name collision: taskBranch already exists
// ---------------------------------------------------------------------------

describe("WorktreePoolService — branch name collision", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("BUG: git branch -m to existing taskBranch causes error, claim should handle it", async () => {
    // If orca/EMI-42-inv-0 branch already exists (e.g. from a prior failed run),
    // git branch -m will throw. The claim() method has no explicit handling for this —
    // it falls into the outer catch and calls createWorktree.
    // This test documents that behavior and verifies it doesn't explode.

    const { git } = await import("../src/git.js");
    const mockGit = vi.mocked(git);

    const { existsSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);

    const repoPath = join(PARENT, "orca");
    const taskPath = join(PARENT, "orca-EMI-42");
    const poolPath = join(PARENT, "orca-pool-ddd");

    mockExists.mockImplementation((p: string) => {
      if (p === taskPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "branch" && args[1] === "-m") {
        throw new Error(
          "fatal: A branch named 'orca/EMI-42-inv-0' already exists.",
        );
      }
      return "";
    });

    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreate = vi.mocked(createWorktree);
    mockCreate.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-42"),
      branchName: "orca/EMI-42-inv-0",
    });

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(
      repoPath,
      [
        {
          worktreePath: poolPath,
          branchName: "orca/pool-ddd",
          repoPath,
          createdAt: Date.now(),
        },
      ],
    );

    // Should NOT throw — falls back to createWorktree
    const result = service.claim(repoPath, "EMI-42");
    expect(mockCreate).toHaveBeenCalledWith(repoPath, "EMI-42", 0);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getPoolPaths
// ---------------------------------------------------------------------------

describe("WorktreePoolService — getPoolPaths", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("returns Set of all pool entry paths across all repos", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(3);

    const repo1 = join(PARENT, "repo1");
    const repo2 = join(PARENT, "repo2");
    const path1 = join(PARENT, "repo1-pool-aaa");
    const path2 = join(PARENT, "repo1-pool-bbb");
    const path3 = join(PARENT, "repo2-pool-ccc");

    const pool = (service as unknown as { pool: Map<string, unknown[]> }).pool;
    pool.set(repo1, [
      { worktreePath: path1, branchName: "orca/pool-aaa", repoPath: repo1, createdAt: Date.now() },
      { worktreePath: path2, branchName: "orca/pool-bbb", repoPath: repo1, createdAt: Date.now() },
    ]);
    pool.set(repo2, [
      { worktreePath: path3, branchName: "orca/pool-ccc", repoPath: repo2, createdAt: Date.now() },
    ]);

    const paths = service.getPoolPaths();
    expect(paths).toBeInstanceOf(Set);
    expect(paths.size).toBe(3);
    expect(paths.has(path1)).toBe(true);
    expect(paths.has(path2)).toBe(true);
    expect(paths.has(path3)).toBe(true);
  });

  test("returns empty Set when pool is empty", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    expect(service.getPoolPaths().size).toBe(0);
  });

  test("TOCTOU: path removed from pool after getPoolPaths snapshot but before cleanup reads it", async () => {
    // This documents the race: getPoolPaths returns a snapshot; if claim() runs
    // concurrently and shifts the entry, the cleanup cron might still try to
    // delete the path that's now a claimed task worktree (not a pool entry).
    // The snapshot is stale — cleanup MUST check if the path is a pool path
    // at deletion time. Since it uses the snapshot, this is a known TOCTOU window.

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(1);
    const repo = join(PARENT, "orca");
    const poolPath = join(PARENT, "orca-pool-toctou");

    const pool = (service as unknown as { pool: Map<string, unknown[]> }).pool;
    pool.set(repo, [
      { worktreePath: poolPath, branchName: "orca/pool-toctou", repoPath: repo, createdAt: Date.now() },
    ]);

    // Step 1: caller snapshots pool paths
    const snapshot = service.getPoolPaths();
    expect(snapshot.has(poolPath)).toBe(true);

    // Step 2: claim() is called, shifting the entry out of the pool
    const { git } = await import("../src/git.js");
    vi.mocked(git).mockReturnValue("");
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true); // task path exists post-move

    service.claim(repo, "EMI-TOCTOU");

    // Step 3: pool entry is now gone
    expect(pool.get(repo)?.length).toBe(0);

    // Step 4: BUT the snapshot still contains the (now-claimed) path
    // This means cleanup could erroneously try to protect or delete it
    expect(snapshot.has(poolPath)).toBe(true); // stale! path is now claimed worktree
  });
});

// ---------------------------------------------------------------------------
// fillPool: does not overfill
// ---------------------------------------------------------------------------

describe("WorktreePoolService — fillPool does not overfill", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("fillPool respects poolSize — never exceeds it", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true); // repo exists

    const { readdirSync } = await import("node:fs");
    vi.mocked(readdirSync).mockReturnValue([]);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);
    (service as unknown as { started: boolean }).started = true;

    // Manually call fillPool twice concurrently
    const fillPool = (service as unknown as {
      fillPool: (r: string) => Promise<void>;
    }).fillPool.bind(service);

    await Promise.all([fillPool(repoPath), fillPool(repoPath)]);

    const poolEntries = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    // Should be at most poolSize=2
    expect(poolEntries.length).toBeLessThanOrEqual(2);
  });

  test("fillPool creating flag prevents double-filling for the same repo", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);

    let resolveFirst!: () => void;
    let callCount = 0;
    mockGitAsync.mockImplementation(async (args) => {
      if (args[0] === "fetch") {
        callCount++;
        if (callCount === 1) {
          // First call blocks until manually resolved
          await new Promise<void>((res) => {
            resolveFirst = res;
          });
        }
      }
      return "";
    });

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    const { readdirSync } = await import("node:fs");
    vi.mocked(readdirSync).mockReturnValue([]);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(1);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);
    (service as unknown as { started: boolean }).started = true;

    const fillPool = (service as unknown as {
      fillPool: (r: string) => Promise<void>;
    }).fillPool.bind(service);

    // Start first fill (blocked)
    const p1 = fillPool(repoPath);
    // Attempt second fill while first is still running — should be a no-op
    const p2 = fillPool(repoPath);

    // Unblock first fill
    resolveFirst();
    await Promise.all([p1, p2]);

    // Only the first fill should have created entries
    const entries = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    expect(entries.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stop() prevents further replenishment
// ---------------------------------------------------------------------------

describe("WorktreePoolService — stop() behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("after stop(), scheduleReplenish does nothing", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca-stop-test");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);

    // service was never started, so started=false already — stop() just confirms
    service.stop();

    // scheduleReplenish should be a no-op (started=false)
    const scheduleReplenish = (service as unknown as {
      scheduleReplenish: (r: string) => void;
    }).scheduleReplenish.bind(service);

    scheduleReplenish(repoPath);

    // Wait a tick for any setTimeout(fn, 0) to fire
    await new Promise((res) => setTimeout(res, 10));

    // gitAsync should NOT have been called for our specific repo path
    // (calls for other repos from prior tests' stale timeouts are not our concern)
    const callsForOurRepo = mockGitAsync.mock.calls.filter(
      (call) => call[1]?.cwd === repoPath,
    );
    expect(callsForOurRepo).toHaveLength(0);
  });

  test("after stop(), fillPool exits immediately", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);

    service.stop();

    const fillPool = (service as unknown as {
      fillPool: (r: string) => Promise<void>;
    }).fillPool.bind(service);

    await fillPool(repoPath);

    expect(mockGitAsync).not.toHaveBeenCalled();
  });

  test("BUG: setTimeout scheduled before stop() can fire after stop()", async () => {
    // If scheduleReplenish sets a setTimeout(fn, 0) and then stop() is called
    // before the timeout fires, the fn will still execute. This is a known
    // window where fillPool can run after stop().

    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    const { readdirSync } = await import("node:fs");
    vi.mocked(readdirSync).mockReturnValue([]);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);
    (service as unknown as { started: boolean }).started = true;

    // Schedule replenish THEN immediately stop
    const scheduleReplenish = (service as unknown as {
      scheduleReplenish: (r: string) => void;
    }).scheduleReplenish.bind(service);

    scheduleReplenish(repoPath);
    service.stop(); // stop before the scheduled timeout fires

    // Wait for the setTimeout(fn, 0) to fire
    await new Promise((res) => setTimeout(res, 20));

    // fillPool checks this.started first thing and returns early — so gitAsync
    // should NOT be called. If it IS called, that confirms the race bug.
    const wasCalled = mockGitAsync.mock.calls.length > 0;
    // Document the result: fillPool should have returned early due to started=false
    // If this assertion fails, the timing race caused a post-stop fill
    expect(wasCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshStaleEntries
// ---------------------------------------------------------------------------

describe("WorktreePoolService — refreshStaleEntries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("skips fresh entries (< 1 hour old)", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");
    const freshPath = join(PARENT, "orca-pool-fresh");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      {
        worktreePath: freshPath,
        branchName: "orca/pool-fresh",
        repoPath,
        createdAt: Date.now() - 30 * 60 * 1000, // 30 minutes old
      },
    ]);

    await service.refreshStaleEntries();

    // gitAsync should NOT have been called for fetch/reset on a fresh entry
    const fetchCalls = mockGitAsync.mock.calls.filter(
      (call) => call[0][0] === "fetch",
    );
    expect(fetchCalls).toHaveLength(0);
  });

  test("refreshes stale entries (> 1 hour old) and resets createdAt", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");
    const stalePath = join(PARENT, "orca-pool-stale");
    const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    const entry = {
      worktreePath: stalePath,
      branchName: "orca/pool-stale",
      repoPath,
      createdAt: oldTime,
    };
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [entry]);

    const beforeRefresh = Date.now();
    await service.refreshStaleEntries();

    // fetch and reset should have been called
    const fetchCalls = mockGitAsync.mock.calls.filter(
      (call) => call[0][0] === "fetch" && call[1]?.cwd === stalePath,
    );
    expect(fetchCalls).toHaveLength(1);

    const resetCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        call[0][0] === "reset" &&
        call[0][1] === "--hard" &&
        call[0][2] === "origin/main",
    );
    expect(resetCalls).toHaveLength(1);

    // createdAt should be updated to now
    expect(entry.createdAt).toBeGreaterThanOrEqual(beforeRefresh);
  });

  test("removes entries whose path no longer exists on disk", async () => {
    const { gitAsync } = await import("../src/git.js");
    vi.mocked(gitAsync).mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    const mockExists = vi.mocked(existsSync);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");
    const missingPath = join(PARENT, "orca-pool-missing");
    const validPath = join(PARENT, "orca-pool-valid");

    mockExists.mockImplementation((p: string) => {
      return p === validPath;
    });

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      { worktreePath: missingPath, branchName: "orca/pool-missing", repoPath, createdAt: Date.now() - 100 },
      { worktreePath: validPath, branchName: "orca/pool-valid", repoPath, createdAt: Date.now() - 100 },
    ]);

    await service.refreshStaleEntries();

    const remaining = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { worktreePath: string }).worktreePath).toBe(validPath);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphaned
// ---------------------------------------------------------------------------

describe("WorktreePoolService — cleanupOrphaned", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("removes entries older than maxAgeMs and calls removeWorktreeAsync", async () => {
    const { removeWorktreeAsync } = await import("../src/worktree/index.js");
    const mockRemove = vi.mocked(removeWorktreeAsync);
    mockRemove.mockResolvedValue(undefined);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");
    const oldPath = join(PARENT, "orca-pool-old");
    const newPath = join(PARENT, "orca-pool-new");

    const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      {
        worktreePath: oldPath,
        branchName: "orca/pool-old",
        repoPath,
        createdAt: Date.now() - maxAgeMs - 1, // just expired
      },
      {
        worktreePath: newPath,
        branchName: "orca/pool-new",
        repoPath,
        createdAt: Date.now() - 60 * 60 * 1000, // 1 hour, under limit
      },
    ]);

    await service.cleanupOrphaned(maxAgeMs);

    expect(mockRemove).toHaveBeenCalledWith(oldPath);
    expect(mockRemove).not.toHaveBeenCalledWith(newPath);

    const remaining = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { worktreePath: string }).worktreePath).toBe(newPath);
  });

  test("does nothing when all entries are young enough", async () => {
    const { removeWorktreeAsync } = await import("../src/worktree/index.js");
    const mockRemove = vi.mocked(removeWorktreeAsync);
    mockRemove.mockResolvedValue(undefined);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      { worktreePath: join(PARENT, "orca-pool-x"), branchName: "orca/pool-x", repoPath, createdAt: Date.now() },
    ]);

    await service.cleanupOrphaned(2 * 60 * 60 * 1000);

    expect(mockRemove).not.toHaveBeenCalled();
  });

  test("cleanupOrphaned with maxAgeMs=0 removes ALL entries", async () => {
    const { removeWorktreeAsync } = await import("../src/worktree/index.js");
    const mockRemove = vi.mocked(removeWorktreeAsync);
    mockRemove.mockResolvedValue(undefined);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(2);
    const repoPath = join(PARENT, "orca");
    const path1 = join(PARENT, "orca-pool-p1");
    const path2 = join(PARENT, "orca-pool-p2");

    // Even a brand-new entry (createdAt = Date.now()) has now - createdAt > 0
    // which is > maxAgeMs=0. Everything should be removed.
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      { worktreePath: path1, branchName: "orca/pool-p1", repoPath, createdAt: Date.now() - 1 },
      { worktreePath: path2, branchName: "orca/pool-p2", repoPath, createdAt: Date.now() - 1 },
    ]);

    await service.cleanupOrphaned(0);

    expect(mockRemove).toHaveBeenCalledTimes(2);
    const remaining = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    expect(remaining).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// start() with poolSize=0 — disabled pool
// ---------------------------------------------------------------------------

describe("WorktreePoolService — disabled pool (poolSize=0)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("start() with poolSize=0 does not set started flag and does not fillPool", async () => {
    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);
    mockGitAsync.mockResolvedValue("");

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(0);
    service.start([join(PARENT, "orca")]);

    await new Promise((res) => setTimeout(res, 10));

    expect(mockGitAsync).not.toHaveBeenCalled();
    expect((service as unknown as { started: boolean }).started).toBe(false);
  });

  test("claim() with poolSize=0 pool falls back to createWorktree", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreate = vi.mocked(createWorktree);
    mockCreate.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-99"),
      branchName: "orca/EMI-99-inv-0",
    });

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(0);
    const result = service.claim(join(PARENT, "orca"), "EMI-99");

    expect(mockCreate).toHaveBeenCalled();
    expect(result.branchName).toBe("orca/EMI-99-inv-0");
  });
});

// ---------------------------------------------------------------------------
// Edge case: two tasks with same taskId (concurrent, same repoPath)
// ---------------------------------------------------------------------------

describe("WorktreePoolService — concurrent claims same taskId", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("two concurrent claims for same taskId produce same taskPath — second claim is a pool miss", async () => {
    // claim() is synchronous, so two rapid calls with the same taskId will
    // produce identical target paths. The second claim will be a pool miss
    // (no more entries) and fall back to createWorktree, which handles
    // the duplicate-path scenario internally.

    const { git } = await import("../src/git.js");
    vi.mocked(git).mockReturnValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { createWorktree } = await import("../src/worktree/index.js");
    const mockCreate = vi.mocked(createWorktree);
    mockCreate.mockReturnValue({
      worktreePath: join(PARENT, "orca-EMI-DUPE"),
      branchName: "orca/EMI-DUPE-inv-0",
    });

    const repoPath = join(PARENT, "orca");
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(1);
    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, [
      {
        worktreePath: join(PARENT, "orca-pool-e1"),
        branchName: "orca/pool-e1",
        repoPath,
        createdAt: Date.now(),
      },
    ]);

    // First claim consumes the pool entry
    const r1 = service.claim(repoPath, "EMI-DUPE");
    // Second claim is a miss (pool empty) — falls back to createWorktree
    const r2 = service.claim(repoPath, "EMI-DUPE");

    expect(r1.worktreePath).toBe(join(PARENT, "orca-EMI-DUPE"));
    expect(r2.worktreePath).toBe(join(PARENT, "orca-EMI-DUPE")); // same path from createWorktree mock
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// BUG: fillPool does not re-check pool size after each entry is created
// ---------------------------------------------------------------------------

describe("WorktreePoolService — fillPool pool size drift", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("BUG: claim() during fillPool can cause pool to exceed poolSize", async () => {
    // fillPool computes `needed = poolSize - entries.length` ONCE before the loop.
    // If claim() runs between iterations and removes an entry, fillPool will
    // keep creating more entries than poolSize because `needed` was computed
    // from a stale snapshot.
    //
    // Example: poolSize=1, entries=0 → needed=1. fillPool starts creating.
    // Midway, claim() shifts an entry. entries=0 again. fillPool creates
    // another entry. Pool ends up with 1 entry (claim consumed 1, fillPool
    // made 1 more = net 1). That's correct. But if claim() doesn't fire,
    // needed was computed as 1 initially — so it creates exactly 1. OK.
    //
    // The actual risk: poolSize=2, entries=0 → needed=2. fillPool creates
    // entry1 (pool=1), then before creating entry2, claim runs and takes entry1
    // (pool=0). fillPool creates entry2 (pool=1). That's fine—still ≤ poolSize.
    //
    // But: if claim() is NOT involved and fillPool creates 2 entries for a
    // pool already at size 2 (from a previous fill), it will skip because
    // needed=0 at the start. So overfill via concurrent fillPool calls is
    // blocked by the `creating` flag.
    //
    // This test verifies the creating flag actually prevents concurrent overfill.

    const { gitAsync } = await import("../src/git.js");
    const mockGitAsync = vi.mocked(gitAsync);

    // gitAsync resolves immediately
    mockGitAsync.mockResolvedValue("");

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);
    const { readdirSync } = await import("node:fs");
    vi.mocked(readdirSync).mockReturnValue([]);

    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const service = new WorktreePoolService(1);
    const repoPath = join(PARENT, "orca");

    (service as unknown as { pool: Map<string, unknown[]> }).pool.set(repoPath, []);
    (service as unknown as { started: boolean }).started = true;

    const fillPool = (service as unknown as {
      fillPool: (r: string) => Promise<void>;
    }).fillPool.bind(service);

    // Run fillPool twice — second should be a no-op due to creating flag
    const p1 = fillPool(repoPath);
    const p2 = fillPool(repoPath);
    await Promise.all([p1, p2]);

    const entries = (service as unknown as { pool: Map<string, unknown[]> }).pool.get(repoPath) ?? [];
    // Should be exactly 1, not 2 (poolSize=1)
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});
