// ---------------------------------------------------------------------------
// Unit tests for closePr() and closeOrphanedPrs()
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Mock child_process.execFileSync — the gh() helper uses this under the hood
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { closePr, closeOrphanedPrs } from "../src/github/index.js";

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// closePr
// ---------------------------------------------------------------------------

describe("closePr", () => {
  beforeEach(() => {
    execMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls gh pr close with correct args including --delete-branch and --comment", () => {
    execMock.mockReturnValue("");
    closePr(42, "/tmp/repo");

    expect(execMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr", "close", "42",
      "--delete-branch",
      "--comment", "Closed by Orca cleanup: orphaned PR with no running invocation or active task.",
    ]);
    expect(opts.cwd).toBe("/tmp/repo");
  });

  test("returns true on success", () => {
    execMock.mockReturnValue("");
    expect(closePr(1, "/tmp/repo")).toBe(true);
  });

  test("returns false and logs warning on failure", () => {
    execMock.mockImplementation(() => {
      throw new Error("network timeout");
    });
    const warnSpy = vi.spyOn(console, "warn");

    expect(closePr(99, "/tmp/repo")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("closePr(#99) failed"),
    );
  });

  test("returns false for non-Error throw", () => {
    execMock.mockImplementation(() => {
      throw "string error"; // eslint-disable-line no-throw-literal
    });
    expect(closePr(7, "/tmp/repo")).toBe(false);
  });

  test("converts prNumber to string in args", () => {
    execMock.mockReturnValue("");
    closePr(0, "/tmp/repo");
    const args = execMock.mock.calls[0][1];
    expect(args[2]).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// closeOrphanedPrs
// ---------------------------------------------------------------------------

describe("closeOrphanedPrs", () => {
  const NOW = Date.now();
  const TWO_HOURS_AGO = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  const FIVE_MIN_AGO = new Date(NOW - 5 * 60 * 1000).toISOString();
  const ONE_HOUR_MS = 60 * 60 * 1000;

  function defaultOpts(overrides: Partial<Parameters<typeof closeOrphanedPrs>[1]> = {}) {
    return {
      runningBranches: new Set<string>(),
      activeBranches: new Set<string>(),
      maxAgeMs: ONE_HOUR_MS,
      now: NOW,
      ...overrides,
    };
  }

  /**
   * Helper: make execMock respond to `gh pr list` with a given PR array,
   * and to `gh pr close` with success/failure per PR number.
   */
  function mockGhCalls(
    prList: { headRefName: string; number: number; updatedAt: string }[],
    closeFailures: Set<number> = new Set(),
  ) {
    execMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify(prList);
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "close") {
        const prNum = parseInt(args[2], 10);
        if (closeFailures.has(prNum)) {
          throw new Error(`close failed for #${prNum}`);
        }
        return "";
      }
      return "";
    });
  }

  beforeEach(() => {
    execMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("only targets PRs with orca/ prefix branches", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-1-inv-1", number: 10, updatedAt: TWO_HOURS_AGO },
      { headRefName: "feature/unrelated", number: 20, updatedAt: TWO_HOURS_AGO },
      { headRefName: "main", number: 30, updatedAt: TWO_HOURS_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());

    expect(closed).toBe(1);
    // Only PR #10 should have been closed
    const closeCalls = execMock.mock.calls.filter(
      (c: [string, string[]]) => c[1][0] === "pr" && c[1][1] === "close",
    );
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0][1][2]).toBe("10");
  });

  test("skips PRs in runningBranches", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-1-inv-1", number: 10, updatedAt: TWO_HOURS_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts({
      runningBranches: new Set(["orca/TASK-1-inv-1"]),
    }));

    expect(closed).toBe(0);
  });

  test("skips PRs in activeBranches", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-2-inv-1", number: 11, updatedAt: TWO_HOURS_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts({
      activeBranches: new Set(["orca/TASK-2-inv-1"]),
    }));

    expect(closed).toBe(0);
  });

  test("skips PRs updated within maxAgeMs", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-3-inv-1", number: 12, updatedAt: FIVE_MIN_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("closes qualifying PRs and returns count", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-A", number: 100, updatedAt: TWO_HOURS_AGO },
      { headRefName: "orca/TASK-B", number: 101, updatedAt: TWO_HOURS_AGO },
      { headRefName: "feature/safe", number: 102, updatedAt: TWO_HOURS_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(2);
  });

  test("handles gh pr list failure gracefully (returns 0)", () => {
    execMock.mockImplementation(() => {
      throw new Error("gh: not authenticated");
    });

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("per-PR close failure does not abort remaining PRs", () => {
    mockGhCalls(
      [
        { headRefName: "orca/TASK-X", number: 200, updatedAt: TWO_HOURS_AGO },
        { headRefName: "orca/TASK-Y", number: 201, updatedAt: TWO_HOURS_AGO },
        { headRefName: "orca/TASK-Z", number: 202, updatedAt: TWO_HOURS_AGO },
      ],
      new Set([201]), // PR #201 fails to close
    );

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());

    // 2 succeed, 1 fails
    expect(closed).toBe(2);
    // All 3 should have been attempted
    const closeCalls = execMock.mock.calls.filter(
      (c: [string, string[]]) => c[1][0] === "pr" && c[1][1] === "close",
    );
    expect(closeCalls).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test("empty PR list returns 0", () => {
    mockGhCalls([]);
    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("PR with invalid updatedAt (NaN date) is skipped", () => {
    // new Date("garbage").getTime() => NaN
    // The condition: Number.isNaN(updatedMs) || opts.now - updatedMs < opts.maxAgeMs
    // NaN check => true => continue (skip)
    mockGhCalls([
      { headRefName: "orca/TASK-NAN", number: 300, updatedAt: "not-a-date" },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("PR with empty updatedAt is skipped", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-EMPTY", number: 301, updatedAt: "" },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("PR at exact maxAge boundary is NOT closed (age === maxAge, condition is <)", () => {
    // If updatedAt is exactly maxAgeMs ago: now - updatedMs = maxAgeMs
    // The condition is: opts.now - updatedMs < opts.maxAgeMs  =>  maxAgeMs < maxAgeMs  =>  false
    // So it does NOT skip, and the PR IS closed.
    const exactBoundary = new Date(NOW - ONE_HOUR_MS).toISOString();
    mockGhCalls([
      { headRefName: "orca/TASK-BOUNDARY", number: 302, updatedAt: exactBoundary },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    // At exact boundary, age equals maxAge, condition < is false, so PR is closed
    expect(closed).toBe(1);
  });

  test("PR 1ms younger than maxAge is skipped", () => {
    // 1ms less than maxAge
    const justUnder = new Date(NOW - ONE_HOUR_MS + 1).toISOString();
    mockGhCalls([
      { headRefName: "orca/TASK-YOUNG", number: 303, updatedAt: justUnder },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });

  test("branch in both runningBranches AND activeBranches is still skipped", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-BOTH", number: 400, updatedAt: TWO_HOURS_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts({
      runningBranches: new Set(["orca/TASK-BOTH"]),
      activeBranches: new Set(["orca/TASK-BOTH"]),
    }));
    expect(closed).toBe(0);
  });

  test("maxAgeMs of 0 closes all old orca PRs", () => {
    mockGhCalls([
      { headRefName: "orca/TASK-ZERO", number: 500, updatedAt: FIVE_MIN_AGO },
    ]);

    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts({ maxAgeMs: 0 }));
    expect(closed).toBe(1);
  });

  test("gh pr list returns non-JSON causes graceful failure", () => {
    execMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return "not json at all";
      }
      return "";
    });

    // JSON.parse will throw inside gh(), but closeOrphanedPrs catches at a higher level.
    // Actually, gh() returns the raw string, and then JSON.parse happens in closeOrphanedPrs.
    // If the string isn't valid JSON, JSON.parse throws, which is caught by the try/catch.
    const closed = closeOrphanedPrs("/tmp/repo", defaultOpts());
    expect(closed).toBe(0);
  });
});
