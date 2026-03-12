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

import { execFileSync, execFile } from "node:child_process";
import {
  findPrForBranch,
  findPrByUrl,
  listOpenPrBranches,
  getMergeCommitSha,
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  getWorkflowRunStatus,
} from "../src/github/index.js";

const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

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
