// ---------------------------------------------------------------------------
// Unit tests for src/github/index.ts (non-closePr/closeOrphanedPrs functions)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Must be hoisted before imports.
// We set promisify.custom on execFileFn so that promisify(execFile) in the
// module under test delegates back to execFileFn as a promise-returning call.
// This means ghAsync(cmd, args, opts) ends up calling execFileMock(cmd, args, opts)
// and expecting a Promise back — so tests use mockReturnValue(Promise.resolve(...)).
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");

  const execFileSyncFn = vi.fn();
  const execFileFn = vi.fn();

  // Attach custom promisify symbol so promisify(execFileFn) calls execFileFn
  // directly as a promise-returning function rather than callback-style.
  (execFileFn as unknown as Record<symbol, unknown>)[
    promisify.custom as symbol
  ] = (...args: unknown[]) => execFileFn(...args);

  return {
    execFileSync: execFileSyncFn,
    execFile: execFileFn,
  };
});

vi.mock("../src/git.js", () => ({
  isTransientGitError: vi.fn().mockReturnValue(false),
  git: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { execFileSync, execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  findPrForBranch,
  findPrByUrl,
  listOpenPrBranches,
  getMergeCommitSha,
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  getWorkflowRunStatus,
  pushAndCreatePr,
  closeSupersededPrs,
  closePrsForCanceledTask,
} from "../src/github/index.js";
import { git } from "../src/git.js";

const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = git as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;
const rmSyncMock = rmSync as unknown as ReturnType<typeof vi.fn>;

/**
 * Mock a successful async gh call. ghAsync destructures { stdout } from the
 * resolved value, so we must resolve with { stdout, stderr }.
 */
function mockAsyncGhSuccess(stdout: string): void {
  execFileMock.mockReturnValue(Promise.resolve({ stdout, stderr: "" }));
}

/**
 * Mock a failing async gh call. ghAsync re-throws with the stderr detail.
 */
function mockAsyncGhFailure(stderrMsg: string): void {
  const err = Object.assign(
    new Error(`gh command failed: gh ...\n${stderrMsg}`),
    { stderr: stderrMsg },
  );
  execFileMock.mockReturnValue(Promise.reject(err));
}

// ---------------------------------------------------------------------------
// findPrForBranch
// ---------------------------------------------------------------------------

describe("findPrForBranch", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns exists:true with correct fields when PR found", () => {
    const prData = [
      {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        state: "OPEN",
        headRefName: "orca/EMI-100-inv-1",
      },
    ];
    execFileSyncMock.mockReturnValue(JSON.stringify(prData));

    const result = findPrForBranch("orca/EMI-100-inv-1", "/repo", 1);

    expect(result).toEqual({
      exists: true,
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      merged: false,
      headBranch: "orca/EMI-100-inv-1",
    });
  });

  test("returns exists:false when empty array returned", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    const result = findPrForBranch("orca/EMI-100-inv-1", "/repo", 1);

    expect(result).toEqual({ exists: false });
  });

  test("returns exists:false when gh throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh failed");
    });

    const result = findPrForBranch("orca/EMI-100-inv-1", "/repo", 1);

    expect(result).toEqual({ exists: false });
  });

  test("passes correct args to gh", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    findPrForBranch("orca/EMI-200-inv-5", "/repo", 1);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "list",
      "--head",
      "orca/EMI-200-inv-5",
      "--json",
      "url,number,state,headRefName",
      "--limit",
      "1",
    ]);
  });

  test("sets merged:true when state is MERGED", () => {
    const prData = [
      {
        url: "https://github.com/owner/repo/pull/7",
        number: 7,
        state: "MERGED",
        headRefName: "orca/EMI-100-inv-2",
      },
    ];
    execFileSyncMock.mockReturnValue(JSON.stringify(prData));

    const result = findPrForBranch("orca/EMI-100-inv-2", "/repo", 1);

    expect(result.merged).toBe(true);
  });

  test("sets merged:false when state is OPEN", () => {
    const prData = [
      {
        url: "https://github.com/owner/repo/pull/8",
        number: 8,
        state: "OPEN",
        headRefName: "orca/EMI-100-inv-3",
      },
    ];
    execFileSyncMock.mockReturnValue(JSON.stringify(prData));

    const result = findPrForBranch("orca/EMI-100-inv-3", "/repo", 1);

    expect(result.merged).toBe(false);
  });

  test("passes cwd option", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    findPrForBranch("orca/branch", "/my/custom/path", 1);

    const [, , opts] = execFileSyncMock.mock.calls[0];
    expect(opts.cwd).toBe("/my/custom/path");
  });

  test("with maxAttempts=1 only tries once", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    findPrForBranch("orca/branch", "/repo", 1);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// findPrByUrl
// ---------------------------------------------------------------------------

describe("findPrByUrl", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns exists:true with correct fields on valid response", () => {
    const data = {
      url: "https://github.com/owner/repo/pull/10",
      number: 10,
      state: "OPEN",
      headRefName: "orca/EMI-50-inv-1",
    };
    execFileSyncMock.mockReturnValue(JSON.stringify(data));

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/repo",
    );

    expect(result).toEqual({
      exists: true,
      url: "https://github.com/owner/repo/pull/10",
      number: 10,
      merged: false,
      headBranch: "orca/EMI-50-inv-1",
    });
  });

  test("returns exists:false when number is missing (not a number)", () => {
    const data = {
      url: "https://github.com/owner/repo/pull/10",
      state: "OPEN",
      headRefName: "orca/EMI-50-inv-1",
    };
    execFileSyncMock.mockReturnValue(JSON.stringify(data));

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("returns exists:false when url is missing (not a string)", () => {
    const data = {
      number: 10,
      state: "OPEN",
      headRefName: "orca/EMI-50-inv-1",
    };
    execFileSyncMock.mockReturnValue(JSON.stringify(data));

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("returns exists:false when gh throws", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("passes correct args to gh", () => {
    const prUrl = "https://github.com/owner/repo/pull/99";
    execFileSyncMock.mockReturnValue(
      JSON.stringify({ url: prUrl, number: 99, state: "OPEN" }),
    );

    findPrByUrl(prUrl, "/repo");

    const [cmd, args] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "view",
      prUrl,
      "--json",
      "url,number,state,headRefName",
    ]);
  });

  test("sets merged:true when state is MERGED", () => {
    const prUrl = "https://github.com/owner/repo/pull/11";
    execFileSyncMock.mockReturnValue(
      JSON.stringify({
        url: prUrl,
        number: 11,
        state: "MERGED",
        headRefName: "orca/branch",
      }),
    );

    const result = findPrByUrl(prUrl, "/repo");

    expect(result.merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listOpenPrBranches
// ---------------------------------------------------------------------------

describe("listOpenPrBranches", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns Set of headRefName values", () => {
    const prs = [
      { headRefName: "orca/EMI-1-inv-1" },
      { headRefName: "orca/EMI-2-inv-1" },
      { headRefName: "feature/other" },
    ];
    execFileSyncMock.mockReturnValue(JSON.stringify(prs));

    const result = listOpenPrBranches("/repo");

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has("orca/EMI-1-inv-1")).toBe(true);
    expect(result.has("orca/EMI-2-inv-1")).toBe(true);
    expect(result.has("feature/other")).toBe(true);
  });

  test("returns empty Set on gh failure", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh error");
    });

    const result = listOpenPrBranches("/repo");

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("passes correct args to gh", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    listOpenPrBranches("/my/repo");

    const [cmd, args, opts] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "headRefName",
      "--limit",
      "200",
    ]);
    expect(opts.cwd).toBe("/my/repo");
  });

  test("handles empty array returning empty Set", () => {
    execFileSyncMock.mockReturnValue(JSON.stringify([]));

    const result = listOpenPrBranches("/repo");

    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getMergeCommitSha
// ---------------------------------------------------------------------------

describe("getMergeCommitSha", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns oid string when mergeCommit present", async () => {
    mockAsyncGhSuccess(
      JSON.stringify({ mergeCommit: { oid: "abc123def456" } }),
    );

    const result = await getMergeCommitSha(42, "/repo");

    expect(result).toBe("abc123def456");
  });

  test("returns null when mergeCommit is null", async () => {
    mockAsyncGhSuccess(JSON.stringify({ mergeCommit: null }));

    const result = await getMergeCommitSha(42, "/repo");

    expect(result).toBeNull();
  });

  test("returns null when mergeCommit missing entirely", async () => {
    mockAsyncGhSuccess(JSON.stringify({}));

    const result = await getMergeCommitSha(42, "/repo");

    expect(result).toBeNull();
  });

  test("returns null on gh failure after retries", async () => {
    mockAsyncGhFailure("not found");

    const result = await getMergeCommitSha(42, "/repo");

    expect(result).toBeNull();
  }, 15000);

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess(JSON.stringify({ mergeCommit: { oid: "sha123" } }));

    await getMergeCommitSha(42, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "view", "42", "--json", "mergeCommit"]);
  });
});

// ---------------------------------------------------------------------------
// getPrCheckStatus
// ---------------------------------------------------------------------------

describe("getPrCheckStatus", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no_checks for empty checks array", async () => {
    mockAsyncGhSuccess(JSON.stringify([]));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("no_checks");
  });

  test("returns pending when any check has bucket=pending", async () => {
    const checks = [
      { name: "lint", state: "PENDING", bucket: "pending" },
      { name: "test", state: "SUCCESS", bucket: "pass" },
    ];
    mockAsyncGhSuccess(JSON.stringify(checks));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("pending");
  });

  test("returns pending when any check has bucket=queued", async () => {
    const checks = [{ name: "test", state: "QUEUED", bucket: "queued" }];
    mockAsyncGhSuccess(JSON.stringify(checks));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("pending");
  });

  test("returns failure when any check has bucket=fail (no pending)", async () => {
    const checks = [
      { name: "test", state: "FAILURE", bucket: "fail" },
      { name: "lint", state: "SUCCESS", bucket: "pass" },
    ];
    mockAsyncGhSuccess(JSON.stringify(checks));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("failure");
  });

  test("returns success when all checks have pass buckets", async () => {
    const checks = [
      { name: "lint", state: "SUCCESS", bucket: "pass" },
      { name: "test", state: "SUCCESS", bucket: "pass" },
    ];
    mockAsyncGhSuccess(JSON.stringify(checks));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("success");
  });

  test("returns success when checks have pass/skipping buckets", async () => {
    const checks = [
      { name: "lint", state: "SUCCESS", bucket: "pass" },
      { name: "optional", state: "SKIPPED", bucket: "skipping" },
    ];
    mockAsyncGhSuccess(JSON.stringify(checks));

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("success");
  });

  test("returns no_checks on gh failure", async () => {
    mockAsyncGhFailure("gh error");

    const result = await getPrCheckStatus(7, "/repo");

    expect(result).toBe("no_checks");
  });

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess(JSON.stringify([]));

    await getPrCheckStatus(7, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "checks", "7", "--json", "name,state,bucket"]);
  });
});

// ---------------------------------------------------------------------------
// getPrMergeState
// ---------------------------------------------------------------------------

describe("getPrMergeState", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns parsed mergeable and mergeStateStatus", async () => {
    mockAsyncGhSuccess(
      JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    );

    const result = await getPrMergeState(5, "/repo");

    expect(result).toEqual({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
  });

  test("returns UNKNOWN values on failure", async () => {
    mockAsyncGhFailure("gh error");

    const result = await getPrMergeState(5, "/repo");

    expect(result).toEqual({
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
  });

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess(
      JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }),
    );

    await getPrMergeState(5, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "view",
      "5",
      "--json",
      "mergeable,mergeStateStatus",
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergePr
// ---------------------------------------------------------------------------

describe("mergePr", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns merged:true on success", async () => {
    mockAsyncGhSuccess("");

    const result = await mergePr(10, "/repo");

    expect(result).toEqual({ merged: true });
  });

  test("returns merged:false with error on failure", async () => {
    mockAsyncGhFailure("merge conflict");

    const result = await mergePr(10, "/repo");

    expect(result.merged).toBe(false);
    if (!result.merged) {
      expect(result.error).toContain("gh command failed");
    }
  });

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess("");

    await mergePr(10, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "merge", "10", "--squash", "--delete-branch"]);
  });
});

// ---------------------------------------------------------------------------
// updatePrBranch
// ---------------------------------------------------------------------------

describe("updatePrBranch", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns true on success", async () => {
    mockAsyncGhSuccess("");

    const result = await updatePrBranch(3, "/repo");

    expect(result).toBe(true);
  });

  test("returns false on gh failure", async () => {
    mockAsyncGhFailure("gh error");

    const result = await updatePrBranch(3, "/repo");

    expect(result).toBe(false);
  });

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess("");

    await updatePrBranch(3, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "update-branch", "3"]);
  });
});

// ---------------------------------------------------------------------------
// getWorkflowRunStatus
// ---------------------------------------------------------------------------

describe("getWorkflowRunStatus", () => {
  const sha = "deadbeef1234567890";

  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no_runs for empty runs array", async () => {
    mockAsyncGhSuccess(JSON.stringify([]));

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("no_runs");
  });

  test("returns in_progress when any run has status=in_progress", async () => {
    const runs = [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
    ];
    mockAsyncGhSuccess(JSON.stringify(runs));

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status=queued", async () => {
    mockAsyncGhSuccess(
      JSON.stringify([{ status: "queued", conclusion: null }]),
    );

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status=waiting", async () => {
    mockAsyncGhSuccess(
      JSON.stringify([{ status: "waiting", conclusion: null }]),
    );

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status=pending", async () => {
    mockAsyncGhSuccess(
      JSON.stringify([{ status: "pending", conclusion: null }]),
    );

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("in_progress");
  });

  test("returns failure when any run has conclusion=failure (no in_progress)", async () => {
    const runs = [
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "success" },
    ];
    mockAsyncGhSuccess(JSON.stringify(runs));

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("failure");
  });

  test("returns failure when any run has conclusion=cancelled", async () => {
    mockAsyncGhSuccess(
      JSON.stringify([{ status: "completed", conclusion: "cancelled" }]),
    );

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("failure");
  });

  test("returns failure when any run has conclusion=timed_out", async () => {
    mockAsyncGhSuccess(
      JSON.stringify([{ status: "completed", conclusion: "timed_out" }]),
    );

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("failure");
  });

  test("returns success when all runs completed with success/skipped conclusions", async () => {
    const runs = [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "skipped" },
    ];
    mockAsyncGhSuccess(JSON.stringify(runs));

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("success");
  });

  test("returns no_runs on gh failure", async () => {
    mockAsyncGhFailure("gh error");

    const result = await getWorkflowRunStatus(sha, "/repo");

    expect(result).toBe("no_runs");
  });

  test("passes correct args to gh", async () => {
    mockAsyncGhSuccess(JSON.stringify([]));

    await getWorkflowRunStatus(sha, "/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "run",
      "list",
      "--commit",
      sha,
      "--json",
      "status,conclusion",
      "--limit",
      "20",
    ]);
  });
});

// ---------------------------------------------------------------------------
// rebasePrBranch
// ---------------------------------------------------------------------------

describe("rebasePrBranch", () => {
  const branch = "orca/EMI-123-inv-456";
  const repoPath = "/home/user/myrepo";

  beforeEach(() => {
    gitMock.mockReset();
    existsSyncMock.mockReset();
    rmSyncMock.mockReset();
    // Default: git succeeds for all calls
    gitMock.mockReturnValue(undefined);
    // Default: tempPath doesn't exist (so rmSync fallback is skipped)
    existsSyncMock.mockReturnValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns success when fetch, worktree add, checkout, rebase, and push all succeed", () => {
    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({ success: true });
    // fetch, worktree add, checkout, rebase, push, worktree remove = 6 calls
    expect(gitMock).toHaveBeenCalledTimes(6);
  });

  test("passes correct fetch args", () => {
    rebasePrBranch(branch, repoPath);

    expect(gitMock).toHaveBeenCalledWith(["fetch", "origin"], {
      cwd: repoPath,
    });
  });

  test("passes correct worktree add args (--force --detach)", () => {
    rebasePrBranch(branch, repoPath);

    const worktreeCall = gitMock.mock.calls.find(
      ([args]: [string[]]) => args[0] === "worktree" && args[1] === "add",
    );
    expect(worktreeCall).toBeDefined();
    const [args] = worktreeCall!;
    expect(args).toContain("--force");
    expect(args).toContain("--detach");
  });

  test("encodes slashes in branch name in worktree path", () => {
    rebasePrBranch(branch, repoPath);

    const worktreeCall = gitMock.mock.calls.find(
      ([args]: [string[]]) => args[0] === "worktree" && args[1] === "add",
    );
    // args: ["worktree", "add", "--force", "--detach", tempPath]
    const tempPath: string = worktreeCall![0][4];
    // slashes in branch name become dashes
    expect(tempPath).toContain("orca-EMI-123-inv-456");
  });

  test("returns fetch failure when git fetch throws", () => {
    gitMock.mockImplementationOnce(() => {
      throw new Error("network timeout");
    });

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("fetch failed"),
    });
    // Only the fetch call should have been made
    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  test("returns worktree add failure when git worktree add throws", () => {
    // fetch succeeds, worktree add fails
    gitMock
      .mockReturnValueOnce(undefined) // fetch
      .mockImplementationOnce(() => {
        throw new Error("worktree locked");
      });

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("worktree add failed"),
    });
    expect(gitMock).toHaveBeenCalledTimes(2);
  });

  test("returns checkout failure and cleans up worktree when checkout throws", () => {
    // fetch, worktree add succeed; checkout fails
    gitMock
      .mockReturnValueOnce(undefined) // fetch
      .mockReturnValueOnce(undefined) // worktree add
      .mockImplementationOnce(() => {
        throw new Error("ref not found");
      }); // checkout

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("checkout failed"),
    });
    // Should attempt cleanup: worktree remove
    const worktreeRemoveCall = gitMock.mock.calls.find(
      ([args]: [string[]]) =>
        args[0] === "worktree" && args[1] === "remove",
    );
    expect(worktreeRemoveCall).toBeDefined();
  });

  test("returns hasConflicts:true when rebase fails", () => {
    // fetch, worktree add, checkout succeed; rebase fails
    gitMock
      .mockReturnValueOnce(undefined) // fetch
      .mockReturnValueOnce(undefined) // worktree add
      .mockReturnValueOnce(undefined) // checkout
      .mockImplementationOnce(() => {
        throw new Error("CONFLICT (content)");
      }) // rebase
      .mockReturnValueOnce(undefined) // rebase --abort
      .mockReturnValueOnce(undefined); // worktree remove (cleanup)

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({ success: false, hasConflicts: true });
  });

  test("returns push failure and cleans up when force-push throws", () => {
    // fetch, worktree add, checkout, rebase succeed; push fails
    gitMock
      .mockReturnValueOnce(undefined) // fetch
      .mockReturnValueOnce(undefined) // worktree add
      .mockReturnValueOnce(undefined) // checkout
      .mockReturnValueOnce(undefined) // rebase
      .mockImplementationOnce(() => {
        throw new Error("rejected: stale info");
      }); // push

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("push failed"),
    });
    // Cleanup should still run after push failure
    const worktreeRemoveCall = gitMock.mock.calls.find(
      ([args]: [string[]]) =>
        args[0] === "worktree" && args[1] === "remove",
    );
    expect(worktreeRemoveCall).toBeDefined();
  });

  test("falls back to rmSync when git worktree remove fails during cleanup", () => {
    // All main steps succeed, but worktree remove during cleanup throws
    const tempPathHolder: { path?: string } = {};

    gitMock.mockImplementation((...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      if (args[0] === "worktree" && args[1] === "add") {
        // Capture the tempPath from the worktree add call
        tempPathHolder.path = args[3];
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("EPERM");
      }
      return undefined;
    });
    existsSyncMock.mockReturnValue(true);

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({ success: true });
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("rebase"),
      { recursive: true, force: true },
    );
  });

  test("skips rmSync when tempPath does not exist in cleanup fallback", () => {
    // worktree remove fails, existsSync returns false → rmSync not called
    gitMock.mockImplementation((...callArgs: unknown[]) => {
      const args = callArgs[0] as string[];
      if (args[0] === "worktree" && args[1] === "remove") {
        throw new Error("EPERM");
      }
      return undefined;
    });
    existsSyncMock.mockReturnValue(false);

    const result = rebasePrBranch(branch, repoPath);

    expect(result).toEqual({ success: true });
    expect(rmSyncMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pushAndCreatePr
// ---------------------------------------------------------------------------

describe("pushAndCreatePr", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    gitMock.mockReset();
    gitMock.mockReturnValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns PrInfo on success when PR URL is returned", () => {
    const prUrl = "https://github.com/owner/repo/pull/42";
    const prViewData = {
      url: prUrl,
      number: 42,
      state: "OPEN",
      headRefName: "orca/EMI-100-inv-1",
    };
    // First execFileSync call: gh pr create → returns URL
    // Second execFileSync call: gh pr view (from findPrByUrl) → returns JSON
    execFileSyncMock
      .mockReturnValueOnce(prUrl)
      .mockReturnValueOnce(JSON.stringify(prViewData));

    const result = pushAndCreatePr("orca/EMI-100-inv-1", "EMI-100", "/repo");

    expect(result).toEqual({
      exists: true,
      url: prUrl,
      number: 42,
      merged: false,
      headBranch: "orca/EMI-100-inv-1",
    });
  });

  test("passes correct args to gh pr create", () => {
    const prUrl = "https://github.com/owner/repo/pull/1";
    execFileSyncMock
      .mockReturnValueOnce(prUrl)
      .mockReturnValueOnce(
        JSON.stringify({ url: prUrl, number: 1, state: "OPEN" }),
      );

    pushAndCreatePr("orca/EMI-5-inv-2", "EMI-5", "/repo");

    const [cmd, args] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toContain("pr");
    expect(args).toContain("create");
    expect(args).toContain("--head");
    expect(args).toContain("orca/EMI-5-inv-2");
    // taskId appears in the --title value as "[EMI-5] ..."
    const titleIdx = args.indexOf("--title");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(args[titleIdx + 1]).toContain("EMI-5");
  });

  test("returns { exists: false } when git push fails", () => {
    gitMock.mockImplementationOnce(() => {
      throw new Error("remote rejected");
    });

    const result = pushAndCreatePr("orca/branch", "TASK-1", "/repo");

    expect(result).toEqual({ exists: false });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  test("returns { exists: false } when gh pr create fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh pr create failed");
    });

    const result = pushAndCreatePr("orca/branch", "TASK-1", "/repo");

    expect(result).toEqual({ exists: false });
  });

  test("returns { exists: false } when gh pr create returns non-http output", () => {
    execFileSyncMock.mockReturnValueOnce("some error message");

    const result = pushAndCreatePr("orca/branch", "TASK-1", "/repo");

    expect(result).toEqual({ exists: false });
  });

  test("calls git push with correct args", () => {
    const prUrl = "https://github.com/owner/repo/pull/10";
    execFileSyncMock
      .mockReturnValueOnce(prUrl)
      .mockReturnValueOnce(
        JSON.stringify({ url: prUrl, number: 10, state: "OPEN" }),
      );

    pushAndCreatePr("orca/EMI-10-inv-1", "EMI-10", "/my/repo");

    expect(gitMock).toHaveBeenCalledWith(
      ["push", "-u", "origin", "orca/EMI-10-inv-1"],
      { cwd: "/my/repo" },
    );
  });
});

// ---------------------------------------------------------------------------
// closeSupersededPrs
// ---------------------------------------------------------------------------

describe("closeSupersededPrs", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns 0 when gh pr list fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh error");
    });

    const result = closeSupersededPrs(
      "EMI-100",
      99,
      5,
      "orca/EMI-100-inv-5",
      "/repo",
    );

    expect(result).toBe(0);
  });

  test("closes PRs matching prefix, skips the new branch", () => {
    const prs = [
      { headRefName: "orca/EMI-100-inv-3", number: 30 },
      { headRefName: "orca/EMI-100-inv-4", number: 40 },
      { headRefName: "orca/EMI-100-inv-5", number: 50 }, // new branch — skip
      { headRefName: "orca/EMI-999-inv-1", number: 9 }, // different task — skip
    ];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs)) // pr list
      .mockReturnValue(""); // pr close calls

    const result = closeSupersededPrs(
      "EMI-100",
      50,
      5,
      "orca/EMI-100-inv-5",
      "/repo",
    );

    expect(result).toBe(2);
    // Should close #30 and #40, not #50 or #9
    const closeCalls = execFileSyncMock.mock.calls.slice(1);
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0][1]).toContain("30");
    expect(closeCalls[1][1]).toContain("40");
  });

  test("returns 0 when no PRs match the task prefix", () => {
    const prs = [
      { headRefName: "orca/OTHER-1-inv-1", number: 1 },
      { headRefName: "feature/unrelated", number: 2 },
    ];
    execFileSyncMock.mockReturnValueOnce(JSON.stringify(prs));

    const result = closeSupersededPrs(
      "EMI-100",
      99,
      5,
      "orca/EMI-100-inv-5",
      "/repo",
    );

    expect(result).toBe(0);
  });

  test("continues and counts only successful closes when one close fails", () => {
    const prs = [
      { headRefName: "orca/EMI-100-inv-1", number: 10 },
      { headRefName: "orca/EMI-100-inv-2", number: 20 },
    ];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs)) // pr list
      .mockImplementationOnce(() => {
        throw new Error("close failed");
      }) // close #10 fails
      .mockReturnValueOnce(""); // close #20 succeeds

    const result = closeSupersededPrs(
      "EMI-100",
      99,
      5,
      "orca/EMI-100-inv-5",
      "/repo",
    );

    expect(result).toBe(1);
  });

  test("uses custom comment when provided", () => {
    const prs = [{ headRefName: "orca/EMI-100-inv-1", number: 10 }];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closeSupersededPrs(
      "EMI-100",
      99,
      5,
      "orca/EMI-100-inv-5",
      "/repo",
      "Custom close comment",
    );

    const closeArgs = execFileSyncMock.mock.calls[1][1] as string[];
    expect(closeArgs).toContain("Custom close comment");
  });

  test("passes correct args to gh pr list", () => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify([]));

    closeSupersededPrs("EMI-100", 99, 5, "orca/EMI-100-inv-5", "/my/repo");

    const [cmd, args, opts] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "headRefName,number",
      "--limit",
      "200",
    ]);
    expect(opts.cwd).toBe("/my/repo");
  });

  test("passes --delete-branch to gh pr close", () => {
    const prs = [{ headRefName: "orca/EMI-100-inv-1", number: 11 }];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closeSupersededPrs("EMI-100", 99, 5, "orca/EMI-100-inv-5", "/repo");

    const closeArgs = execFileSyncMock.mock.calls[1][1] as string[];
    expect(closeArgs).toContain("--delete-branch");
  });
});

// ---------------------------------------------------------------------------
// closePrsForCanceledTask
// ---------------------------------------------------------------------------

describe("closePrsForCanceledTask", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns 0 when gh pr list fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh error");
    });

    const result = closePrsForCanceledTask("EMI-200", "/repo");

    expect(result).toBe(0);
  });

  test("closes all PRs matching the task prefix", () => {
    const prs = [
      { headRefName: "orca/EMI-200-inv-1", number: 11 },
      { headRefName: "orca/EMI-200-inv-2", number: 22 },
      { headRefName: "orca/EMI-999-inv-1", number: 99 }, // different task — skip
    ];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValue("");

    const result = closePrsForCanceledTask("EMI-200", "/repo");

    expect(result).toBe(2);
    const closeCalls = execFileSyncMock.mock.calls.slice(1);
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0][1]).toContain("11");
    expect(closeCalls[1][1]).toContain("22");
  });

  test("returns 0 when no PRs match the task prefix", () => {
    execFileSyncMock.mockReturnValueOnce(
      JSON.stringify([{ headRefName: "orca/OTHER-1-inv-1", number: 1 }]),
    );

    const result = closePrsForCanceledTask("EMI-200", "/repo");

    expect(result).toBe(0);
  });

  test("continues and counts only successful closes when one fails", () => {
    const prs = [
      { headRefName: "orca/EMI-200-inv-1", number: 11 },
      { headRefName: "orca/EMI-200-inv-2", number: 22 },
    ];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockImplementationOnce(() => {
        throw new Error("close failed");
      })
      .mockReturnValueOnce("");

    const result = closePrsForCanceledTask("EMI-200", "/repo");

    expect(result).toBe(1);
  });

  test("passes correct args to gh pr list", () => {
    execFileSyncMock.mockReturnValueOnce(JSON.stringify([]));

    closePrsForCanceledTask("EMI-200", "/my/repo");

    const [cmd, args, opts] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "headRefName,number",
      "--limit",
      "200",
    ]);
    expect(opts.cwd).toBe("/my/repo");
  });

  test("passes --delete-branch and canceled comment to gh pr close", () => {
    const prs = [{ headRefName: "orca/EMI-200-inv-1", number: 5 }];
    execFileSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closePrsForCanceledTask("EMI-200", "/repo");

    const closeArgs = execFileSyncMock.mock.calls[1][1] as string[];
    expect(closeArgs).toContain("--delete-branch");
    const commentIdx = closeArgs.indexOf("--comment");
    expect(commentIdx).toBeGreaterThan(-1);
    expect(closeArgs[commentIdx + 1]).toContain("EMI-200");
    expect(closeArgs[commentIdx + 1]).toContain("canceled");
  });
});
