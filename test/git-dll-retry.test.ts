// ---------------------------------------------------------------------------
// Tests for git() DLL_INIT retry logic and probeDllHealth()
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures the mock fn is available when vi.mock factory runs (hoisted)
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

// Mock Atomics.wait to avoid real delays in tests
const originalAtomicsWait = Atomics.wait;
beforeEach(() => {
  Atomics.wait = vi.fn(() => "ok") as unknown as typeof Atomics.wait;
});
afterEach(() => {
  Atomics.wait = originalAtomicsWait;
});

import { git, probeDllHealth, type ExecError } from "../src/git.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Windows DLL_INIT exit codes */
const DLL_EXIT_UNSIGNED = 3221225794;
const DLL_EXIT_SIGNED = -1073741502;

function makeDllError(signed = false): Error & ExecError {
  const code = signed ? DLL_EXIT_SIGNED : DLL_EXIT_UNSIGNED;
  const err = new Error(`Command failed: git\nexit code ${code}`) as Error &
    ExecError;
  err.status = code;
  err.stderr = "DLL init failed";
  return err;
}

function makeNormalGitError(exitCode: number): Error & ExecError {
  const err = new Error(`Command failed: git\nexit code ${exitCode}`) as Error &
    ExecError;
  err.status = exitCode;
  err.stderr = "fatal: not a git repository";
  return err;
}

// ---------------------------------------------------------------------------
// git() — DLL_INIT retry behavior
// ---------------------------------------------------------------------------

describe("git() retries on DLL_INIT errors", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  test("retries on DLL_INIT then succeeds on second attempt", () => {
    // First call: DLL_INIT failure (unsigned)
    // Second call: success
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockReturnValueOnce("git version 2.44.0\n");

    const result = git(["--version"]);

    expect(result).toBe("git version 2.44.0");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    // Verify Atomics.wait was called once for the retry delay
    expect(Atomics.wait).toHaveBeenCalledTimes(1);
  });

  test("retries on DLL_INIT (signed exit code) then succeeds", () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw makeDllError(/* signed */ true);
      })
      .mockReturnValueOnce("ok\n");

    const result = git(["status"]);
    expect(result).toBe("ok");
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  test("exhausts DLL retries then throws after 4 total attempts", () => {
    // 1 original + 3 retries = 4 total attempts
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError();
    });

    expect(() => git(["fetch", "origin"])).toThrow();
    // DLL_RETRY_MAX = 3, so: attempt 0 (original) + retries at 1,2,3 = 4 calls
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
    // Atomics.wait called 3 times (once per retry)
    expect(Atomics.wait).toHaveBeenCalledTimes(3);
  });

  test("exhausted DLL retry error has correct exit code preserved", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError();
    });

    try {
      git(["fetch", "origin"]);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      expect(e.status).toBe(DLL_EXIT_UNSIGNED);
      expect(e.message).toContain("git fetch origin");
    }
  });

  test("does NOT retry non-DLL errors (exit code 128)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeNormalGitError(128);
    });

    expect(() => git(["checkout", "nonexistent"])).toThrow();
    // Only 1 attempt, no retry
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  test("does NOT retry non-DLL errors (exit code 1)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeNormalGitError(1);
    });

    expect(() => git(["diff"])).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  test("does NOT retry errors without status property", () => {
    const err = new Error("ENOENT: git not found");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(() => git(["--version"])).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(Atomics.wait).not.toHaveBeenCalled();
  });

  test("retries use escalating delays: 5s, 15s, 30s", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError();
    });

    expect(() => git(["status"])).toThrow();

    const waitCalls = (Atomics.wait as ReturnType<typeof vi.fn>).mock.calls;
    expect(waitCalls).toHaveLength(3);
    // Each call: Atomics.wait(buffer, 0, 0, delayMs)
    expect(waitCalls[0]![3]).toBe(5_000);
    expect(waitCalls[1]![3]).toBe(15_000);
    expect(waitCalls[2]![3]).toBe(30_000);
  });

  test("DLL failure then non-DLL failure: stops at non-DLL (no further retry)", () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockImplementationOnce(() => {
        throw makeNormalGitError(128);
      });

    expect(() => git(["pull"])).toThrow();
    // 2 attempts: first DLL (retried), second non-DLL (thrown immediately)
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(Atomics.wait).toHaveBeenCalledTimes(1);
  });

  test("succeeds on third retry (attempt index 3)", () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockReturnValueOnce("success\n");

    const result = git(["status"]);
    expect(result).toBe("success");
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
    expect(Atomics.wait).toHaveBeenCalledTimes(3);
  });

  test("passes cwd option through to execFileSync on every attempt", () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw makeDllError();
      })
      .mockReturnValueOnce("ok\n");

    git(["status"], { cwd: "/some/repo" });

    // Both calls should have the same cwd
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: "/some/repo" });
    }
  });
});

// ---------------------------------------------------------------------------
// probeDllHealth()
// ---------------------------------------------------------------------------

describe("probeDllHealth", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  test("returns true when git --version succeeds", () => {
    mockExecFileSync.mockReturnValue("git version 2.44.0\n");

    expect(probeDllHealth()).toBe(true);

    // Verify it called git --version
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["--version"],
      expect.objectContaining({ encoding: "utf-8", timeout: 5_000 }),
    );
  });

  test("returns false on DLL_INIT failure (unsigned)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError();
    });

    expect(probeDllHealth()).toBe(false);
  });

  test("returns false on DLL_INIT failure (signed)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError(true);
    });

    expect(probeDllHealth()).toBe(false);
  });

  test("returns true on non-DLL error (git not found, ENOENT)", () => {
    const err = new Error("ENOENT: spawn git not found");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    // Non-DLL error means the system is NOT in DLL_INIT state
    expect(probeDllHealth()).toBe(true);
  });

  test("returns true on non-DLL error (exit code 1)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeNormalGitError(1);
    });

    expect(probeDllHealth()).toBe(true);
  });

  test("returns true on non-DLL error (exit code 128)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeNormalGitError(128);
    });

    expect(probeDllHealth()).toBe(true);
  });

  test("returns true on timeout error (not DLL-related)", () => {
    const err = new Error("TIMEOUT: git --version timed out");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    mockExecFileSync.mockImplementation(() => {
      throw err;
    });

    expect(probeDllHealth()).toBe(true);
  });

  test("does not retry internally (only one execFileSync call)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw makeDllError();
    });

    probeDllHealth();
    // probeDllHealth should NOT use retry logic
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});
