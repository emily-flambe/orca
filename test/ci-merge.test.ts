// ---------------------------------------------------------------------------
// CI merge activity tests — checkCiStatus and attemptMerge
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { checkCiStatus, attemptMerge } from "../src/inngest/activities/ci-merge.js";
import type { PrCheckStatus, PrMergeState, PrInfo } from "../src/github/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/github/index.js", () => ({
  getPrCheckStatus: vi.fn(),
  getPrMergeState: vi.fn(),
  mergePr: vi.fn(),
  updatePrBranch: vi.fn(),
  rebasePrBranch: vi.fn(),
  getMergeCommitSha: vi.fn(),
  findPrForBranch: vi.fn(),
}));

import {
  getPrCheckStatus,
  getPrMergeState,
  mergePr,
  updatePrBranch,
  rebasePrBranch,
  getMergeCommitSha,
  findPrForBranch,
} from "../src/github/index.js";

const mockGetPrCheckStatus = vi.mocked(getPrCheckStatus);
const mockGetPrMergeState = vi.mocked(getPrMergeState);
const mockMergePr = vi.mocked(mergePr);
const mockUpdatePrBranch = vi.mocked(updatePrBranch);
const mockRebasePrBranch = vi.mocked(rebasePrBranch);
const mockGetMergeCommitSha = vi.mocked(getMergeCommitSha);
const mockFindPrForBranch = vi.mocked(findPrForBranch);

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// checkCiStatus
// ---------------------------------------------------------------------------

describe("checkCiStatus", () => {
  const input = { prNumber: 42, repoPath: "/repo" };

  test("returns pending when checks are still running", async () => {
    mockGetPrCheckStatus.mockResolvedValue("pending");
    const result = await checkCiStatus(input);
    expect(result.status).toBe("pending");
  });

  test("returns success when checks pass", async () => {
    mockGetPrCheckStatus.mockResolvedValue("success");
    const result = await checkCiStatus(input);
    expect(result.status).toBe("success");
  });

  test("returns success when no checks are configured", async () => {
    mockGetPrCheckStatus.mockResolvedValue("no_checks");
    const result = await checkCiStatus(input);
    expect(result.status).toBe("success");
  });

  test("returns failure when checks fail", async () => {
    mockGetPrCheckStatus.mockResolvedValue("failure");
    const result = await checkCiStatus(input);
    expect(result.status).toBe("failure");
  });

  test("returns error when gh CLI fails (transient)", async () => {
    mockGetPrCheckStatus.mockResolvedValue("error");
    const result = await checkCiStatus(input);
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// attemptMerge
// ---------------------------------------------------------------------------

describe("attemptMerge", () => {
  const baseInput = {
    prNumber: 42,
    prBranchName: "orca/TEST-1-inv-1",
    repoPath: "/repo",
    mergeAttempt: 0,
    maxMergeAttempts: 3,
  };

  test("merges successfully when merge state is CLEAN", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: true });
    mockGetMergeCommitSha.mockResolvedValue("abc123");

    const result = await attemptMerge(baseInput);

    expect(result.status).toBe("merged");
    expect(result.mergeCommitSha).toBe("abc123");
    expect(mockMergePr).toHaveBeenCalledWith(42, "/repo");
  });

  test("returns behind when PR is behind base branch", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    mockUpdatePrBranch.mockResolvedValue(true);

    const result = await attemptMerge(baseInput);

    expect(result.status).toBe("behind");
    expect(result.mergeCommitSha).toBeNull();
    expect(mockUpdatePrBranch).toHaveBeenCalledWith(42, "/repo");
    expect(mockMergePr).not.toHaveBeenCalled();
  });

  test("returns conflicting when PR has merge conflicts", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "CONFLICTING",
      mergeStateStatus: "CONFLICTING",
    });

    const result = await attemptMerge(baseInput);

    expect(result.status).toBe("conflicting");
    expect(result.mergeCommitSha).toBeNull();
    expect(mockMergePr).not.toHaveBeenCalled();
  });

  test("tries rebase on first merge failure", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: false, error: "not up to date" });
    mockFindPrForBranch.mockReturnValue({ exists: true, merged: false });
    mockRebasePrBranch.mockReturnValue({ success: true });

    const result = await attemptMerge({ ...baseInput, mergeAttempt: 0 });

    expect(result.status).toBe("behind");
    expect(mockRebasePrBranch).toHaveBeenCalledWith(
      "orca/TEST-1-inv-1",
      "/repo",
    );
  });

  test("returns conflicting when rebase has conflicts", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: false, error: "merge conflict" });
    mockFindPrForBranch.mockReturnValue({ exists: true, merged: false });
    mockRebasePrBranch.mockReturnValue({ success: false, hasConflicts: true });

    const result = await attemptMerge({ ...baseInput, mergeAttempt: 0 });

    expect(result.status).toBe("conflicting");
  });

  test("detects already-merged PR", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: false, error: "already merged" });
    mockFindPrForBranch.mockReturnValue({
      exists: true,
      merged: true,
      url: "https://github.com/org/repo/pull/42",
      number: 42,
    });
    mockGetMergeCommitSha.mockResolvedValue("def456");

    const result = await attemptMerge(baseInput);

    expect(result.status).toBe("already_merged");
    expect(result.mergeCommitSha).toBe("def456");
  });

  test("returns failed with retry message when attempts remain", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({
      merged: false,
      error: "internal error",
    });
    mockFindPrForBranch.mockReturnValue({ exists: true, merged: false });
    // mergeAttempt=1 means rebase is not attempted (only on attempt 0)
    // and we still have attempts left (1+1 < 3)

    const result = await attemptMerge({ ...baseInput, mergeAttempt: 1 });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("2/3");
    expect(result.message).toContain("Will retry");
  });

  test("returns failed when max attempts exhausted", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({
      merged: false,
      error: "blocked by status check",
    });
    mockFindPrForBranch.mockReturnValue({ exists: true, merged: false });

    const result = await attemptMerge({
      ...baseInput,
      mergeAttempt: 2,
      maxMergeAttempts: 3,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("3 attempts");
    expect(result.message).toContain("Exhausted retries");
  });

  test("does not attempt rebase on non-first failure", async () => {
    mockGetPrMergeState.mockResolvedValue({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    mockMergePr.mockResolvedValue({ merged: false, error: "some error" });
    mockFindPrForBranch.mockReturnValue({ exists: true, merged: false });

    await attemptMerge({ ...baseInput, mergeAttempt: 1 });

    expect(mockRebasePrBranch).not.toHaveBeenCalled();
  });
});
