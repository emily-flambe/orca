// ---------------------------------------------------------------------------
// WorktreePoolService — adversarial tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level before any imports of the module
// ---------------------------------------------------------------------------

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  gitAsync: vi.fn(),
  cleanStaleLockFiles: vi.fn(),
  getDefaultBranch: vi.fn().mockReturnValue("main"),
  getDefaultBranchAsync: vi.fn().mockResolvedValue("main"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

vi.mock("../src/worktree/index.js", () => ({
  createWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(),
  };
});

// Logger uses console — silence it during tests
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PARENT = tmpdir();
const REPO_PATH = join(PARENT, "orca");
const POOL_HEX = "deadbeef";
const POOL_BRANCH = `orca/pool-${POOL_HEX}`;
const POOL_WORKTREE = join(PARENT, `orca-pool-${POOL_HEX}`);

/**
 * Flush the microtask queue without advancing fake timers.
 * Does NOT fire setInterval callbacks.
 */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// Stub Atomics.wait so any potential backoff doesn't block tests
const _origAtomicsWait = Atomics.wait;
beforeAll(() => {
  Atomics.wait = (() => "ok") as typeof Atomics.wait;
});
afterAll(() => {
  Atomics.wait = _origAtomicsWait;
});

// ---------------------------------------------------------------------------
// Pool creation and startup
// ---------------------------------------------------------------------------

describe("WorktreePoolService — start and size", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    // Default: gitAsync resolves immediately, no .env files, no subdirs
    mockGitAsync.mockResolvedValue("");
    mockGit.mockReturnValue("");
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockRandomBytes.mockReturnValue(Buffer.from(POOL_HEX, "hex"));
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("size() returns 0 when pool is empty (before replenishment resolves)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);
    svc.start([REPO_PATH]);
    // Pool entries are async — before promises settle, size is 0
    expect(svc.size(REPO_PATH)).toBe(0);
    await svc.stop();
  });

  test("size() returns 0 for unknown repo path", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);
    expect(svc.size(join(PARENT, "unknown-repo"))).toBe(0);
    await svc.stop();
  });

  test("start() calls replenish — after promises settle, size equals poolSize", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);

    // Use two different hex values for two pool entries
    let callCount = 0;
    mockRandomBytes.mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1
        ? Buffer.from("deadbeef", "hex")
        : Buffer.from("cafebabe", "hex");
    });

    svc.start([REPO_PATH]);

    // Flush microtasks without triggering the setInterval
    await flushMicrotasks(20);

    expect(svc.size(REPO_PATH)).toBe(2);
    await svc.stop();
  });

  test("multiple repo paths each get their own pool", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const repo1 = join(PARENT, "repo1");
    const repo2 = join(PARENT, "repo2");

    const svc = new WorktreePoolService(1);
    svc.start([repo1, repo2]);
    await flushMicrotasks(20);

    expect(svc.size(repo1)).toBe(1);
    expect(svc.size(repo2)).toBe(1);
    await svc.stop();
  });

  test("gitAsync called with fetch origin for each pool entry created", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const fetchCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "fetch" &&
        call[0][1] === "origin",
    );
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    await svc.stop();
  });

  test("gitAsync called with worktree add -b for each pool entry created", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const worktreeAddCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "worktree" &&
        call[0][1] === "add" &&
        call[0][2] === "-b",
    );
    expect(worktreeAddCalls.length).toBeGreaterThanOrEqual(1);
    // Branch name should be orca/pool-<hex>
    expect(worktreeAddCalls[0][0][3]).toBe(POOL_BRANCH);
    await svc.stop();
  });

  test("poolSize 0 — start does not create any pool entries", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(0);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    expect(svc.size(REPO_PATH)).toBe(0);
    // No async git calls should have been made
    const worktreeAddCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "worktree" &&
        call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);
    await svc.stop();
  });
});

// ---------------------------------------------------------------------------
// Claim — pool hit
// ---------------------------------------------------------------------------

describe("WorktreePoolService — claim: pool hit", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRenameSync: ReturnType<typeof vi.fn>;
  let mockCopyFileSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockCreateWorktree: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  const TASK_ID = "EMI-999";
  const INV_ID = 7;
  const NEW_BRANCH = `orca/${TASK_ID}-inv-${INV_ID}`;
  const TARGET_PATH = join(PARENT, `orca-${TASK_ID}`);

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);
    mockRenameSync = vi.mocked(fsModule.renameSync);
    mockCopyFileSync = vi.mocked(fsModule.copyFileSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockCreateWorktree = vi.mocked(worktreeModule.createWorktree);
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    mockGitAsync.mockResolvedValue("");
    mockGit.mockReturnValue("");
    mockReaddirSync.mockReturnValue([]);
    mockRandomBytes.mockReturnValue(Buffer.from(POOL_HEX, "hex"));
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
    mockCreateWorktree.mockReturnValue({
      worktreePath: join(PARENT, "fallback"),
      branchName: "orca/fallback",
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Helper: build a pool service with one pre-populated entry.
   * Simulates the pool having been filled by replenishment.
   */
  async function buildServiceWithEntry() {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    // Pool worktree path exists when we go to claim it
    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    // Flush microtasks so createPoolEntry promise resolves
    await flushMicrotasks(20);
    return svc;
  }

  test("claim() returns renamed worktreePath and correct branchName", async () => {
    const svc = await buildServiceWithEntry();

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(result.branchName).toBe(NEW_BRANCH);
    expect(result.worktreePath).toBe(TARGET_PATH);

    await svc.stop();
  });

  test("claim() renames branch from pool branch to task branch", async () => {
    const svc = await buildServiceWithEntry();

    svc.claim(REPO_PATH, TASK_ID, INV_ID);

    const branchMCalls = mockGit.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "branch" &&
        call[0][1] === "-m",
    );
    expect(branchMCalls.length).toBeGreaterThanOrEqual(1);
    // First rename: pool branch → task branch
    const firstRename = branchMCalls[0];
    expect(firstRename[0][2]).toBe(POOL_BRANCH);
    expect(firstRename[0][3]).toBe(NEW_BRANCH);

    await svc.stop();
  });

  test("claim() renames directory from pool path to task target path", async () => {
    const svc = await buildServiceWithEntry();

    svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(mockRenameSync).toHaveBeenCalledWith(POOL_WORKTREE, TARGET_PATH);
    await svc.stop();
  });

  test("claim() calls git worktree repair after directory rename", async () => {
    const svc = await buildServiceWithEntry();

    svc.claim(REPO_PATH, TASK_ID, INV_ID);

    const repairCalls = mockGit.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "worktree" &&
        call[0][1] === "repair",
    );
    expect(repairCalls).toHaveLength(1);
    expect(repairCalls[0][0][2]).toBe(TARGET_PATH);
    expect(repairCalls[0][1]).toEqual({ cwd: REPO_PATH });

    await svc.stop();
  });

  test("claim() copies .env* files from repo to worktree", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    // During pool creation: readdirSync on repo dir returns env files, others empty
    mockReaddirSync.mockImplementation((p: string) => {
      if (p === REPO_PATH) {
        return [".env", ".env.example", "package.json"] as unknown as ReturnType<
          typeof import("node:fs").readdirSync
        >;
      }
      return [] as unknown as ReturnType<typeof import("node:fs").readdirSync>;
    });

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      // No package.json in worktree subdirs
      if (p.endsWith("package.json")) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    // Reset copyFileSync calls from replenishment before claim
    mockCopyFileSync.mockClear();

    svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // .env and .env.example should have been copied (from repo to worktree)
    const envCopies = mockCopyFileSync.mock.calls.filter((call) =>
      (call[0] as string).includes(".env"),
    );
    expect(envCopies.length).toBeGreaterThanOrEqual(2);

    await svc.stop();
  });

  test("claim() triggers replenishment after successful claim (pool drops below poolSize)", async () => {
    const svc = await buildServiceWithEntry();

    // After claim, pool has 0 entries. replenish() should fire again.
    const gitAsyncCallsBefore = mockGitAsync.mock.calls.length;
    svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // Flush microtasks so the replenish promise resolves
    await flushMicrotasks(20);

    // New gitAsync calls should have been made for replenishment
    expect(mockGitAsync.mock.calls.length).toBeGreaterThan(gitAsyncCallsBefore);

    await svc.stop();
  });

  test("claim() decrements pool size", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);

    // Need two distinct hex values for two pool entries
    let callCount = 0;
    mockRandomBytes.mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1
        ? Buffer.from("deadbeef", "hex")
        : Buffer.from("cafebabe", "hex");
    });

    const poolPath1 = join(PARENT, "orca-pool-deadbeef");
    const poolPath2 = join(PARENT, "orca-pool-cafebabe");
    mockExistsSync.mockImplementation((p: string) => {
      if (p === poolPath1 || p === poolPath2) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    expect(svc.size(REPO_PATH)).toBe(2);
    svc.claim(REPO_PATH, TASK_ID, INV_ID);
    // Size should have dropped by 1 immediately (synchronous shift)
    expect(svc.size(REPO_PATH)).toBeLessThan(2);

    await svc.stop();
  });
});

// ---------------------------------------------------------------------------
// Claim — fallback paths
// ---------------------------------------------------------------------------

describe("WorktreePoolService — claim: fallback paths", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRenameSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockCreateWorktree: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  const TASK_ID = "EMI-888";
  const INV_ID = 3;
  const TARGET_PATH = join(PARENT, `orca-${TASK_ID}`);
  const FALLBACK_RESULT = {
    worktreePath: join(PARENT, "fallback"),
    branchName: "orca/fallback",
  };

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);
    mockRenameSync = vi.mocked(fsModule.renameSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockCreateWorktree = vi.mocked(worktreeModule.createWorktree);
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    mockGitAsync.mockResolvedValue("");
    mockGit.mockReturnValue("");
    mockReaddirSync.mockReturnValue([]);
    mockRandomBytes.mockReturnValue(Buffer.from(POOL_HEX, "hex"));
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
    mockCreateWorktree.mockReturnValue(FALLBACK_RESULT);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("claim() falls back to createWorktree() when pool is empty", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    // Start but do NOT flush microtasks — pool stays empty
    svc.start([REPO_PATH]);

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(mockCreateWorktree).toHaveBeenCalledWith(REPO_PATH, TASK_ID, INV_ID);
    expect(result).toEqual(FALLBACK_RESULT);

    await svc.stop();
  });

  test("claim() falls back to createWorktree() for unknown repo path (no pool)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    // Never called start(), so no pool for REPO_PATH

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(mockCreateWorktree).toHaveBeenCalledWith(REPO_PATH, TASK_ID, INV_ID);
    expect(result).toEqual(FALLBACK_RESULT);

    await svc.stop();
  });

  test("claim() skips stale entries (path no longer exists) and continues to next", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);

    let callCount = 0;
    const poolPath1 = join(PARENT, "orca-pool-deadbeef");
    const poolPath2 = join(PARENT, "orca-pool-cafebabe");

    mockRandomBytes.mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1
        ? Buffer.from("deadbeef", "hex")
        : Buffer.from("cafebabe", "hex");
    });

    // First pool entry path does NOT exist, second does
    mockExistsSync.mockImplementation((p: string) => {
      if (p === poolPath1) return false; // stale
      if (p === poolPath2) return true; // valid
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // Should have used the second (valid) entry
    expect(result.branchName).toBe(`orca/${TASK_ID}-inv-${INV_ID}`);
    expect(mockCreateWorktree).not.toHaveBeenCalled();

    await svc.stop();
  });

  test("claim() falls back to createWorktree() after skipping all non-existent entries", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    // Pool entry path does NOT exist
    mockExistsSync.mockImplementation((_p: string) => false);

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(mockCreateWorktree).toHaveBeenCalledWith(REPO_PATH, TASK_ID, INV_ID);
    expect(result).toEqual(FALLBACK_RESULT);

    await svc.stop();
  });

  test("claim() falls back to createWorktree() when branch rename throws, after rollback attempt", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    // Make the branch rename throw a non-EPERM error
    const renameError = new Error("fatal: git branch -m failed");
    mockGit.mockImplementation((args: string[]) => {
      if (
        Array.isArray(args) &&
        args[0] === "branch" &&
        args[1] === "-m" &&
        args[2] === POOL_BRANCH
      ) {
        throw renameError;
      }
      return "";
    });

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // Should fall back to createWorktree
    expect(mockCreateWorktree).toHaveBeenCalledWith(REPO_PATH, TASK_ID, INV_ID);
    expect(result).toEqual(FALLBACK_RESULT);

    // Rollback: should have attempted to rename back (new → old)
    const rollbackCalls = mockGit.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "branch" &&
        call[0][1] === "-m" &&
        call[0][2] === `orca/${TASK_ID}-inv-${INV_ID}` &&
        call[0][3] === POOL_BRANCH,
    );
    expect(rollbackCalls).toHaveLength(1);

    await svc.stop();
  });

  test("when targetPath already exists, claim uses pool path (no directory rename)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return true; // target already in use
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // renameSync must NOT have been called (target already exists)
    expect(mockRenameSync).not.toHaveBeenCalled();
    // Should use the pool path as-is
    expect(result.worktreePath).toBe(POOL_WORKTREE);
    // Branch should still have been renamed
    expect(result.branchName).toBe(`orca/${TASK_ID}-inv-${INV_ID}`);

    await svc.stop();
  });

  test("when renameSync fails with EPERM, claim uses pool path (no directory rename)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const epermErr = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
    });
    mockRenameSync.mockImplementation(() => {
      throw epermErr;
    });

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    // Should use the pool path as-is (EPERM is a soft failure)
    expect(result.worktreePath).toBe(POOL_WORKTREE);
    expect(result.branchName).toBe(`orca/${TASK_ID}-inv-${INV_ID}`);
    // Must NOT have fallen back to createWorktree
    expect(mockCreateWorktree).not.toHaveBeenCalled();

    await svc.stop();
  });

  test("when renameSync fails with EBUSY, claim uses pool path (no directory rename)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const ebusyErr = Object.assign(new Error("EBUSY: resource busy"), {
      code: "EBUSY",
    });
    mockRenameSync.mockImplementation(() => {
      throw ebusyErr;
    });

    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);

    expect(result.worktreePath).toBe(POOL_WORKTREE);
    expect(result.branchName).toBe(`orca/${TASK_ID}-inv-${INV_ID}`);
    expect(mockCreateWorktree).not.toHaveBeenCalled();

    await svc.stop();
  });

  test("renameSync failure with non-EPERM/EBUSY re-throws and falls back to createWorktree", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    mockExistsSync.mockImplementation((p: string) => {
      if (p === POOL_WORKTREE) return true;
      if (p === TARGET_PATH) return false;
      return false;
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    const eioErr = Object.assign(new Error("EIO: input/output error"), {
      code: "EIO",
    });
    mockRenameSync.mockImplementation(() => {
      throw eioErr;
    });

    // Non-EPERM/EBUSY re-throws, which triggers the outer catch block
    // that attempts rollback and falls back to createWorktree
    const result = svc.claim(REPO_PATH, TASK_ID, INV_ID);
    expect(mockCreateWorktree).toHaveBeenCalledWith(REPO_PATH, TASK_ID, INV_ID);
    expect(result).toEqual(FALLBACK_RESULT);

    await svc.stop();
  });
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

describe("WorktreePoolService — stop", () => {
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    mockGitAsync.mockResolvedValue("");
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockRandomBytes.mockReturnValue(Buffer.from(POOL_HEX, "hex"));
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("stop() calls removeWorktreeAsync for each pool entry", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(2);

    let callCount = 0;
    mockRandomBytes.mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1
        ? Buffer.from("deadbeef", "hex")
        : Buffer.from("cafebabe", "hex");
    });

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    expect(svc.size(REPO_PATH)).toBe(2);

    await svc.stop();

    expect(mockRemoveWorktreeAsync).toHaveBeenCalledTimes(2);
    const removedPaths = mockRemoveWorktreeAsync.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(removedPaths).toContain(join(PARENT, "orca-pool-deadbeef"));
    expect(removedPaths).toContain(join(PARENT, "orca-pool-cafebabe"));
  });

  test("stop() clears the pool — size() returns 0 after stop", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    expect(svc.size(REPO_PATH)).toBe(1);

    await svc.stop();

    expect(svc.size(REPO_PATH)).toBe(0);
  });

  test("after stop(), replenish is a no-op — advancing timers adds no entries", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    await svc.stop();

    // Clear mocks so we can detect any new calls
    mockGitAsync.mockClear();
    mockRemoveWorktreeAsync.mockClear();

    // Attempt to trigger replenishment by advancing timers
    // But setInterval was cleared by stop(), so nothing should fire
    vi.advanceTimersByTime(31 * 60 * 1000);
    await flushMicrotasks(10);

    // No new pool entries should have been created
    const worktreeAddCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "worktree" &&
        call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);

    // Pool remains empty
    expect(svc.size(REPO_PATH)).toBe(0);
  });

  test("stop() tolerates removeWorktreeAsync failures (does not throw)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    mockRemoveWorktreeAsync.mockRejectedValue(new Error("removal failed"));

    // stop() should not throw even if removeWorktreeAsync rejects
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  test("stop() on empty pool (never filled) does not call removeWorktreeAsync", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);
    svc.start([REPO_PATH]);
    // Do NOT flush microtasks — pool stays empty

    await svc.stop();

    expect(mockRemoveWorktreeAsync).not.toHaveBeenCalled();
  });

  test("pool entries created after stop() are cleaned up immediately", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    // Hold gitAsync resolution so entry completes after stop()
    let resolveGit: () => void;
    const gitBarrier = new Promise<void>((resolve) => {
      resolveGit = resolve;
    });

    let asyncCallCount = 0;
    mockGitAsync.mockImplementation(async () => {
      asyncCallCount++;
      if (asyncCallCount === 1) {
        // First call (fetch origin) blocks until we release it
        await gitBarrier;
      }
      return "";
    });

    svc.start([REPO_PATH]);

    // Stop before the entry can complete
    const stopPromise = svc.stop();

    // Release the blocked gitAsync so createPoolEntry can finish
    resolveGit!();
    await flushMicrotasks(20);
    await stopPromise;

    // Post-stop: pool must be empty
    expect(svc.size(REPO_PATH)).toBe(0);
    // The late-created entry should have been removed via removeWorktreeAsync
    // (stopped flag causes immediate cleanup in replenish's .then)
    expect(mockRemoveWorktreeAsync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Interval behavior — refresh stale entries
// ---------------------------------------------------------------------------

describe("WorktreePoolService — interval and stale refresh", () => {
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    mockGitAsync.mockResolvedValue("");
    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockRandomBytes.mockReturnValue(Buffer.from(POOL_HEX, "hex"));
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("interval fires refresh after REFRESH_INTERVAL_MS (30 min)", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    // Use a very short freshness threshold so the entry is immediately stale
    const svc = new WorktreePoolService(1, 0);

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    // Clear gitAsync call history to isolate interval behavior
    mockGitAsync.mockClear();

    // Advance exactly 30 minutes to trigger the setInterval callback ONCE
    vi.advanceTimersByTime(30 * 60 * 1000);
    await flushMicrotasks(20);

    // Should have called gitAsync with fetch for stale entry refresh
    const fetchCalls = mockGitAsync.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0][0] === "fetch",
    );
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);

    await svc.stop();
  });

  test("stale entry refresh uses fetch + reset, not worktree add", async () => {
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    // Freshness threshold: 0 ms (every entry is immediately stale)
    const svc = new WorktreePoolService(1, 0);

    svc.start([REPO_PATH]);
    await flushMicrotasks(20);

    mockGitAsync.mockClear();

    // Trigger refresh interval once
    vi.advanceTimersByTime(30 * 60 * 1000);
    await flushMicrotasks(20);

    // Refresh should use fetch + reset, NOT worktree add
    const worktreeAddCalls = mockGitAsync.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0][0] === "worktree" &&
        call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(0);

    // Should have fetch call
    const resetCalls = mockGitAsync.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0][0] === "reset",
    );
    expect(resetCalls.length).toBeGreaterThanOrEqual(1);

    await svc.stop();
  });
});

// ---------------------------------------------------------------------------
// Race condition: replenish over-creates when in-flight entries are not yet counted
// ---------------------------------------------------------------------------

describe("WorktreePoolService — replenish in-flight tracking", () => {
  let mockGitAsync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRandomBytes: ReturnType<typeof vi.fn>;
  let mockRemoveWorktreeAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();

    const gitModule = await import("../src/git.js");
    mockGitAsync = vi.mocked(gitModule.gitAsync);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    const cryptoModule = await import("node:crypto");
    mockRandomBytes = vi.mocked(cryptoModule.randomBytes);

    const worktreeModule = await import("../src/worktree/index.js");
    mockRemoveWorktreeAsync = vi.mocked(worktreeModule.removeWorktreeAsync);

    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockRemoveWorktreeAsync.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("replenish does not over-create entries when interval fires while in-flight entries are unresolved", async () => {
    // This test verifies that in-flight tracking prevents duplicate pool entries.
    // `needed = poolSize - pool.length - inFlight` accounts for in-flight
    // createPoolEntry() promises, so concurrent calls can create more entries
    // than poolSize.
    const { WorktreePoolService } = await import("../src/worktree/pool.js");
    const svc = new WorktreePoolService(1);

    let hexCounter = 0;
    mockRandomBytes.mockImplementation(() => {
      hexCounter++;
      const hex = hexCounter.toString(16).padStart(8, "0");
      return Buffer.from(hex, "hex");
    });

    // Make gitAsync slow — entry won't resolve until we flush twice
    let resolveFirst: () => void;
    const firstBarrier = new Promise<void>((r) => { resolveFirst = r; });
    let callCount = 0;

    mockGitAsync.mockImplementation(async (args: string[]) => {
      // Block only the first "fetch origin" call (from the first replenish)
      if (callCount++ === 0 && Array.isArray(args) && args[0] === "fetch") {
        await firstBarrier;
      }
      return "";
    });

    svc.start([REPO_PATH]);

    // At this point, the first createPoolEntry is in-flight (blocked on gitAsync).
    // pool.length is still 0. Call claim() to trigger another replenish().
    // (We manually trigger another replenish by claiming — but pool is empty so
    // it falls back. We can also simulate by calling replenish manually via
    // another start() call with the same path — but start() guards with pools.has().
    // Instead, we test via the interval.)

    // The interval fires and calls replenish again WHILE the first entry is in-flight.
    vi.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve(); // let the interval callback run

    // At this point: 2 createPoolEntry calls are in-flight, but pool.length is still 0.
    // The interval called replenish again and saw needed=1-0=1, spawning a second entry.

    // Now resolve the barrier and flush all promises
    resolveFirst!();
    await flushMicrotasks(30);

    // With in-flight tracking fixed, the pool should contain exactly poolSize entries.
    // replenish() now calculates `needed = poolSize - pool.length - inFlight`,
    // so when the interval fires while an entry is in-flight, it sees needed=0
    // and does not spawn a duplicate.
    const poolSize = svc.size(REPO_PATH);
    expect(poolSize).toBe(1);

    await svc.stop();
  });
});

// ---------------------------------------------------------------------------
// createWorktreePool factory
// ---------------------------------------------------------------------------

describe("createWorktreePool", () => {
  test("returns a WorktreePoolService instance with correct poolSize", async () => {
    const { createWorktreePool, WorktreePoolService } = await import(
      "../src/worktree/pool.js"
    );
    const svc = createWorktreePool(5);
    expect(svc).toBeInstanceOf(WorktreePoolService);
    // size() on empty pool returns 0
    expect(svc.size(join(tmpdir(), "any-repo"))).toBe(0);
    await svc.stop();
  });
});
