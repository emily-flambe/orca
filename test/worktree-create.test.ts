// ---------------------------------------------------------------------------
// createWorktree — baseRef branch-already-exists handling
//
// Tests that the fix for "git branch -D fails when branch is checked out in
// another worktree" is in place: when a local branch already exists, the code
// must check it out directly (no -b) and reset to origin instead of deleting
// and recreating it.
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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

  test("throws WorktreeLockedError when rmSync fails with EBUSY after killing processes", async () => {
    // Use EBUSY rather than EPERM to avoid the 2s×retry sleep in rmSyncWithRetry.
    // EBUSY is not retried by rmSyncWithRetry, so WorktreeLockedError is thrown immediately.
    const { createWorktree } = await import("../src/worktree/index.js");

    const repoPath = join(PARENT, "orca");
    const worktreePath = join(PARENT, "orca-EMI-500");

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

    // rmSync fails with EBUSY (file held by another process)
    const ebusyErr = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    mockRmSync.mockImplementation(() => {
      throw ebusyErr;
    });

    // createWorktree is synchronous — use try/catch, not .catch()
    let caught: unknown;
    try {
      createWorktree(repoPath, "EMI-500", 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("WorktreeLockedError");
    expect((caught as Error).message).toContain("processes killed but EPERM persists");
    expect((caught as { cause: unknown }).cause).toBe(ebusyErr);
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
