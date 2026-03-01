// ---------------------------------------------------------------------------
// Tests for closeSupersededPrs — auto-closing old PRs when a new one is opened
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

// Import after mocking
import { closeSupersededPrs } from "../src/github/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a gh pr list JSON response */
function prListJson(prs: { number: number; headRefName: string }[]): string {
  return JSON.stringify(prs);
}

/**
 * Set up execFileSync to respond based on the gh subcommand.
 * `listResponse` is the response for `gh pr list`.
 * `onComment` and `onClose` are optional callbacks for those subcommands.
 */
function setupGhMock(opts: {
  listResponse?: string;
  listError?: Error;
  onComment?: (args: string[]) => void;
  commentError?: (prNumber: string) => Error | undefined;
  onClose?: (args: string[]) => void;
  closeError?: (prNumber: string) => Error | undefined;
}): void {
  mockedExecFileSync.mockImplementation((_cmd, args, _options) => {
    const a = args as string[];
    if (a[0] === "pr" && a[1] === "list") {
      if (opts.listError) throw opts.listError;
      return (opts.listResponse ?? "[]") as any;
    }
    if (a[0] === "pr" && a[1] === "comment") {
      const prNum = a[2]!;
      const err = opts.commentError?.(prNum);
      if (err) throw err;
      opts.onComment?.(a);
      return "" as any;
    }
    if (a[0] === "pr" && a[1] === "close") {
      const prNum = a[2]!;
      const err = opts.closeError?.(prNum);
      if (err) throw err;
      opts.onClose?.(a);
      return "" as any;
    }
    return "" as any;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("closeSupersededPrs", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  test("closes multiple superseded PRs and returns their numbers", () => {
    const commented: string[] = [];
    const closed: string[] = [];

    setupGhMock({
      listResponse: prListJson([
        { number: 10, headRefName: "orca/EMI-66-inv-1" },
        { number: 15, headRefName: "orca/EMI-66-inv-3" },
        { number: 20, headRefName: "orca/EMI-66-inv-5" }, // current
      ]),
      onComment: (args) => commented.push(args[2]!),
      onClose: (args) => closed.push(args[2]!),
    });

    const result = closeSupersededPrs("EMI-66", 20, "/repo");

    expect(result.closed).toEqual([10, 15]);
    expect(commented).toEqual(["10", "15"]);
    expect(closed).toEqual(["10", "15"]);
  });

  test("comments include the new PR number", () => {
    const commentBodies: string[] = [];

    setupGhMock({
      listResponse: prListJson([
        { number: 5, headRefName: "orca/EMI-10-inv-1" },
      ]),
      onComment: (args) => {
        const bodyIdx = args.indexOf("--body");
        if (bodyIdx !== -1) commentBodies.push(args[bodyIdx + 1]!);
      },
    });

    closeSupersededPrs("EMI-10", 99, "/repo");

    expect(commentBodies).toEqual(["Superseded by #99"]);
  });

  test("close uses --delete-branch flag", () => {
    const closeArgs: string[][] = [];

    setupGhMock({
      listResponse: prListJson([
        { number: 3, headRefName: "orca/EMI-7-inv-1" },
      ]),
      onClose: (args) => closeArgs.push([...args]),
    });

    closeSupersededPrs("EMI-7", 8, "/repo");

    expect(closeArgs[0]).toContain("--delete-branch");
  });

  // -------------------------------------------------------------------------
  // No PRs to close
  // -------------------------------------------------------------------------

  test("returns empty when no open PRs found", () => {
    setupGhMock({ listResponse: "[]" });

    const result = closeSupersededPrs("EMI-50", 100, "/repo");
    expect(result.closed).toEqual([]);
  });

  test("returns empty when only current PR matches", () => {
    setupGhMock({
      listResponse: prListJson([
        { number: 42, headRefName: "orca/EMI-50-inv-5" },
      ]),
    });

    const result = closeSupersededPrs("EMI-50", 42, "/repo");
    expect(result.closed).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Prefix filtering (prevent EMI-6 matching EMI-66)
  // -------------------------------------------------------------------------

  test("does not close PRs with a different task that shares a prefix", () => {
    const closed: string[] = [];

    setupGhMock({
      // GitHub search for head:orca/EMI-6- might return EMI-66 branches
      listResponse: prListJson([
        { number: 10, headRefName: "orca/EMI-6-inv-1" },
        { number: 20, headRefName: "orca/EMI-66-inv-1" },
        { number: 30, headRefName: "orca/EMI-6-inv-3" }, // current
      ]),
      onClose: (args) => closed.push(args[2]!),
    });

    const result = closeSupersededPrs("EMI-6", 30, "/repo");

    // Should only close EMI-6 PRs, not EMI-66
    expect(result.closed).toEqual([10]);
    expect(closed).toEqual(["10"]);
  });

  test("handles task ID that is a prefix of another (EMI-1 vs EMI-10 vs EMI-100)", () => {
    setupGhMock({
      listResponse: prListJson([
        { number: 1, headRefName: "orca/EMI-1-inv-1" },
        { number: 2, headRefName: "orca/EMI-10-inv-1" },
        { number: 3, headRefName: "orca/EMI-100-inv-1" },
        { number: 4, headRefName: "orca/EMI-1-inv-2" }, // current
      ]),
    });

    const result = closeSupersededPrs("EMI-1", 4, "/repo");

    // Only EMI-1 prefix matches (orca/EMI-1-*), not EMI-10 or EMI-100
    expect(result.closed).toEqual([1]);
  });

  // -------------------------------------------------------------------------
  // Error handling: gh list failure
  // -------------------------------------------------------------------------

  test("returns empty on gh list failure (does not throw)", () => {
    setupGhMock({
      listError: new Error("network timeout"),
    });

    const result = closeSupersededPrs("EMI-99", 50, "/repo");
    expect(result.closed).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to list PRs for EMI-99"),
    );
  });

  // -------------------------------------------------------------------------
  // Error handling: individual PR operations
  // -------------------------------------------------------------------------

  test("continues closing other PRs when one fails", () => {
    setupGhMock({
      listResponse: prListJson([
        { number: 1, headRefName: "orca/EMI-5-inv-1" },
        { number: 2, headRefName: "orca/EMI-5-inv-2" },
        { number: 3, headRefName: "orca/EMI-5-inv-3" },
      ]),
      closeError: (prNum) =>
        prNum === "2" ? new Error("permission denied") : undefined,
    });

    const result = closeSupersededPrs("EMI-5", 99, "/repo");

    // PR #2 failed but #1 and #3 still closed
    expect(result.closed).toEqual([1, 3]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to close PR #2"),
    );
  });

  test("PR not in closed array when comment succeeds but close fails", () => {
    const commented: string[] = [];

    setupGhMock({
      listResponse: prListJson([
        { number: 7, headRefName: "orca/EMI-8-inv-1" },
      ]),
      onComment: (args) => commented.push(args[2]!),
      closeError: () => new Error("close failed"),
    });

    const result = closeSupersededPrs("EMI-8", 20, "/repo");

    // Comment was made but close failed — PR should NOT be in closed
    expect(commented).toEqual(["7"]);
    expect(result.closed).toEqual([]);
  });

  test("PR not in closed array when comment fails (close never attempted)", () => {
    const closeAttempts: string[] = [];

    setupGhMock({
      listResponse: prListJson([
        { number: 7, headRefName: "orca/EMI-8-inv-1" },
      ]),
      commentError: () => new Error("comment failed"),
      onClose: (args) => closeAttempts.push(args[2]!),
    });

    const result = closeSupersededPrs("EMI-8", 20, "/repo");

    expect(result.closed).toEqual([]);
    // Close should not even be attempted since comment threw
    expect(closeAttempts).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Malformed gh output
  // -------------------------------------------------------------------------

  test("skips PR entries with missing headRefName", () => {
    setupGhMock({
      listResponse: JSON.stringify([
        { number: 5 }, // missing headRefName
        { number: 6, headRefName: "orca/EMI-3-inv-2" },
      ]),
    });

    const result = closeSupersededPrs("EMI-3", 99, "/repo");

    // PR #5 should be skipped (headRefName undefined, startsWith returns false)
    // PR #6 should be closed
    expect(result.closed).toEqual([6]);
  });

  // -------------------------------------------------------------------------
  // gh command argument verification
  // -------------------------------------------------------------------------

  test("passes correct search args to gh pr list", () => {
    setupGhMock({ listResponse: "[]" });

    closeSupersededPrs("EMI-42", 100, "/my/repo");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr", "list",
        "--search", "head:orca/EMI-42-",
        "--state", "open",
        "--json", "number,headRefName",
      ],
      expect.objectContaining({ cwd: "/my/repo" }),
    );
  });
});
