// ---------------------------------------------------------------------------
// Tests for closeSupersededPrs
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn(() => vi.fn()),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

// Import after mocking so the module picks up the mocked child_process
import { closeSupersededPrs } from "../src/github/index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("closeSupersededPrs", () => {
  const cwd = "/tmp/fake-repo";

  test("closes old open PRs matching the task pattern", () => {
    // gh pr list returns two PRs: #5 (old) and #10 (current)
    mockedExecFileSync.mockImplementation((cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      // comment and close calls succeed
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    expect(result).toEqual([{ number: 5, branch: "orca/EMI-96-inv-3" }]);

    // Verify comment was posted
    const commentCall = mockedExecFileSync.mock.calls.find(
      ([, args]) => (args as string[]).includes("comment") && (args as string[]).includes("5"),
    );
    expect(commentCall).toBeDefined();
    expect((commentCall![1] as string[])).toContain("Superseded by #10");

    // Verify PR was closed with --delete-branch
    const closeCall = mockedExecFileSync.mock.calls.find(
      ([, args]) => (args as string[]).includes("close") && (args as string[]).includes("5"),
    );
    expect(closeCall).toBeDefined();
    expect((closeCall![1] as string[])).toContain("--delete-branch");
  });

  test("returns empty array when only the current PR exists", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    expect(result).toEqual([]);
    // Only the list call should have been made — no comment/close calls
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  test("returns empty array when gh pr list fails", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("gh CLI not found");
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    expect(result).toEqual([]);
  });

  test("continues closing remaining PRs when one fails", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 2, headRefName: "orca/EMI-96-inv-1" },
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      // Fail when trying to close PR #2
      if (a.includes("close") && a.includes("2")) {
        throw new Error("network error");
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    // PR #2 failed, but PR #5 should still be closed
    expect(result).toEqual([{ number: 5, branch: "orca/EMI-96-inv-3" }]);
  });

  test("only matches branches with orca/<taskId>-inv- prefix", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        // gh search returns broad results; some branches don't match the inv pattern
        return JSON.stringify([
          { number: 1, headRefName: "orca/EMI-96-inv-1" },        // matches
          { number: 3, headRefName: "orca/EMI-96-fix-typo" },     // does NOT match
          { number: 7, headRefName: "orca/EMI-960-inv-1" },       // does NOT match (different task)
          { number: 10, headRefName: "orca/EMI-96-inv-5" },       // matches but is current PR
        ]);
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    // Only PR #1 should be closed (matches pattern and is not current)
    expect(result).toEqual([{ number: 1, branch: "orca/EMI-96-inv-1" }]);
  });

  test("returns empty array when no open PRs exist at all", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([]);
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    expect(result).toEqual([]);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  test("closes multiple superseded PRs", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 1, headRefName: "orca/EMI-96-inv-1" },
          { number: 3, headRefName: "orca/EMI-96-inv-2" },
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    expect(result).toEqual([
      { number: 1, branch: "orca/EMI-96-inv-1" },
      { number: 3, branch: "orca/EMI-96-inv-2" },
      { number: 5, branch: "orca/EMI-96-inv-3" },
    ]);
  });

  // -----------------------------------------------------------------------
  // Edge cases and adversarial tests
  // -----------------------------------------------------------------------

  test("close failure prevents orphaned comment", () => {
    // Close is attempted first. If it fails, comment is never posted,
    // avoiding orphaned "Superseded by #X" comments on still-open PRs.
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      calls.push(a);
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      // Close fails
      if (a.includes("close") && a.includes("5")) {
        throw new Error("close failed: branch protection");
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);

    // PR #5 is NOT in the closed list
    expect(result).toEqual([]);

    // Close was attempted (and failed)
    const closeCall = calls.find(
      (a) => a.includes("close") && a.includes("5"),
    );
    expect(closeCall).toBeDefined();

    // Comment was NOT posted (close-first ordering prevents orphaned comments)
    const commentCall = calls.find(
      (a) => a.includes("comment") && a.includes("5"),
    );
    expect(commentCall).toBeUndefined();
  });

  test("does not match prefix-overlapping task IDs (EMI-9 vs EMI-96)", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 1, headRefName: "orca/EMI-9-inv-1" },
          { number: 2, headRefName: "orca/EMI-96-inv-1" },
          { number: 3, headRefName: "orca/EMI-9-inv-2" },
          { number: 4, headRefName: "orca/EMI-99-inv-1" },
        ]);
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-9", 3, cwd);

    // Only PR #1 (orca/EMI-9-inv-1) should be closed
    expect(result).toEqual([{ number: 1, branch: "orca/EMI-9-inv-1" }]);
  });

  test("handles empty taskId without crashing", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([]);
      }
      return "";
    });

    const result = closeSupersededPrs("", 10, cwd);
    expect(result).toEqual([]);
  });

  test("handles malformed JSON from gh", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return "not valid json";
      }
      return "";
    });

    const result = closeSupersededPrs("EMI-96", 10, cwd);
    expect(result).toEqual([]);
  });

  test("handles PRs with missing headRefName field", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 5 },
          { number: 7, headRefName: null },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      return "";
    });

    // Should not throw when headRefName is missing/null
    const result = closeSupersededPrs("EMI-96", 10, cwd);
    expect(result).toEqual([]);
  });

  test("executes close before comment for each PR (ordering)", () => {
    const callOrder: string[] = [];
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      if (a.includes("close")) {
        callOrder.push(`close-${a[2]}`);
      }
      if (a.includes("comment")) {
        callOrder.push(`comment-${a[2]}`);
      }
      return "";
    });

    closeSupersededPrs("EMI-96", 10, cwd);

    // Close must come before comment for PR #5
    const closeIdx = callOrder.indexOf("close-5");
    const commentIdx = callOrder.indexOf("comment-5");
    expect(closeIdx).toBeLessThan(commentIdx);
  });

  test("passes cwd to all gh commands", () => {
    const customCwd = "/custom/repo/path";
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([
          { number: 5, headRefName: "orca/EMI-96-inv-3" },
          { number: 10, headRefName: "orca/EMI-96-inv-7" },
        ]);
      }
      return "";
    });

    closeSupersededPrs("EMI-96", 10, customCwd);

    // Every call should have received the cwd
    for (const call of mockedExecFileSync.mock.calls) {
      const opts = call[2] as { cwd?: string; encoding?: string };
      expect(opts.cwd).toBe(customCwd);
    }
  });

  test("search term includes trailing hyphen to prevent prefix overlap", () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a.includes("pr") && a.includes("list")) {
        return JSON.stringify([]);
      }
      return "";
    });

    closeSupersededPrs("EMI-9", 10, cwd);

    const listCall = mockedExecFileSync.mock.calls.find(
      ([, args]) => (args as string[]).includes("list"),
    );
    const searchIdx = (listCall![1] as string[]).indexOf("--search");
    const searchValue = (listCall![1] as string[])[searchIdx + 1];

    expect(searchValue).toBe("orca/EMI-9-");
  });
});
