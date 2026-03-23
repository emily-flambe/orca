// ---------------------------------------------------------------------------
// createWorktree — baseRef branch-already-exists handling
//
// Tests that the fix for "git branch -D fails when branch is checked out in
// another worktree" is in place: when a local branch already exists, the code
// must check it out directly (no -b) and reset to origin instead of deleting
// and recreating it.
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

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  cleanStaleLockFiles: vi.fn(),
}));

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

// Prevent real PowerShell/execSync calls during tests
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: vi.fn() };
});

// Stub Atomics.wait so rmSyncWithRetry exponential backoff doesn't block tests
const _origAtomicsWait = Atomics.wait;
beforeAll(() => {
  Atomics.wait = (() => "ok") as typeof Atomics.wait;
});
afterAll(() => {
  Atomics.wait = _origAtomicsWait;
});

// Use tmpdir() as the parent so join() produces platform-correct separators.
const PARENT = tmpdir();

describe("createWorktree — baseRef branch-already-exists handling", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    // Default: readdirSync returns empty array (no .env files, no subdirs to npm install)
    mockReaddirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("when branch exists locally, uses worktree add without -b then resets — never calls git branch -D", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-999");
    const baseRef = "orca/EMI-999-inv-5";

    mockExistsSync.mockImplementation((p: string) => {
      // repo path exists; worktree path does NOT exist (fresh creation)
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      // worktree list returns nothing — worktree reuse path is skipped
      if (args[0] === "worktree" && args[1] === "list") return "";
      // show-ref --verify: branch EXISTS (returns without throwing)
      if (args[0] === "show-ref") return "";
      // all other git calls succeed
      return "";
    });

    await createWorktree(repoPath, "EMI-999", 5, { baseRef });

    // Must NOT call git branch -D
    const branchDCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(branchDCalls).toHaveLength(0);

    // Must call git worktree add WITHOUT -b (checkout existing branch)
    const worktreeAddCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0][0]).not.toContain("-b");
    expect(worktreeAddCalls[0][0]).toEqual([
      "worktree",
      "add",
      worktreePath,
      baseRef,
    ]);

    // Must call git reset --hard origin/<baseRef> inside the worktree
    const resetCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "reset" && call[0][1] === "--hard",
    );
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0][0]).toEqual(["reset", "--hard", `origin/${baseRef}`]);
    expect(resetCalls[0][1]).toEqual({ cwd: worktreePath });
  });

  test("when branch does not exist locally, uses worktree add -b", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-998");
    const baseRef = "orca/EMI-998-inv-3";

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      // show-ref --verify: branch does NOT exist (throws)
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      // ls-remote: remote ref DOES exist
      if (args[0] === "ls-remote") return "abc123\trefs/heads/" + baseRef;
      return "";
    });

    await createWorktree(repoPath, "EMI-998", 3, { baseRef });

    // Must call git worktree add WITH -b and origin/<baseRef>
    const worktreeAddCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0][0]).toEqual([
      "worktree",
      "add",
      "-b",
      baseRef,
      worktreePath,
      `origin/${baseRef}`,
    ]);

    // Must NOT call git reset (branch created fresh from origin)
    const resetCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "reset",
    );
    expect(resetCalls).toHaveLength(0);

    // Must NOT call git branch -D
    const branchDCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(branchDCalls).toHaveLength(0);
  });

  test("implement phase (no baseRef) creates new branch with -b from origin/main and does not call git branch -D", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      // show-ref: fresh implement branch does not exist yet
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      return "";
    });

    await createWorktree(repoPath, "EMI-997", 1);

    // Must use -b with origin/main
    const worktreeAddCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0][0]).toContain("-b");
    expect(worktreeAddCalls[0][0]).toContain("origin/main");

    // Must NOT call git branch -D
    const branchDCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(branchDCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createWorktree — stale directory removal (EPERM / WorktreeLockedError)
// ---------------------------------------------------------------------------

describe("createWorktree — stale directory removal", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;
  let mockRmSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);
    mockRmSync = vi.mocked(fsModule.rmSync);

    mockReaddirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("falls back to alternate worktree path when original is locked with EBUSY", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-500");
    const altPath = join(PARENT, "orca-EMI-500-retry-1");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      if (p === worktreePath) return true; // stale directory exists
      return false; // alt paths don't exist
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ""; // not registered
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      return "";
    });

    // rmSync fails with EBUSY on the original path only
    const ebusyErr = Object.assign(
      new Error("EBUSY: resource busy or locked"),
      { code: "EBUSY" },
    );
    mockRmSync.mockImplementation((p: string) => {
      if (p === worktreePath) throw ebusyErr;
      // alt paths succeed
    });

    const result = createWorktree(repoPath, "EMI-500", 1);
    // Should use alternate path instead of throwing
    expect(result.worktreePath).toBe(altPath);
  });

  test("throws WorktreeLockedError when all alternate paths are also locked", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-500");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      if (p === worktreePath) return true; // stale directory exists
      // All alt paths also exist (locked)
      if (p.includes("orca-EMI-500-retry-")) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ""; // not registered
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      return "";
    });

    // rmSync always fails with EBUSY
    const ebusyErr = Object.assign(
      new Error("EBUSY: resource busy or locked"),
      { code: "EBUSY" },
    );
    mockRmSync.mockImplementation(() => {
      throw ebusyErr;
    });

    let caught: unknown;
    try {
      createWorktree(repoPath, "EMI-500", 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("WorktreeLockedError");
  });

  test("succeeds when stale directory exists and rmSync succeeds after killing processes", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-501");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      if (p === worktreePath) return true; // stale directory exists
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ""; // not registered
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      return "";
    });

    // rmSync succeeds (directory was removed after process kill)
    mockRmSync.mockImplementation(() => undefined);

    const result = createWorktree(repoPath, "EMI-501", 2);
    expect(result.worktreePath).toBe(worktreePath);

    // rmSync was called to remove the stale directory
    expect(mockRmSync).toHaveBeenCalledWith(worktreePath, {
      recursive: true,
      force: true,
    });
  });

  test("rethrows non-EPERM/EBUSY errors from rmSync without wrapping in WorktreeLockedError", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-502");

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      if (p === worktreePath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "show-ref") throw new Error("fatal: not a valid ref");
      return "";
    });

    const enoentErr = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockRmSync.mockImplementation(() => {
      throw enoentErr;
    });

    let caught: unknown;
    try {
      createWorktree(repoPath, "EMI-502", 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toBe("ENOENT: no such file");
    expect((caught as Error).name).not.toBe("WorktreeLockedError");
  });
});

// ---------------------------------------------------------------------------
// createWorktree — non-baseRef branch exists on remote only
// ---------------------------------------------------------------------------

describe("createWorktree — non-baseRef branch exists on remote only", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    mockReaddirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("recovers when worktree add -b fails because branch already exists on remote", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const branchName = "orca/EMI-227-inv-874";
    const worktreePath = join(PARENT, "orca-EMI-227");

    mockExistsSync.mockImplementation((p: string) => {
      // repo exists; worktree path does NOT exist
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      // worktree list: no existing worktree
      if (args[0] === "worktree" && args[1] === "list") return "";
      // show-ref refs/heads/...: no local branch
      if (args[0] === "show-ref" && args[3] === `refs/heads/${branchName}`) {
        throw new Error("fatal: not a valid ref");
      }
      // show-ref refs/remotes/origin/...: remote-tracking ref exists
      if (
        args[0] === "show-ref" &&
        args[3] === `refs/remotes/origin/${branchName}`
      ) {
        return "abc123 refs/remotes/origin/" + branchName;
      }
      // worktree add -b: fails because branch name conflicts with remote-tracking ref
      if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b") {
        throw new Error(`fatal: A branch named '${branchName}' already exists`);
      }
      // All other git calls succeed
      return "";
    });

    const result = createWorktree(repoPath, "EMI-227", 874);

    expect(result.worktreePath).toBe(worktreePath);
    expect(result.branchName).toBe(branchName);

    // Recovery: git branch branchName origin/main must have been called
    const branchCreateCalls = mockGit.mock.calls.filter(
      (call) =>
        call[0][0] === "branch" &&
        call[0][1] === branchName &&
        call[0][2] === "origin/main",
    );
    expect(branchCreateCalls).toHaveLength(1);

    // Recovery: git worktree add <path> <branchName> (without -b) must have been called
    const worktreeAddNoBCalls = mockGit.mock.calls.filter(
      (call) =>
        call[0][0] === "worktree" &&
        call[0][1] === "add" &&
        !call[0].includes("-b") &&
        call[0].includes(worktreePath) &&
        call[0].includes(branchName),
    );
    expect(worktreeAddNoBCalls).toHaveLength(1);
  });

  test("does not delete local branch when only remote-tracking ref exists", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const branchName = "orca/EMI-227-inv-874";

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      // Local ref: does not exist
      if (args[0] === "show-ref" && args[3] === `refs/heads/${branchName}`) {
        throw new Error("fatal: not a valid ref");
      }
      // Remote-tracking ref: exists
      if (
        args[0] === "show-ref" &&
        args[3] === `refs/remotes/origin/${branchName}`
      ) {
        return "abc123 refs/remotes/origin/" + branchName;
      }
      // worktree add -b fails
      if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b") {
        throw new Error(`fatal: A branch named '${branchName}' already exists`);
      }
      return "";
    });

    await createWorktree(repoPath, "EMI-227", 874);

    // Must NOT call git branch -D (no local branch to delete)
    const branchDCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(branchDCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createWorktree — branch locked by another worktree (auto-increment suffix)
// ---------------------------------------------------------------------------

describe("createWorktree — branch locked by another worktree", () => {
  let mockGit: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReaddirSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const gitModule = await import("../src/git.js");
    mockGit = vi.mocked(gitModule.git);

    const fsModule = await import("node:fs");
    mockExistsSync = vi.mocked(fsModule.existsSync);
    mockReaddirSync = vi.mocked(fsModule.readdirSync);

    mockReaddirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("auto-increments branch suffix when inv-0 is checked out in another worktree", async () => {
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const taskId = "EMI-368";
    const worktreePath = join(PARENT, `orca-${taskId}`);
    const lockedBranch = `orca/${taskId}-inv-0`;
    const freeBranch = `orca/${taskId}-inv-1`;

    mockExistsSync.mockImplementation((p: string) => {
      if (p === repoPath) return true;
      return false;
    });

    mockGit.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "worktree" && args[1] === "prune") return "";
      // show-ref: inv-0 EXISTS locally, inv-1 does NOT
      if (args[0] === "show-ref" && args[3] === `refs/heads/${lockedBranch}`) {
        return ""; // branch exists
      }
      if (args[0] === "show-ref" && args[3] === `refs/heads/${freeBranch}`) {
        throw new Error("fatal: not a valid ref");
      }
      // git branch -D inv-0: fails — checked out in another worktree
      if (args[0] === "branch" && args[1] === "-D" && args[2] === lockedBranch) {
        throw new Error(
          `error: cannot delete branch '${lockedBranch}' used by worktree at '/some/path'`,
        );
      }
      // all other git calls succeed
      return "";
    });

    const result = createWorktree(repoPath, taskId, 0);

    // Should have auto-incremented to inv-1
    expect(result.branchName).toBe(freeBranch);
    expect(result.worktreePath).toBe(worktreePath);

    // worktree add should have used -b with the new branch name (inv-1)
    const worktreeAddCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "worktree" && call[0][1] === "add",
    );
    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0][0]).toContain(freeBranch);
    expect(worktreeAddCalls[0][0]).toContain("-b");

    // Should NOT have tried to delete the locked branch more than once
    const branchDCalls = mockGit.mock.calls.filter(
      (call) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(branchDCalls).toHaveLength(1);
    expect(branchDCalls[0][0][2]).toBe(lockedBranch);
  });
});
