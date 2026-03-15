// ---------------------------------------------------------------------------
// Adversarial tests for src/github/index.ts — exposes gaps in github.test.ts
// ---------------------------------------------------------------------------
//
// These tests target:
// 1. getMergeCommitSha retry logic — existing tests are false positives
//    (they pass even if retry is removed entirely)
// 2. getPrCheckStatus priority ordering — pending+fail mixed case untested
// 3. Async function cwd propagation — never verified in any existing test
// 4. rebasePrBranch argument verification — no git call args checked anywhere
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

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

import { execFile } from "node:child_process";
import { git } from "../src/git.js";
import {
  getMergeCommitSha,
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  getWorkflowRunStatus,
  rebasePrBranch,
  findPrForBranch,
} from "../src/github/index.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = git as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// BUG 1: getMergeCommitSha retry logic — existing tests are false positives
//
// The existing tests "returns null when mergeCommit is null" and
// "returns null after all attempts fail" BOTH pass even if the implementation
// removes retry logic entirely (returns null on first attempt).
// They only check the final return value, not the call count.
// ---------------------------------------------------------------------------

describe("getMergeCommitSha — retry logic (false positive exposure)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("retries exactly 3 times when mergeCommit is always null", async () => {
    // Always returns null mergeCommit. Implementation should try 3 times.
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({ mergeCommit: null }),
        stderr: "",
      });
    });

    const promise = getMergeCommitSha(5, "/tmp/repo");
    await vi.runAllTimersAsync();
    await promise;

    // THIS IS THE CRITICAL ASSERTION: existing tests never verify call count.
    // If retry is removed, execFileMock would be called only once, not 3 times.
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  test("retries exactly 3 times when gh always throws", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error("gh failed"), null);
    });

    const promise = getMergeCommitSha(99, "/tmp/repo");
    await vi.runAllTimersAsync();
    await promise;

    // Existing test only checks return value (null). Doesn't verify 3 attempts.
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  test("returns oid on 3rd attempt after 2 null mergeCommits", async () => {
    // First 2 attempts: mergeCommit is null (PR not yet merged on GitHub side)
    // 3rd attempt: mergeCommit has oid
    // This tests the REAL use case: waiting for GitHub to propagate merge.
    // If retry is removed, this returns null instead of the oid.
    const sha = "abc123def456";
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(null, {
          stdout: JSON.stringify({ mergeCommit: null }),
          stderr: "",
        });
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(null, {
          stdout: JSON.stringify({ mergeCommit: null }),
          stderr: "",
        });
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(null, {
          stdout: JSON.stringify({ mergeCommit: { oid: sha } }),
          stderr: "",
        });
      });

    const promise = getMergeCommitSha(5, "/tmp/repo");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(sha);
  });

  test("returns oid on 3rd attempt after 2 errors", async () => {
    // First 2 attempts throw, 3rd succeeds.
    // If retry on error is removed, returns null instead of oid.
    const sha = "deadbeef1234";
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(new Error("network timeout"), null);
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(new Error("network timeout"), null);
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        callback(null, {
          stdout: JSON.stringify({ mergeCommit: { oid: sha } }),
          stderr: "",
        });
      });

    const promise = getMergeCommitSha(7, "/tmp/repo");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(sha);
  });

  test("calls gh with correct cwd on all 3 retry attempts", async () => {
    // Existing 'calls gh pr view with correct args' test does NOT check opts.cwd.
    // If ghAsync was ignoring the cwd parameter, this would catch it.
    const sha = "cafebabe";
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({ mergeCommit: { oid: sha } }),
        stderr: "",
      });
    });

    await getMergeCommitSha(42, "/some/specific/repo");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/some/specific/repo");
  });
});

// ---------------------------------------------------------------------------
// BUG 2: getPrCheckStatus priority ordering — missing mixed case
//
// The source checks pending BEFORE failure. This means if a PR has one pending
// check and one failed check, it returns 'pending' not 'failure'.
// No existing test covers this case, so swapping the priority order would go
// undetected.
// ---------------------------------------------------------------------------

describe("getPrCheckStatus — priority ordering (missing coverage)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns pending (not failure) when both pending and fail buckets present", async () => {
    // This is the critical priority case. Source checks pending FIRST.
    // If someone swaps the order to check fail first, this test fails.
    // The existing test suite has no case with BOTH pending and fail.
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "FAILURE", bucket: "fail" },
          { name: "build", state: "PENDING", bucket: "pending" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    // pending takes priority over fail — still waiting, don't mark as failed yet
    expect(result).toBe("pending");
  });

  test("returns pending when queued+fail mixed (queued takes priority)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "deploy", state: "FAILURE", bucket: "fail" },
          { name: "build", state: "QUEUED", bucket: "queued" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("pending");
  });

  test("returns success for checks with bucket 'skipping' (treated as pass)", async () => {
    // 'skipping' is not pending, not fail — treated as pass → overall success.
    // Source doesn't explicitly handle 'skipping' but it falls through to 'success'.
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "optional-job", state: "SKIPPED", bucket: "skipping" },
          { name: "test", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getPrCheckStatus(1, "/tmp/repo");
    expect(result).toBe("success");
  });

  test("calls gh pr checks with correct cwd", async () => {
    // No existing test verifies cwd for getPrCheckStatus.
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getPrCheckStatus(7, "/specific/repo/path");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/specific/repo/path");
  });
});

// ---------------------------------------------------------------------------
// BUG 3: Async function cwd propagation — never checked in existing tests
//
// Every async gh wrapper (getPrMergeState, mergePr, updatePrBranch,
// getWorkflowRunStatus) has a 'calls ... with correct args' test, but NONE
// of them verify opts.cwd. The cwd parameter is critical for multi-repo support.
// ---------------------------------------------------------------------------

describe("getPrMergeState — cwd propagation (missing verification)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("passes cwd to gh pr view", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify({
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
        }),
        stderr: "",
      });
    });

    await getPrMergeState(99, "/my/repo");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/my/repo");
  });
});

describe("mergePr — cwd propagation (missing verification)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("passes cwd to gh pr merge", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    await mergePr(42, "/specific/cwd");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/specific/cwd");
  });
});

describe("updatePrBranch — cwd propagation (missing verification)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("passes cwd to gh pr update-branch", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    await updatePrBranch(77, "/my/specific/repo");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/my/specific/repo");
  });
});

describe("getWorkflowRunStatus — cwd propagation (missing verification)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("passes cwd to gh run list", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getWorkflowRunStatus("deadbeef", "/workflow/repo");

    const [_cmd, _args, opts] = execFileMock.mock.calls[0];
    expect(opts.cwd).toBe("/workflow/repo");
  });
});

// ---------------------------------------------------------------------------
// BUG 4: rebasePrBranch — no git call args verified in any existing test
//
// The entire rebasePrBranch test suite only checks return values.
// It never verifies:
//   - checkout uses correct branch tracking (origin/<branchName>)
//   - push uses --force-with-lease (not --force, which is more destructive)
//   - worktree add uses --detach (not checking out the branch)
//   - each step uses the correct cwd (repoPath vs tempPath)
// ---------------------------------------------------------------------------

describe("rebasePrBranch — argument verification (missing in existing tests)", () => {
  const repoPath = "/tmp/repo";
  const branchName = "orca/EMI-1-inv-1";

  beforeEach(() => {
    gitMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("checkout uses origin/<branchName> as start point", () => {
    // Source: git(['checkout', '-B', branchName, `origin/${branchName}`], { cwd: tempPath })
    // This ensures we track the remote branch state, not a potentially stale local ref.
    // No existing test verifies this arg.
    gitMock.mockReturnValue("");

    rebasePrBranch(branchName, repoPath);

    // Call 3 is the checkout (0: fetch, 1: worktree add, 2: checkout)
    const checkoutCall = gitMock.mock.calls[2];
    const checkoutArgs = checkoutCall[0];
    expect(checkoutArgs).toEqual([
      "checkout",
      "-B",
      branchName,
      `origin/${branchName}`,
    ]);
  });

  test("push uses --force-with-lease (not --force)", () => {
    // Source: git(['push', '--force-with-lease', 'origin', branchName], { cwd: tempPath })
    // '--force-with-lease' is safer than '--force': fails if remote has unexpected commits.
    // No existing test verifies this critical safety flag.
    gitMock.mockReturnValue("");

    rebasePrBranch(branchName, repoPath);

    // Call 4 is the push (0: fetch, 1: worktree add, 2: checkout, 3: rebase, 4: push)
    const pushCall = gitMock.mock.calls[4];
    const pushArgs = pushCall[0];
    expect(pushArgs).toContain("--force-with-lease");
    expect(pushArgs).not.toContain("--force");
    // The full expected args:
    expect(pushArgs).toEqual([
      "push",
      "--force-with-lease",
      "origin",
      branchName,
    ]);
  });

  test("fetch and worktree add use repoPath as cwd, not tempPath", () => {
    // fetch and worktree add must run in repoPath.
    // checkout, rebase, push must run in tempPath.
    // No existing test verifies the cwd distinction.
    gitMock.mockReturnValue("");

    rebasePrBranch(branchName, repoPath);

    const fetchCall = gitMock.mock.calls[0];
    expect(fetchCall[1]).toEqual({ cwd: repoPath });

    const worktreeAddCall = gitMock.mock.calls[1];
    expect(worktreeAddCall[1]).toEqual({ cwd: repoPath });
  });

  test("checkout, rebase, and push use tempPath as cwd (not repoPath)", () => {
    gitMock.mockReturnValue("");

    rebasePrBranch(branchName, repoPath);

    // Get the tempPath from the worktree add call
    const worktreeAddArgs = gitMock.mock.calls[1][0];
    const tempPath = worktreeAddArgs[worktreeAddArgs.length - 1]; // last arg is tempPath

    const checkoutCall = gitMock.mock.calls[2];
    expect(checkoutCall[1].cwd).toBe(tempPath);

    const rebaseCall = gitMock.mock.calls[3];
    expect(rebaseCall[1].cwd).toBe(tempPath);

    const pushCall = gitMock.mock.calls[4];
    expect(pushCall[1].cwd).toBe(tempPath);
  });

  test("worktree add uses --detach flag", () => {
    // Source: git(['worktree', 'add', '--force', '--detach', tempPath], { cwd: repoPath })
    // '--detach' is required: we don't want to check out the branch in the worktree,
    // we'll do that manually with 'checkout -B'. No existing test verifies this.
    gitMock.mockReturnValue("");

    rebasePrBranch(branchName, repoPath);

    const worktreeAddCall = gitMock.mock.calls[1];
    const worktreeAddArgs = worktreeAddCall[0];
    expect(worktreeAddArgs).toContain("--detach");
    expect(worktreeAddArgs[0]).toBe("worktree");
    expect(worktreeAddArgs[1]).toBe("add");
  });

  test("rebase --abort is called in tempPath cwd when rebase conflicts", () => {
    // Source line 720-723:
    //   try { git(['rebase', '--abort'], { cwd: tempPath }) } catch {}
    // No existing test verifies the --abort call's cwd.
    gitMock
      .mockImplementationOnce(() => "") // fetch
      .mockImplementationOnce(() => "") // worktree add
      .mockImplementationOnce(() => "") // checkout
      .mockImplementationOnce(() => {
        throw new Error("CONFLICT");
      }) // rebase throws
      .mockImplementationOnce(() => "") // rebase --abort
      .mockImplementationOnce(() => ""); // worktree remove cleanup

    rebasePrBranch(branchName, repoPath);

    // Call 4 should be rebase --abort
    const abortCall = gitMock.mock.calls[4];
    expect(abortCall[0]).toEqual(["rebase", "--abort"]);

    // Get tempPath from worktree add call
    const worktreeAddArgs = gitMock.mock.calls[1][0];
    const tempPath = worktreeAddArgs[worktreeAddArgs.length - 1];
    expect(abortCall[1].cwd).toBe(tempPath);
  });

  test("branch name with slashes is sanitized in tempPath", () => {
    // Source: const safeBranch = branchName.replace(/\//g, '-')
    // branchName 'orca/EMI-1-inv-1' becomes 'orca-EMI-1-inv-1' in tempPath.
    // This prevents invalid path characters on some filesystems.
    gitMock.mockReturnValue("");

    const slashyBranch = "orca/EMI-100-inv-200";
    rebasePrBranch(slashyBranch, repoPath);

    const worktreeAddArgs = gitMock.mock.calls[1][0];
    const tempPath = worktreeAddArgs[worktreeAddArgs.length - 1];

    // tempPath should NOT contain the slash from the branch name
    expect(tempPath).not.toContain("orca/EMI-100-inv-200");
    // It should contain the sanitized form
    expect(tempPath).toContain("orca-EMI-100-inv-200");
  });
});

// ---------------------------------------------------------------------------
// BUG 5: findPrForBranch retry count — no test verifies multi-attempt behavior
//
// All existing findPrForBranch tests pass maxAttempts=1. The retry behavior
// with multiple attempts is completely untested.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

const execSyncMock2 = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("findPrForBranch — retry count verification (missing coverage)", () => {
  beforeEach(() => {
    execSyncMock2.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls gh exactly maxAttempts times when result is always empty", async () => {
    execSyncMock2.mockReturnValue(JSON.stringify([]));

    await findPrForBranch("orca/no-pr", "/tmp/repo", 1);

    // With maxAttempts=1: exactly 1 call, then returns { exists: false }.
    // If implementation broke the loop entry, it might call 0 times.
    expect(execSyncMock2).toHaveBeenCalledTimes(1);
  });

  test("calls gh exactly maxAttempts times when gh always throws", async () => {
    execSyncMock2.mockImplementation(() => {
      throw new Error("network error");
    });

    await findPrForBranch("orca/fail", "/tmp/repo", 1);

    expect(execSyncMock2).toHaveBeenCalledTimes(1);
  });

  test("returns PR on 2nd attempt when first attempt returns empty", async () => {
    // First call returns empty (GitHub API lag), second returns the PR.
    // If retry is removed entirely, this would call gh once, get empty, return false.
    vi.useFakeTimers();
    const pr = {
      url: "https://github.com/owner/repo/pull/1",
      number: 1,
      state: "OPEN",
      headRefName: "orca/EMI-1-inv-1",
    };
    execSyncMock2
      .mockReturnValueOnce(JSON.stringify([])) // first attempt: empty
      .mockReturnValueOnce(JSON.stringify([pr])); // second attempt: found

    const promise = findPrForBranch("orca/EMI-1-inv-1", "/tmp/repo", 2);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.exists).toBe(true);
    expect(result.number).toBe(1);
    expect(execSyncMock2).toHaveBeenCalledTimes(2);
  });
});
