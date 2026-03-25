// ---------------------------------------------------------------------------
// DLL init error detection and transient git error interactions
// ---------------------------------------------------------------------------

import { describe, test, expect, vi } from "vitest";

import { isTransientGitError, type ExecError } from "../src/git.js";

/** Windows STATUS_DLL_INIT_FAILED exit code (0xC0000142 unsigned). */
const WIN_DLL_INIT_FAILED = 3221225794;
/** Signed 32-bit representation of the same exit code. */
const WIN_DLL_INIT_FAILED_SIGNED = -1073741502;

/**
 * Local helper (mirrors the removed src/git.ts export) — used to distinguish
 * DLL errors from other transient errors in interaction tests.
 */
function isDllInitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as ExecError).status;
  return (
    status === WIN_DLL_INIT_FAILED || status === WIN_DLL_INIT_FAILED_SIGNED
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitError(
  overrides: Partial<ExecError> & { message?: string } = {},
): Error & ExecError {
  const err = new Error(overrides.message ?? "git command failed") as Error &
    ExecError;
  if (overrides.status !== undefined) err.status = overrides.status;
  if (overrides.signal !== undefined) err.signal = overrides.signal;
  if (overrides.code !== undefined) err.code = overrides.code;
  return err;
}

/**
 * Mirrors gitWithRetry logic for unit testing without importing the real
 * function (which has side-effects: sleepSync, global counters).
 */
function retryWrapper(
  fn: () => string,
  maxAttempts: number,
): { result?: string; attempts: number; error?: Error } {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = fn();
      return { result, attempts: attempt };
    } catch (err: unknown) {
      if (!isTransientGitError(err) || attempt === maxAttempts) {
        return { attempts: attempt, error: err as Error };
      }
    }
  }
  return { attempts: maxAttempts, error: new Error("unreachable") };
}

// ---------------------------------------------------------------------------
// isDllInitError — positive and negative cases
// ---------------------------------------------------------------------------

describe("isDllInitError", () => {
  test("returns true for signed 32-bit representation (-1073741502)", () => {
    const err = makeGitError({ status: -1073741502 });
    expect(isDllInitError(err)).toBe(true);
  });

  test("returns true for unsigned representation (3221225794)", () => {
    const err = makeGitError({ status: 3221225794 });
    expect(isDllInitError(err)).toBe(true);
  });

  test("returns false for normal exit codes", () => {
    expect(isDllInitError(makeGitError({ status: 0 }))).toBe(false);
    expect(isDllInitError(makeGitError({ status: 1 }))).toBe(false);
    expect(isDllInitError(makeGitError({ status: 128 }))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isDllInitError("3221225794")).toBe(false);
    expect(isDllInitError(3221225794)).toBe(false);
    expect(isDllInitError(null)).toBe(false);
    expect(isDllInitError(undefined)).toBe(false);
    expect(isDllInitError({ status: 3221225794 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTransientGitError with DLL init — interactions
// ---------------------------------------------------------------------------

describe("isTransientGitError — DLL init interactions", () => {
  test("DLL init error is both transient and DLL-specific", () => {
    const err = makeGitError({ status: 3221225794 });
    expect(isTransientGitError(err)).toBe(true);
    expect(isDllInitError(err)).toBe(true);
  });

  test("signal-killed error is transient but NOT DLL-specific", () => {
    const err = makeGitError({ signal: "SIGKILL" });
    expect(isTransientGitError(err)).toBe(true);
    expect(isDllInitError(err)).toBe(false);
  });

  test("non-DLL non-signal error is neither transient nor DLL", () => {
    const err = makeGitError({ status: 1 });
    expect(isTransientGitError(err)).toBe(false);
    expect(isDllInitError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry behavior with DLL init errors (tests retryWrapper using real
// isTransientGitError)
// ---------------------------------------------------------------------------

describe("retry behavior with DLL init errors", () => {
  test("DLL init error on attempt 1: retries and succeeds on attempt 2", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw dllErr;
      })
      .mockReturnValue("recovered");

    const { result, attempts } = retryWrapper(fn, 3);
    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
  });

  test("DLL init error on all attempts: throws after exhaustion", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi.fn().mockImplementation(() => {
      throw dllErr;
    });

    const { error, attempts } = retryWrapper(fn, 3);
    expect(error).toBeDefined();
    expect(attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("DLL error then non-transient error: stops on non-transient", () => {
    const dllErr = makeGitError({ status: 3221225794 });
    const normalErr = makeGitError({ status: 128 });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw dllErr;
      })
      .mockImplementationOnce(() => {
        throw normalErr;
      });

    const { error, attempts } = retryWrapper(fn, 5);
    expect(error).toBeDefined();
    expect(attempts).toBe(2);
  });

  test("mixed transient types: signal then DLL then success", () => {
    const sigErr = makeGitError({ signal: "SIGKILL" });
    const dllErr = makeGitError({ status: 3221225794 });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw sigErr;
      })
      .mockImplementationOnce(() => {
        throw dllErr;
      })
      .mockReturnValue("ok");

    const { result, attempts } = retryWrapper(fn, 5);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Error type edge cases that test real imported functions
// ---------------------------------------------------------------------------

describe("error type confusion risks", () => {
  test("Error subclass with status property: detection still works", () => {
    class GitCommandError extends Error {
      status: number;
      constructor(msg: string, status: number) {
        super(msg);
        this.status = status;
      }
    }
    const err = new GitCommandError("git fetch failed", 3221225794);
    expect(isDllInitError(err)).toBe(true);
    expect(isTransientGitError(err)).toBe(true);
  });

  test("plain object mimicking Error: instanceof fails, detection fails", () => {
    const fake = {
      message: "git command failed",
      status: 3221225794,
      stack: "fake stack",
    };
    expect(fake instanceof Error).toBe(false);
    expect(isDllInitError(fake)).toBe(false);
    expect(isTransientGitError(fake)).toBe(false);
  });
});
