// ---------------------------------------------------------------------------
// Tests for cleanStaleLockFiles(), isTransientGitError(), isDllInitError()
// in src/git.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

const { mockExistsSync, mockStatSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    statSync: mockStatSync,
    unlinkSync: mockUnlinkSync,
  };
});

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Atomics.wait to avoid real delays
const originalAtomicsWait = Atomics.wait;
beforeEach(() => {
  Atomics.wait = vi.fn(() => "ok") as unknown as typeof Atomics.wait;
});
afterEach(() => {
  Atomics.wait = originalAtomicsWait;
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  cleanStaleLockFiles,
  isTransientGitError,
  isDllInitError,
  probeDllHealth,
  type ExecError,
} from "../src/git.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockReset();
  mockUnlinkSync.mockReset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DLL_EXIT_UNSIGNED = 3221225794;
const DLL_EXIT_SIGNED = -1073741502;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDllError(signed = false): Error & ExecError {
  const code = signed ? DLL_EXIT_SIGNED : DLL_EXIT_UNSIGNED;
  const err = new Error(`Command failed`) as Error & ExecError;
  err.status = code;
  return err;
}

function makeErrorWithMessage(msg: string): Error {
  return new Error(msg);
}

function makeErrorWithSignal(signal: string): Error & ExecError {
  const err = new Error("killed") as Error & ExecError;
  err.signal = signal;
  return err;
}

function makeErrorWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error("EPERM") as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// probeDllHealth
// ---------------------------------------------------------------------------

describe("probeDllHealth", () => {
  test("returns true when git --version succeeds", () => {
    mockExecFileSync.mockReturnValue("git version 2.44.0.windows.1");

    expect(probeDllHealth()).toBe(true);
  });

  test("returns false when git --version throws a DLL exit code (unsigned)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError(false);
    });

    expect(probeDllHealth()).toBe(false);
  });

  test("returns false when git --version throws a DLL exit code (signed)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError(true);
    });

    expect(probeDllHealth()).toBe(false);
  });

  test("returns true when git --version throws a non-DLL error (e.g. ENOENT)", () => {
    const err = new Error("git not found") as Error & ExecError;
    err.status = 127;
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(probeDllHealth()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanStaleLockFiles
// ---------------------------------------------------------------------------

describe("cleanStaleLockFiles", () => {
  test("does nothing when lock file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => cleanStaleLockFiles("/repo")).not.toThrow();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  test("does NOT remove lock file that is fresh (age < 60s)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 10_000, // 10 seconds old
    });

    cleanStaleLockFiles("/repo");

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  test("removes lock file that is stale (age > 60s)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 120_000, // 2 minutes old
    });

    cleanStaleLockFiles("/repo");

    expect(mockUnlinkSync).toHaveBeenCalledWith(
      expect.stringContaining("index.lock"),
    );
  });

  test("uses the correct lock path (<repoPath>/.git/index.lock)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 120_000,
    });

    cleanStaleLockFiles("/my/repo");

    const calledPath = mockUnlinkSync.mock.calls[0]![0] as string;
    // Platform-agnostic: check it ends with the expected segments
    expect(calledPath).toContain(".git");
    expect(calledPath).toContain("index.lock");
  });

  test("respects custom maxAgeMs threshold", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 5_000, // 5 seconds old
    });

    // With maxAgeMs = 3000, a 5s lock is stale
    cleanStaleLockFiles("/repo", 3_000);

    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  test("swallows errors from existsSync without throwing", () => {
    mockExistsSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => cleanStaleLockFiles("/repo")).not.toThrow();
  });

  test("swallows errors from unlinkSync without throwing", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({
      mtimeMs: Date.now() - 120_000,
    });
    mockUnlinkSync.mockImplementation(() => {
      throw new Error("EBUSY");
    });

    expect(() => cleanStaleLockFiles("/repo")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isTransientGitError
// ---------------------------------------------------------------------------

describe("isTransientGitError", () => {
  test("returns true for DLL exit code (unsigned)", () => {
    expect(isTransientGitError(makeDllError(false))).toBe(true);
  });

  test("returns true for DLL exit code (signed)", () => {
    expect(isTransientGitError(makeDllError(true))).toBe(true);
  });

  test("returns true for signal-killed process (via error.signal property)", () => {
    expect(isTransientGitError(makeErrorWithSignal("SIGKILL"))).toBe(true);
  });

  test("returns true for signal-killed process (via message containing 'signal: SIG')", () => {
    expect(
      isTransientGitError(makeErrorWithMessage("process failed: signal: SIGTERM")),
    ).toBe(true);
  });

  test("returns true for 'Could not resolve host' network error", () => {
    expect(
      isTransientGitError(makeErrorWithMessage("fatal: Could not resolve host: github.com")),
    ).toBe(true);
  });

  test("returns true for 'Connection timed out' network error", () => {
    expect(
      isTransientGitError(makeErrorWithMessage("fatal: Connection timed out")),
    ).toBe(true);
  });

  test("returns true for 'The remote end hung up unexpectedly' network error", () => {
    expect(
      isTransientGitError(
        makeErrorWithMessage("error: The remote end hung up unexpectedly"),
      ),
    ).toBe(true);
  });

  test("returns true for EPERM error message", () => {
    expect(
      isTransientGitError(makeErrorWithMessage("EPERM: operation not permitted")),
    ).toBe(true);
  });

  test("returns true for EPERM error code on the error object", () => {
    expect(isTransientGitError(makeErrorWithCode("EPERM"))).toBe(true);
  });

  test("returns false for normal exit code 1", () => {
    const err = new Error("git diff failed") as Error & ExecError;
    err.status = 1;
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for normal exit code 128", () => {
    const err = new Error("not a git repo") as Error & ExecError;
    err.status = 128;
    expect(isTransientGitError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isTransientGitError("string error")).toBe(false);
    expect(isTransientGitError(null)).toBe(false);
    expect(isTransientGitError(undefined)).toBe(false);
    expect(isTransientGitError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDllInitError
// ---------------------------------------------------------------------------

describe("isDllInitError", () => {
  test("returns true for unsigned DLL exit code", () => {
    expect(isDllInitError(makeDllError(false))).toBe(true);
  });

  test("returns true for signed DLL exit code", () => {
    expect(isDllInitError(makeDllError(true))).toBe(true);
  });

  test("returns false for normal exit code 1", () => {
    const err = new Error("git failed") as Error & ExecError;
    err.status = 1;
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for normal exit code 128", () => {
    const err = new Error("git failed") as Error & ExecError;
    err.status = 128;
    expect(isDllInitError(err)).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isDllInitError(null)).toBe(false);
    expect(isDllInitError("string")).toBe(false);
  });

  test("returns false for Error with no status property", () => {
    expect(isDllInitError(new Error("oops"))).toBe(false);
  });
});
