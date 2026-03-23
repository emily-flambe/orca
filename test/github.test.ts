// ---------------------------------------------------------------------------
// Unit tests for src/github/index.ts — untested functions
// (closePr and closeOrphanedPrs are covered in close-orphaned-prs.test.ts)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

import { execFileSync, execFile } from "node:child_process";
import { git } from "../src/git.js";
import {
  findPrForBranch,
  findPrByUrl,
  getMergeCommitSha,
  getPrCheckStatus,
  getPrCheckStatusSync,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  listOpenPrBranches,
  getWorkflowRunStatus,
  closeSupersededPrs,
  closePrsForCanceledTask,
} from "../src/github/index.js";

const execSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = git as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// findPrForBranch
// ---------------------------------------------------------------------------

describe("findPrForBranch", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns PrInfo when PR found", async () => {
    const pr = {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      state: "OPEN",
      headRefName: "orca/EMI-1-inv-1",
    };
    execSyncMock.mockReturnValue(JSON.stringify([pr]));

    const result = await findPrForBranch("orca/EMI-1-inv-1", "/tmp/repo", 1);

    expect(result).toEqual({
      exists: true,
      url: pr.url,
      number: pr.number,
      merged: false,
      headBranch: pr.headRefName,
      state: "open",
    });
  });

  test("merged is true when state is MERGED", async () => {
    const pr = {
      url: "https://github.com/owner/repo/pull/2",
      number: 2,
      state: "MERGED",
      headRefName: "orca/EMI-2-inv-1",
    };
    execSyncMock.mockReturnValue(JSON.stringify([pr]));

    const result = await findPrForBranch("orca/EMI-2-inv-1", "/tmp/repo", 1);

    expect(result.exists).toBe(true);
    expect(result.merged).toBe(true);
  });

  test("returns exists: false when empty array", async () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await findPrForBranch("orca/no-pr", "/tmp/repo", 1);

    expect(result).toEqual({ exists: false });
  });

  test("returns exists: false on gh failure after maxAttempts", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: network error");
    });

    const result = await findPrForBranch("orca/bad-branch", "/tmp/repo", 1);

    expect(result).toEqual({ exists: false });
  });

  test("calls gh pr list with correct args", async () => {
    const pr = {
      url: "https://github.com/owner/repo/pull/3",
      number: 3,
      state: "OPEN",
      headRefName: "orca/EMI-3-inv-1",
    };
    execSyncMock.mockReturnValue(JSON.stringify([pr]));

    await findPrForBranch("orca/EMI-3-inv-1", "/tmp/repo", 1);

    const [cmd, args, opts] = execSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "list",
      "--head",
      "orca/EMI-3-inv-1",
      "--json",
      "url,number,state,headRefName,isDraft",
      "--limit",
      "1",
    ]);
    expect(opts.cwd).toBe("/tmp/repo");
  });

  test("warns on empty result", async () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await findPrForBranch("orca/no-pr", "/tmp/repo", 1);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no PR found"),
    );
  });

  test("logs error after exhausting attempts on gh failure", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("network timeout");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await findPrForBranch("orca/fail", "/tmp/repo", 1);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("exhausted 1 attempts"),
    );
  });
});

// ---------------------------------------------------------------------------
// findPrByUrl
// ---------------------------------------------------------------------------

describe("findPrByUrl", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns PrInfo on success", () => {
    const data = {
      url: "https://github.com/owner/repo/pull/10",
      number: 10,
      state: "OPEN",
      headRefName: "orca/EMI-10-inv-1",
    };
    execSyncMock.mockReturnValue(JSON.stringify(data));

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/10",
      "/tmp/repo",
    );

    expect(result).toEqual({
      exists: true,
      url: data.url,
      number: data.number,
      merged: false,
      headBranch: data.headRefName,
      state: "open",
    });
  });

  test("returns exists: false when number missing", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify({ url: "https://github.com/owner/repo/pull/11" }),
    );

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/11",
      "/tmp/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("returns exists: false when url missing", () => {
    execSyncMock.mockReturnValue(JSON.stringify({ number: 12 }));

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/12",
      "/tmp/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("returns exists: false on gh failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: not found");
    });

    const result = findPrByUrl(
      "https://github.com/owner/repo/pull/99",
      "/tmp/repo",
    );

    expect(result).toEqual({ exists: false });
  });

  test("logs warning on gh failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: not found");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    findPrByUrl("https://github.com/owner/repo/pull/99", "/tmp/repo");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("findPrByUrl failed"),
    );
  });

  test("calls gh pr view with correct args", () => {
    const prUrl = "https://github.com/owner/repo/pull/13";
    execSyncMock.mockReturnValue(
      JSON.stringify({
        url: prUrl,
        number: 13,
        state: "OPEN",
        headRefName: "orca/x",
      }),
    );

    findPrByUrl(prUrl, "/tmp/repo");

    const [cmd, args, opts] = execSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "view",
      prUrl,
      "--json",
      "url,number,state,headRefName,isDraft",
    ]);
    expect(opts.cwd).toBe("/tmp/repo");
  });

  test("merged is true when state is MERGED", () => {
    const prUrl = "https://github.com/owner/repo/pull/14";
    execSyncMock.mockReturnValue(
      JSON.stringify({
        url: prUrl,
        number: 14,
        state: "MERGED",
        headRefName: "orca/x",
      }),
    );

    const result = findPrByUrl(prUrl, "/tmp/repo");

    expect(result.merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMergeCommitSha (async)
// ---------------------------------------------------------------------------

describe("getMergeCommitSha", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("returns oid on success", async () => {
    const sha = "abc123def456";
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({ mergeCommit: { oid: sha } }),
        stderr: "",
      });
    });

    const result = await getMergeCommitSha(5, "/tmp/repo");
    expect(result).toBe(sha);
  });

  test("returns null when mergeCommit is null", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({ mergeCommit: null }),
        stderr: "",
      });
    });

    const promise = getMergeCommitSha(5, "/tmp/repo");
    // Advance past all retry delays (3 attempts × 2000ms)
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });

  test("returns null after all attempts fail", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh failed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "not found";
      callback(err, null);
    });

    const promise = getMergeCommitSha(99, "/tmp/repo");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBeNull();
  });

  test("calls gh pr view with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({ mergeCommit: { oid: "deadbeef" } }),
        stderr: "",
      });
    });

    await getMergeCommitSha(42, "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "view", "42", "--json", "mergeCommit"]);
  });
});

// ---------------------------------------------------------------------------
// getPrCheckStatus (async)
// ---------------------------------------------------------------------------

describe("getPrCheckStatus", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no_checks for empty checks array", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("no_checks");
  });

  test("returns pending when any check has bucket pending", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "PENDING", bucket: "pending" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("pending");
  });

  test("returns pending when any check has bucket queued", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "build", state: "QUEUED", bucket: "queued" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("pending");
  });

  test("returns failure when any check has bucket fail", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "FAILURE", bucket: "fail" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("failure");
  });

  test("returns success when all checks pass", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "SUCCESS", bucket: "pass" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("success");
  });

  test("returns error on gh CLI failure (after retries)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh failed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "error";
      callback(err, null);
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("error");
  });

  test("returns success on second attempt when first attempt throws", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        const err = new Error("gh transient failure");
        (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "error";
        callback(err, null);
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(null, {
          stdout: JSON.stringify([
            { name: "test", state: "SUCCESS", bucket: "pass" },
          ]),
          stderr: "",
        });
      });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("success");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test("returns no_checks when gh exits with 'no checks reported' stderr", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error(
        "gh command failed: gh pr checks 1 --json name,state,bucket\n" +
          "no checks reported on the 'orca/EMI-1-inv-1' branch",
      );
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "no checks reported on the 'orca/EMI-1-inv-1' branch";
      callback(err, null);
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("no_checks");
  });

  test("returns no_checks immediately on 'no checks reported' (no retry)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error(
        "gh command failed: gh pr checks 1 --json name,state,bucket\n" +
          "no checks reported on the 'main' branch",
      );
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "no checks reported on the 'main' branch";
      callback(err, null);
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("no_checks");
    // Should return immediately without retrying — only 1 call
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("returns error on non-'no checks' gh CLI failure (after retries)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh command failed: network timeout");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "network timeout";
      callback(err, null);
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("error");
    // Should have retried (maxAttempts = 2)
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test("calls gh pr checks with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getPrCheckStatus(7, "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "checks", "7", "--json", "name,state,bucket"]);
  });
});

// ---------------------------------------------------------------------------
// getPrCheckStatusSync
// ---------------------------------------------------------------------------

describe("getPrCheckStatusSync", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no_checks for empty checks array", () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("no_checks");
  });

  test("returns pending when any check has bucket pending", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        { name: "test", state: "PENDING", bucket: "pending" },
        { name: "lint", state: "SUCCESS", bucket: "pass" },
      ]),
    );

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("pending");
  });

  test("returns pending when any check has bucket queued", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([{ name: "build", state: "QUEUED", bucket: "queued" }]),
    );

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("pending");
  });

  test("returns failure when any check has bucket fail", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        { name: "test", state: "FAILURE", bucket: "fail" },
        { name: "lint", state: "SUCCESS", bucket: "pass" },
      ]),
    );

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("failure");
  });

  test("returns success when all checks pass", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        { name: "test", state: "SUCCESS", bucket: "pass" },
        { name: "lint", state: "SUCCESS", bucket: "pass" },
      ]),
    );

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("success");
  });

  test("returns no_checks when gh exits with 'no checks reported' stderr", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error(
        "gh command failed: gh pr checks 1 --json name,state,bucket\n" +
          "no checks reported on the 'orca/EMI-1-inv-1' branch",
      );
    });

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("no_checks");
  });

  test("returns no_checks when stderr has 'No checks reported' (case insensitive)", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error(
        "gh command failed: gh pr checks 5 --json name,state,bucket\n" +
          "No Checks Reported on the 'feature-branch' branch",
      );
    });

    const result = getPrCheckStatusSync(5, "/tmp/repo");
    expect(result).toBe("no_checks");
  });

  test("returns error on non-'no checks' gh CLI failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh command failed: gh pr checks 1\nnetwork timeout");
    });

    const result = getPrCheckStatusSync(1, "/tmp/repo");
    expect(result).toBe("error");
  });

  test("calls gh pr checks with correct args", () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));

    getPrCheckStatusSync(7, "/tmp/repo");

    const [cmd, args, opts] = execSyncMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "checks", "7", "--json", "name,state,bucket"]);
    expect(opts.cwd).toBe("/tmp/repo");
  });
});

// ---------------------------------------------------------------------------
// getPrMergeState (async)
// ---------------------------------------------------------------------------

describe("getPrMergeState", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns mergeable and mergeStateStatus on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        stderr: "",
      });
    });

    const result = await getPrMergeState(1, "/tmp/repo");
    expect(result).toEqual({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
  });

  test("returns UNKNOWN values on failure", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh failed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "error";
      callback(err, null);
    });

    const result = await getPrMergeState(1, "/tmp/repo");
    expect(result).toEqual({
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
  });

  test("calls gh pr view with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        stderr: "",
      });
    });

    await getPrMergeState(99, "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "view",
      "99",
      "--json",
      "mergeable,mergeStateStatus",
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergePr (async)
// ---------------------------------------------------------------------------

describe("mergePr", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns merged: true on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    const result = await mergePr(1, "/tmp/repo");
    expect(result).toEqual({ merged: true });
  });

  test("returns merged: false with error on failure", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("merge failed: conflicts");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "conflict";
      callback(err, null);
    });

    const result = await mergePr(1, "/tmp/repo");
    expect(result).toMatchObject({ merged: false });
    if (!result.merged) {
      expect(result.error).toContain("gh command failed");
    }
  });

  test("calls gh pr merge with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    await mergePr(42, "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "merge", "42", "--squash", "--delete-branch"]);
  });
});

// ---------------------------------------------------------------------------
// updatePrBranch (async)
// ---------------------------------------------------------------------------

describe("updatePrBranch", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns true on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    const result = await updatePrBranch(1, "/tmp/repo");
    expect(result).toBe(true);
  });

  test("returns false on failure", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh failed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "error";
      callback(err, null);
    });

    const result = await updatePrBranch(1, "/tmp/repo");
    expect(result).toBe(false);
  });

  test("calls gh pr update-branch with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    await updatePrBranch(77, "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "update-branch", "77"]);
  });
});

// ---------------------------------------------------------------------------
// listOpenPrBranches
// ---------------------------------------------------------------------------

describe("listOpenPrBranches", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns Set of branch names on success", () => {
    execSyncMock.mockReturnValue(
      JSON.stringify([
        { headRefName: "orca/EMI-1-inv-1" },
        { headRefName: "orca/EMI-2-inv-2" },
        { headRefName: "feature/something" },
      ]),
    );

    const result = listOpenPrBranches("/tmp/repo");

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has("orca/EMI-1-inv-1")).toBe(true);
    expect(result.has("orca/EMI-2-inv-2")).toBe(true);
    expect(result.has("feature/something")).toBe(true);
  });

  test("returns empty Set on failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: not found");
    });

    const result = listOpenPrBranches("/tmp/repo");
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  test("returns empty Set for empty list", () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));

    const result = listOpenPrBranches("/tmp/repo");
    expect(result.size).toBe(0);
  });

  test("calls gh pr list with correct args", () => {
    execSyncMock.mockReturnValue(JSON.stringify([]));

    listOpenPrBranches("/tmp/repo");

    const [cmd, args, opts] = execSyncMock.mock.calls[0];
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
    expect(opts.cwd).toBe("/tmp/repo");
  });
});

// ---------------------------------------------------------------------------
// getWorkflowRunStatus (async)
// ---------------------------------------------------------------------------

describe("getWorkflowRunStatus", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no_runs for empty array", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("no_runs");
  });

  test("returns in_progress when any run has status in_progress", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "success" },
        ]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status queued", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([{ status: "queued", conclusion: null }]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status waiting", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([{ status: "waiting", conclusion: null }]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("in_progress");
  });

  test("returns in_progress when any run has status pending", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([{ status: "pending", conclusion: null }]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("in_progress");
  });

  test("returns failure when any run has conclusion failure", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { status: "completed", conclusion: "failure" },
          { status: "completed", conclusion: "success" },
        ]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("failure");
  });

  test("returns failure when any run has conclusion cancelled", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { status: "completed", conclusion: "cancelled" },
        ]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("failure");
  });

  test("returns failure when any run has conclusion timed_out", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { status: "completed", conclusion: "timed_out" },
        ]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("failure");
  });

  test("returns success when all runs completed successfully", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "skipped" },
          { status: "completed", conclusion: "neutral" },
        ]),
        stderr: "",
      });
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("success");
  });

  test("returns no_runs on gh CLI failure", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh failed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "error";
      callback(err, null);
    });

    const result = await getWorkflowRunStatus("abc123", "/tmp/repo");
    expect(result).toBe("no_runs");
  });

  test("calls gh run list with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getWorkflowRunStatus("deadbeef", "/tmp/repo");

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "run",
      "list",
      "--commit",
      "deadbeef",
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
  const repoPath = "/tmp/repo";
  const branchName = "orca/EMI-1-inv-1";

  beforeEach(() => {
    gitMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns success: true when all steps succeed", () => {
    // fetch, worktree add, checkout, rebase, push, worktree remove (cleanup)
    gitMock.mockReturnValue("");

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({ success: true });
  });

  test("returns fetch failed when git fetch throws", () => {
    gitMock.mockImplementationOnce(() => {
      throw new Error("Could not resolve host: github.com");
    });

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("fetch failed"),
    });
  });

  test("returns worktree add failed when git worktree add throws", () => {
    gitMock
      .mockImplementationOnce(() => "") // fetch succeeds
      .mockImplementationOnce(() => {
        throw new Error("worktree: already exists");
      }); // worktree add fails

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("worktree add failed"),
    });
  });

  test("returns checkout failed when git checkout throws", () => {
    gitMock
      .mockImplementationOnce(() => "") // fetch
      .mockImplementationOnce(() => "") // worktree add
      .mockImplementationOnce(() => {
        throw new Error("pathspec not found");
      }); // checkout fails

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("checkout failed"),
    });
  });

  test("returns hasConflicts: true when rebase fails", () => {
    gitMock
      .mockImplementationOnce(() => "") // fetch
      .mockImplementationOnce(() => "") // worktree add
      .mockImplementationOnce(() => "") // checkout
      .mockImplementationOnce(() => {
        throw new Error("CONFLICT");
      }) // rebase fails
      .mockImplementationOnce(() => "") // rebase --abort
      .mockImplementationOnce(() => ""); // worktree remove (cleanup)

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({ success: false, hasConflicts: true });
  });

  test("returns push failed when git push throws", () => {
    gitMock
      .mockImplementationOnce(() => "") // fetch
      .mockImplementationOnce(() => "") // worktree add
      .mockImplementationOnce(() => "") // checkout
      .mockImplementationOnce(() => "") // rebase
      .mockImplementationOnce(() => {
        throw new Error("push rejected");
      }) // push fails
      .mockImplementationOnce(() => ""); // worktree remove (cleanup)

    const result = rebasePrBranch(branchName, repoPath);
    expect(result).toEqual({
      success: false,
      hasConflicts: false,
      error: expect.stringContaining("push failed"),
    });
  });
});

// ---------------------------------------------------------------------------
// closeSupersededPrs
// ---------------------------------------------------------------------------

describe("closeSupersededPrs", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("closes PRs matching prefix, skipping the new branch", () => {
    const prs = [
      { headRefName: "orca/EMI-10-inv-1", number: 100 }, // old — should be closed
      { headRefName: "orca/EMI-10-inv-2", number: 101 }, // new — skip
      { headRefName: "orca/EMI-99-inv-1", number: 102 }, // different task — skip
    ];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs)) // gh pr list
      .mockReturnValueOnce("") // gh pr close #100
      .mockReturnValueOnce(""); // (just in case)

    const count = closeSupersededPrs(
      "EMI-10",
      101,
      2,
      "orca/EMI-10-inv-2",
      "/tmp/repo",
    );

    expect(count).toBe(1);
  });

  test("returns 0 when no PRs match prefix", () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([{ headRefName: "orca/EMI-99-inv-1", number: 200 }]),
    );

    const count = closeSupersededPrs(
      "EMI-10",
      101,
      2,
      "orca/EMI-10-inv-2",
      "/tmp/repo",
    );

    expect(count).toBe(0);
  });

  test("returns 0 on gh pr list failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: network error");
    });

    const count = closeSupersededPrs(
      "EMI-10",
      101,
      2,
      "orca/EMI-10-inv-2",
      "/tmp/repo",
    );

    expect(count).toBe(0);
  });

  test("uses custom comment when provided", () => {
    const prs = [{ headRefName: "orca/EMI-10-inv-1", number: 100 }];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closeSupersededPrs(
      "EMI-10",
      101,
      2,
      "orca/EMI-10-inv-2",
      "/tmp/repo",
      "Custom close message.",
    );

    const [, args] = execSyncMock.mock.calls[1];
    expect(args).toContain("Custom close message.");
  });

  test("uses default comment referencing new PR number when no custom comment", () => {
    const prs = [{ headRefName: "orca/EMI-10-inv-1", number: 100 }];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closeSupersededPrs("EMI-10", 101, 2, "orca/EMI-10-inv-2", "/tmp/repo");

    const [, args] = execSyncMock.mock.calls[1];
    const commentArg = args[args.indexOf("--comment") + 1] as string;
    expect(commentArg).toContain("#101");
  });

  test("calls gh pr close with --delete-branch", () => {
    const prs = [{ headRefName: "orca/EMI-10-inv-1", number: 100 }];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closeSupersededPrs("EMI-10", 101, 2, "orca/EMI-10-inv-2", "/tmp/repo");

    const [cmd, args, opts] = execSyncMock.mock.calls[1];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("pr");
    expect(args[1]).toBe("close");
    expect(args[2]).toBe("100");
    expect(args).toContain("--delete-branch");
    expect(opts.cwd).toBe("/tmp/repo");
  });

  test("continues closing remaining PRs when one close fails", () => {
    const prs = [
      { headRefName: "orca/EMI-10-inv-1", number: 100 },
      { headRefName: "orca/EMI-10-inv-3", number: 103 },
    ];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs)) // gh pr list
      .mockImplementationOnce(() => {
        throw new Error("gh: PR 100 not found");
      }) // close #100 fails
      .mockReturnValueOnce(""); // close #103 succeeds

    const count = closeSupersededPrs(
      "EMI-10",
      104,
      4,
      "orca/EMI-10-inv-4",
      "/tmp/repo",
    );

    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// closePrsForCanceledTask
// ---------------------------------------------------------------------------

describe("closePrsForCanceledTask", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("closes all PRs matching task prefix and returns count", () => {
    const prs = [
      { headRefName: "orca/EMI-20-inv-1", number: 200 },
      { headRefName: "orca/EMI-20-inv-2", number: 201 },
      { headRefName: "orca/EMI-99-inv-1", number: 300 }, // different task
    ];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("") // close #200
      .mockReturnValueOnce(""); // close #201

    const count = closePrsForCanceledTask("EMI-20", "/tmp/repo");

    expect(count).toBe(2);
  });

  test("returns 0 when no PRs match", () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify([{ headRefName: "orca/EMI-99-inv-1", number: 300 }]),
    );

    const count = closePrsForCanceledTask("EMI-20", "/tmp/repo");

    expect(count).toBe(0);
  });

  test("returns 0 on gh pr list failure", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh: authentication failed");
    });

    const count = closePrsForCanceledTask("EMI-20", "/tmp/repo");

    expect(count).toBe(0);
  });

  test("calls gh pr close with --delete-branch and canceled comment", () => {
    const prs = [{ headRefName: "orca/EMI-20-inv-1", number: 200 }];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockReturnValueOnce("");

    closePrsForCanceledTask("EMI-20", "/tmp/repo");

    const [cmd, args, opts] = execSyncMock.mock.calls[1];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("pr");
    expect(args[1]).toBe("close");
    expect(args[2]).toBe("200");
    expect(args).toContain("--delete-branch");
    const commentArg = args[args.indexOf("--comment") + 1] as string;
    expect(commentArg).toContain("EMI-20");
    expect(opts.cwd).toBe("/tmp/repo");
  });

  test("continues closing remaining PRs when one close fails", () => {
    const prs = [
      { headRefName: "orca/EMI-20-inv-1", number: 200 },
      { headRefName: "orca/EMI-20-inv-2", number: 201 },
    ];
    execSyncMock
      .mockReturnValueOnce(JSON.stringify(prs))
      .mockImplementationOnce(() => {
        throw new Error("gh: PR not found");
      }) // close #200 fails
      .mockReturnValueOnce(""); // close #201 succeeds

    const count = closePrsForCanceledTask("EMI-20", "/tmp/repo");

    expect(count).toBe(1);
  });

  test("returns 0 when list is empty", () => {
    execSyncMock.mockReturnValueOnce(JSON.stringify([]));

    const count = closePrsForCanceledTask("EMI-20", "/tmp/repo");

    expect(count).toBe(0);
  });
});
