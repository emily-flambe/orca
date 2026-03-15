// ---------------------------------------------------------------------------
// Unit tests for src/inngest/activities/verify-pr.ts — Gate 2 verification
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/github/index.js", () => ({
  findPrForBranch: vi.fn(),
  findPrByUrl: vi.fn(),
  pushAndCreatePr: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { git } from "../src/git.js";
import {
  findPrForBranch,
  findPrByUrl,
  pushAndCreatePr,
} from "../src/github/index.js";
import {
  verifyPr,
  type VerifyPrInput,
} from "../src/inngest/activities/verify-pr.js";

const gitMock = git as unknown as ReturnType<typeof vi.fn>;
const existsMock = existsSync as unknown as ReturnType<typeof vi.fn>;
const findPrForBranchMock = findPrForBranch as unknown as ReturnType<
  typeof vi.fn
>;
const findPrByUrlMock = findPrByUrl as unknown as ReturnType<typeof vi.fn>;
const pushAndCreatePrMock = pushAndCreatePr as unknown as ReturnType<
  typeof vi.fn
>;

function baseInput(overrides?: Partial<VerifyPrInput>): VerifyPrInput {
  return {
    taskId: "EMI-100",
    branchName: "orca/EMI-100-inv-1",
    repoPath: "/repo",
    summary: "Created PR #42",
    worktreePath: "/worktree",
    ...overrides,
  };
}

beforeEach(() => {
  gitMock.mockReset();
  existsMock.mockReset();
  existsMock.mockReturnValue(false);
  findPrForBranchMock.mockReset();
  findPrByUrlMock.mockReset();
  pushAndCreatePrMock.mockReset();
  findPrForBranchMock.mockResolvedValue({ exists: false });
  findPrByUrlMock.mockReturnValue({ exists: false });
  pushAndCreatePrMock.mockReturnValue({ exists: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// PR found by branch name
// ---------------------------------------------------------------------------

describe("PR found by branch name", () => {
  test("returns pr_found when findPrForBranch finds a PR", async () => {
    findPrForBranchMock.mockResolvedValue({
      exists: true,
      url: "https://github.com/org/repo/pull/42",
      number: 42,
      headBranch: "orca/EMI-100-inv-1",
    });

    const result = await verifyPr(baseInput());

    expect(result).toEqual({
      status: "pr_found",
      prNumber: 42,
      prBranch: "orca/EMI-100-inv-1",
      repoPath: "/repo",
    });
  });

  test("uses PR headBranch when it differs from input branchName", async () => {
    findPrForBranchMock.mockResolvedValue({
      exists: true,
      url: "https://github.com/org/repo/pull/42",
      number: 42,
      headBranch: "orca/EMI-100-inv-2",
    });

    const result = await verifyPr(baseInput());

    expect(result).toEqual({
      status: "pr_found",
      prNumber: 42,
      prBranch: "orca/EMI-100-inv-2",
      repoPath: "/repo",
    });
  });
});

// ---------------------------------------------------------------------------
// PR found by URL extraction from summary
// ---------------------------------------------------------------------------

describe("PR found by URL extraction from summary", () => {
  test("falls back to URL in summary when branch lookup returns empty", async () => {
    // git remote get-url origin to validate repo match
    gitMock.mockReturnValueOnce("git@github.com:org/repo.git");

    findPrByUrlMock.mockReturnValue({
      exists: true,
      url: "https://github.com/org/repo/pull/99",
      number: 99,
      headBranch: "orca/EMI-100-inv-1",
    });

    const result = await verifyPr(
      baseInput({
        summary: "Opened https://github.com/org/repo/pull/99 for review",
      }),
    );

    expect(result).toEqual({
      status: "pr_found",
      prNumber: 99,
      prBranch: "orca/EMI-100-inv-1",
      repoPath: "/repo",
    });
  });

  test("resolves cross-repo PR URL when config is provided", async () => {
    // git remote get-url origin for repo validation — returns different repo
    gitMock
      .mockReturnValueOnce("git@github.com:org/main-repo.git") // repoPath remote
      .mockReturnValueOnce("git@github.com:org/other-repo.git"); // candidate check in findLocalPathForGithubRepo

    findPrByUrlMock.mockReturnValue({
      exists: true,
      url: "https://github.com/org/other-repo/pull/55",
      number: 55,
      headBranch: "orca/EMI-100-inv-1",
    });

    const config = {
      projectRepoMap: new Map([["proj1", "/other-repo"]]),
      defaultCwd: undefined,
    };

    const result = await verifyPr(
      baseInput({
        summary: "PR: https://github.com/org/other-repo/pull/55",
      }),
      config,
    );

    expect(result).toEqual({
      status: "pr_found",
      prNumber: 55,
      prBranch: "orca/EMI-100-inv-1",
      repoPath: "/other-repo",
    });
  });
});

// ---------------------------------------------------------------------------
// No PR but worktree has no changes (already done)
// ---------------------------------------------------------------------------

describe("already done detection", () => {
  test("returns already_done when worktree has no diff vs origin/main", async () => {
    existsMock.mockReturnValue(true);

    // git remote get-url (no URL in summary so won't hit URL fallback path — summary has no github URL)
    // recovery: git log origin/main..HEAD — throws (no unpushed)
    gitMock
      .mockImplementationOnce(() => {
        throw new Error("no unpushed");
      }) // recovery log
      .mockReturnValueOnce(""); // worktreeHasNoChanges diff

    const result = await verifyPr(baseInput({ summary: "Fixed the bug" }));

    expect(result.status).toBe("already_done");
    expect(result).toHaveProperty("message", "no local commits on worktree");
  });

  test("returns already_done when summary matches known pattern", async () => {
    existsMock.mockReturnValue(false);

    const result = await verifyPr(
      baseInput({
        summary: "The feature is already implemented on main",
        worktreePath: null,
      }),
    );

    expect(result.status).toBe("already_done");
    expect(result).toHaveProperty(
      "message",
      "output summary indicates already done",
    );
  });

  test("returns already_done when no branchName and worktree has no changes", async () => {
    existsMock.mockReturnValue(true);
    gitMock.mockReturnValueOnce(""); // diff origin/main...HEAD

    const result = await verifyPr(
      baseInput({ branchName: null, summary: "done" }),
    );

    expect(result.status).toBe("already_done");
  });
});

// ---------------------------------------------------------------------------
// No PR, worktree has changes, auto-push recovery
// ---------------------------------------------------------------------------

describe("auto-push recovery", () => {
  test("pushes unpushed commits and returns recovery_pushed", async () => {
    existsMock.mockReturnValue(true);

    // git log origin/main..HEAD — has unpushed commits
    gitMock.mockReturnValueOnce("abc1234 fix stuff");

    pushAndCreatePrMock.mockReturnValue({
      exists: true,
      url: "https://github.com/org/repo/pull/77",
      number: 77,
      headBranch: "orca/EMI-100-inv-1",
    });

    const result = await verifyPr(
      baseInput({ summary: "Made changes but forgot to push" }),
    );

    expect(result).toEqual({
      status: "recovery_pushed",
      prNumber: 77,
      prBranch: "orca/EMI-100-inv-1",
      repoPath: "/repo",
    });
    expect(pushAndCreatePrMock).toHaveBeenCalledWith(
      "orca/EMI-100-inv-1",
      "EMI-100",
      "/worktree",
    );
  });
});

// ---------------------------------------------------------------------------
// No PR found anywhere
// ---------------------------------------------------------------------------

describe("no PR found", () => {
  test("returns no_pr when all checks fail", async () => {
    existsMock.mockReturnValue(false);

    const result = await verifyPr(baseInput({ summary: "I created a PR" }));

    expect(result).toEqual({
      status: "no_pr",
      message: "no PR found for branch orca/EMI-100-inv-1",
    });
  });

  test("returns no_pr when branchName is null and no already-done signals", async () => {
    existsMock.mockReturnValue(false);

    const result = await verifyPr(
      baseInput({
        branchName: null,
        summary: "I made some changes",
        worktreePath: null,
      }),
    );

    expect(result).toEqual({
      status: "no_pr",
      message: "no branch name found on invocation or task",
    });
  });
});

// ---------------------------------------------------------------------------
// Already-done pattern detected in summary
// ---------------------------------------------------------------------------

describe("already-done patterns", () => {
  const patterns = [
    "already complete",
    "already implemented",
    "already merged",
    "already on main",
    "nothing to do",
    "no changes needed",
  ];

  for (const pattern of patterns) {
    test(`detects pattern: "${pattern}"`, async () => {
      existsMock.mockReturnValue(false);

      const result = await verifyPr(
        baseInput({
          summary: `The task is ${pattern} so nothing was done`,
          worktreePath: null,
        }),
      );

      expect(result.status).toBe("already_done");
    });
  }
});
