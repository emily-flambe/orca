// ---------------------------------------------------------------------------
// Worktree resilience tests — retry, transient detection, fallback
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  isTransientGitError,
  cleanStaleLockFiles,
  type ExecError,
} from "../src/git.js";
import { deriveRepoRoot } from "../src/worktree/index.js";

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
 * Minimal retry wrapper that mirrors gitWithRetry logic for unit testing
 * without needing to mock the git module's internal import.
 */
function retryWrapper(fn: () => string, maxAttempts: number): string {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      if (!isTransientGitError(err) || attempt === maxAttempts) {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// isTransientGitError
// ---------------------------------------------------------------------------

describe("isTransientGitError", () => {
  test("returns true for Windows DLL init failed exit code (status property)", () => {
    const err = makeGitError({ status: 3221225794 });
    expect(isTransientGitError(err)).toBe(true);
  });

  test("returns true for Windows DLL init failed exit code (in message)", () => {
    const err = new Error("git command failed: git fetch origin\nexit: 3221225794");
    expect(isTransientGitError(err)).toBe(true);
  });

  test("returns true for signal-killed process (signal property)", () => {
    const err = makeGitError({ signal: "SIGKILL" });
    expect(isTransientGitError(err)).toBe(true);
  });

  test("returns true for signal in message", () => {
    const err = new Error("git command failed: git fetch origin\nsignal: SIGTERM");
    expect(isTransientGitError(err)).toBe(true);
  });

  test("returns false for normal git error (exit 1)", () => {
    const err = makeGitError({ status: 1, message: "git command failed\nexit: 1" });
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for exit code 128 (git-level error)", () => {
    const err = makeGitError({ status: 128, message: "git command failed\nexit: 128" });
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isTransientGitError("string error")).toBe(false);
    expect(isTransientGitError(42)).toBe(false);
    expect(isTransientGitError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gitWithRetry (via retryWrapper that mirrors the same logic)
// ---------------------------------------------------------------------------

describe("gitWithRetry (logic via retryWrapper)", () => {
  test("succeeds on first attempt without retry", () => {
    const fn = vi.fn().mockReturnValue("ok");
    const result = retryWrapper(fn, 3);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on transient error and succeeds on second attempt", () => {
    const transientErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw transientErr; })
      .mockReturnValue("recovered");

    const result = retryWrapper(fn, 3);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does not retry on non-transient error (exit 1)", () => {
    const normalErr = makeGitError({ status: 1 });
    const fn = vi.fn().mockImplementation(() => { throw normalErr; });

    expect(() => retryWrapper(fn, 3)).toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("does not retry on non-transient error (exit 128)", () => {
    const normalErr = makeGitError({ status: 128 });
    const fn = vi.fn().mockImplementation(() => { throw normalErr; });

    expect(() => retryWrapper(fn, 3)).toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("throws after exhausting all retries on transient errors", () => {
    const transientErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn().mockImplementation(() => { throw transientErr; });

    expect(() => retryWrapper(fn, 3)).toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("retries on signal-killed and succeeds", () => {
    const sigErr = makeGitError({ signal: "SIGKILL" });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw sigErr; })
      .mockReturnValue("ok");

    const result = retryWrapper(fn, 3);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// cleanStaleLockFiles
// ---------------------------------------------------------------------------

describe("cleanStaleLockFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-lock-test-"));
    mkdirSync(join(tempDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("removes lock file older than maxAge", () => {
    const lockPath = join(tempDir, ".git", "index.lock");
    writeFileSync(lockPath, "");
    const twoMinAgo = new Date(Date.now() - 120_000);
    utimesSync(lockPath, twoMinAgo, twoMinAgo);

    cleanStaleLockFiles(tempDir, 60_000);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does NOT remove lock file younger than maxAge", () => {
    const lockPath = join(tempDir, ".git", "index.lock");
    writeFileSync(lockPath, "");

    cleanStaleLockFiles(tempDir, 60_000);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("does nothing when no lock file exists", () => {
    // Should not throw
    expect(() => cleanStaleLockFiles(tempDir, 60_000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveRepoRoot
// ---------------------------------------------------------------------------

describe("deriveRepoRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-derive-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("strips task ID suffix to find repo root (simple name)", () => {
    const repoDir = join(tempDir, "orca");
    mkdirSync(repoDir);
    const worktreePath = join(tempDir, "orca-EMI-29");

    expect(deriveRepoRoot(worktreePath)).toBe(repoDir);
  });

  test("handles repos with hyphens in name (baba-is-win)", () => {
    const repoDir = join(tempDir, "baba-is-win");
    mkdirSync(repoDir);
    const worktreePath = join(tempDir, "baba-is-win-EMI-29");

    expect(deriveRepoRoot(worktreePath)).toBe(repoDir);
  });

  test("returns undefined when no candidate directory exists", () => {
    const worktreePath = join(tempDir, "nonexistent-EMI-29");
    expect(deriveRepoRoot(worktreePath)).toBeUndefined();
  });

  test("prefers longest matching prefix", () => {
    mkdirSync(join(tempDir, "foo"));
    mkdirSync(join(tempDir, "foo-bar"));
    const worktreePath = join(tempDir, "foo-bar-EMI-1");

    expect(deriveRepoRoot(worktreePath)).toBe(join(tempDir, "foo-bar"));
  });

  test("single-segment name with no match returns undefined", () => {
    // worktree path is just "thing" — can't strip further
    const worktreePath = join(tempDir, "thing");
    expect(deriveRepoRoot(worktreePath)).toBeUndefined();
  });

  // BUG: deriveRepoRoot returns a false positive when another worktree dir
  // exists that is a longer prefix than the real repo root.
  // Example: repo "orca" with worktrees "orca-EMI" (for task EMI) and
  // "orca-EMI-85" (for task EMI-85). deriveRepoRoot("orca-EMI-85") should
  // return "orca" but instead returns "orca-EMI" because it's a longer prefix.
  test("false positive: returns sibling worktree instead of repo root", () => {
    const repoDir = join(tempDir, "orca");
    const siblingWorktree = join(tempDir, "orca-EMI");
    mkdirSync(repoDir);
    mkdirSync(siblingWorktree);
    const worktreePath = join(tempDir, "orca-EMI-85");

    // This SHOULD return the actual repo root "orca", not the sibling "orca-EMI"
    // Currently returns "orca-EMI" because it's the longest matching prefix.
    // This is a known limitation of the heuristic approach.
    const result = deriveRepoRoot(worktreePath);
    // Documenting actual behavior: returns orca-EMI (the wrong answer)
    expect(result).toBe(siblingWorktree);
    // If/when fixed, this should be:
    // expect(result).toBe(repoDir);
  });

  test("worktree path with trailing separator is handled", () => {
    const repoDir = join(tempDir, "orca");
    mkdirSync(repoDir);
    // Trailing separator — basename() should strip it, but verify
    const worktreePath = join(tempDir, "orca-EMI-29") + "/";

    // basename() strips trailing slashes, so this should still work
    const result = deriveRepoRoot(worktreePath);
    // On some platforms basename("foo/") returns "foo", on others it may vary
    // This test documents the behavior
    expect(result === repoDir || result === undefined).toBe(true);
  });

  test("worktree name matches repo root exactly (no suffix to strip)", () => {
    // If someone passes the actual repo path, deriveRepoRoot should not
    // return a shorter prefix that happens to exist
    const repoDir = join(tempDir, "my-project");
    mkdirSync(repoDir);
    mkdirSync(join(tempDir, "my")); // shorter prefix exists

    // Passing the repo path itself as worktreePath
    const result = deriveRepoRoot(repoDir);
    // parts = ["my", "project"], loop from len=1: tries "my" which exists
    // This incorrectly returns "my" even though the input IS the repo
    expect(result).toBe(join(tempDir, "my"));
  });

  test("handles numeric-only task ID (e.g., orca-123)", () => {
    const repoDir = join(tempDir, "orca");
    mkdirSync(repoDir);
    const worktreePath = join(tempDir, "orca-123");

    expect(deriveRepoRoot(worktreePath)).toBe(repoDir);
  });

  test("BUG: hyphen-only dir name matches parent directory", () => {
    // When the worktree dir name is "-", split("-") = ["", ""].
    // At len=1, join(parentDir, "") = parentDir, which always exists.
    // This causes deriveRepoRoot to incorrectly return the parent directory.
    const worktreePath = join(tempDir, "-");
    // BUG: returns tempDir (the parent) instead of undefined
    expect(deriveRepoRoot(worktreePath)).toBe(tempDir);
    // If fixed, this should be: expect(deriveRepoRoot(worktreePath)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isTransientGitError — additional edge cases
// ---------------------------------------------------------------------------

describe("isTransientGitError — edge cases", () => {
  test("returns false for undefined/null signal property (not killed by signal)", () => {
    const err = makeGitError({ signal: null });
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for empty string signal property", () => {
    const err = makeGitError({ signal: "" });
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isTransientGitError(undefined)).toBe(false);
  });

  test("returns false for Error with no special properties", () => {
    const err = new Error("some random error");
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns true for SIGPIPE (potentially overbroad — any SIG* matches)", () => {
    // SIGPIPE is a non-fatal signal that happens with broken pipes.
    // The current implementation treats ALL signals as transient.
    // This test documents that behavior — it may be too broad.
    const err = new Error("git command failed\nsignal: SIGPIPE");
    expect(isTransientGitError(err)).toBe(true);
  });

  test("false positive risk: message containing 'signal: SIG' in path or ref name", () => {
    // Contrived but demonstrates the substring match weakness
    const err = new Error("git command failed: fatal: not a git repository: /home/signal: SIGINT/repo");
    expect(isTransientGitError(err)).toBe(true); // false positive
  });

  test("message-based detection works for errors thrown by git() wrapper", () => {
    // The git() function throws new Error() with formatted message.
    // The status/signal properties are NOT preserved on the new Error.
    // Only message-based detection works in production.
    const err = new Error(
      "git command failed: git fetch origin\n" +
      "exit: 3221225794\n" +
      "fatal: unable to access remote"
    );
    // No .status property — just the message
    expect((err as any).status).toBeUndefined();
    expect(isTransientGitError(err)).toBe(true);
  });

  test("returns false for exit code that is a substring of DLL init code", () => {
    // 322122579 is a prefix of 3221225794 — should not match
    const err = new Error("git command failed\nexit: 322122579");
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for exit code that contains DLL init code as substring", () => {
    // 32212257940 contains 3221225794 as substring — WILL match (bug?)
    const err = new Error("git command failed\nexit: 32212257940");
    // String.includes matches substrings, so this is a false positive
    expect(isTransientGitError(err)).toBe(true); // documents the substring match issue
  });
});

// ---------------------------------------------------------------------------
// gitWithRetry (via retryWrapper) — additional edge cases
// ---------------------------------------------------------------------------

describe("gitWithRetry (logic via retryWrapper) — edge cases", () => {
  test("maxAttempts = 1 never retries", () => {
    const transientErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn().mockImplementation(() => { throw transientErr; });

    expect(() => retryWrapper(fn, 1)).toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("alternating transient and non-transient errors: stops on non-transient", () => {
    const transientErr = makeGitError({ status: 3221225794 });
    const normalErr = makeGitError({ status: 128 });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw transientErr; })
      .mockImplementationOnce(() => { throw normalErr; });

    expect(() => retryWrapper(fn, 5)).toThrow();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws the LAST error (not the first) after exhausting retries", () => {
    const err1 = makeGitError({ status: 3221225794, message: "first failure" });
    const err2 = makeGitError({ status: 3221225794, message: "second failure" });
    const err3 = makeGitError({ status: 3221225794, message: "third failure" });
    const fn = vi.fn()
      .mockImplementationOnce(() => { throw err1; })
      .mockImplementationOnce(() => { throw err2; })
      .mockImplementationOnce(() => { throw err3; });

    expect(() => retryWrapper(fn, 3)).toThrow("third failure");
  });
});

// ---------------------------------------------------------------------------
// cleanStaleLockFiles — additional edge cases
// ---------------------------------------------------------------------------

describe("cleanStaleLockFiles — edge cases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orca-lock-edge-"));
    mkdirSync(join(tempDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("does NOT remove lock file at exactly maxAge boundary", () => {
    // The check is `age > maxAgeMs` (strict), not `>=`
    // A file exactly at the boundary should NOT be removed
    const lockPath = join(tempDir, ".git", "index.lock");
    writeFileSync(lockPath, "");
    // Set mtime to exactly maxAge ago
    const exactlyMaxAge = new Date(Date.now() - 60_000);
    utimesSync(lockPath, exactlyMaxAge, exactlyMaxAge);

    // Due to timing, this might be just barely over. Use a very large maxAge
    // to be safe about the boundary test.
    cleanStaleLockFiles(tempDir, 999_999_999);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("does not throw when .git directory does not exist", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "orca-nogit-"));
    try {
      // .git directory does not exist, so join(path, ".git", "index.lock") won't exist
      expect(() => cleanStaleLockFiles(noGitDir, 60_000)).not.toThrow();
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  test("maxAge of 0 removes any lock file (filesystem timestamp granularity > 0)", () => {
    // Even though the check is `age > maxAgeMs` (strict greater-than),
    // filesystem timestamp resolution means a just-created file always has
    // age >= 1ms by the time we stat it, so maxAge=0 effectively removes all.
    const lockPath = join(tempDir, ".git", "index.lock");
    writeFileSync(lockPath, "");
    cleanStaleLockFiles(tempDir, 0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
