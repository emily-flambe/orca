// ---------------------------------------------------------------------------
// Deploy monitor activity tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { WorkflowRunStatus } from "../src/github/index.js";

// Mock getWorkflowRunStatus before importing the module under test
vi.mock("../src/github/index.js", () => ({
  getWorkflowRunStatus: vi.fn(),
}));

import { checkDeployStatus } from "../src/inngest/activities/deploy-monitor.js";
import { getWorkflowRunStatus } from "../src/github/index.js";

const mockedGetWorkflowRunStatus = vi.mocked(getWorkflowRunStatus);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

const BASE_INPUT = {
  mergeCommitSha: "abc123def456",
  repoPath: "/tmp/test-repo",
  deployStartedAt: minutesAgo(5),
  deployTimeoutMin: 30,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkDeployStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns in_progress when workflow is still running", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("in_progress");

    const result = await checkDeployStatus(BASE_INPUT);

    expect(result.status).toBe("in_progress");
    expect(result.message).toContain("in progress");
    expect(mockedGetWorkflowRunStatus).toHaveBeenCalledWith(
      BASE_INPUT.mergeCommitSha,
      BASE_INPUT.repoPath,
    );
  });

  test("returns success when workflow succeeds", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("success");

    const result = await checkDeployStatus(BASE_INPUT);

    expect(result.status).toBe("success");
    expect(result.message).toContain("succeeded");
    expect(result.message).toContain(BASE_INPUT.mergeCommitSha);
  });

  test("returns failure when workflow fails", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("failure");

    const result = await checkDeployStatus(BASE_INPUT);

    expect(result.status).toBe("failure");
    expect(result.message).toContain("failed");
    expect(result.message).toContain(BASE_INPUT.mergeCommitSha);
  });

  test("returns in_progress when no workflow runs found yet", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("no_runs");

    const result = await checkDeployStatus(BASE_INPUT);

    expect(result.status).toBe("in_progress");
    expect(result.message).toContain("No workflow runs found");
  });

  test("returns timed_out when deploy exceeds timeout", async () => {
    const input = {
      ...BASE_INPUT,
      deployStartedAt: minutesAgo(60),
      deployTimeoutMin: 30,
    };

    const result = await checkDeployStatus(input);

    expect(result.status).toBe("timed_out");
    expect(result.message).toContain("timed out");
    expect(result.message).toContain("30min");
    // Should not call GitHub API when already timed out
    expect(mockedGetWorkflowRunStatus).not.toHaveBeenCalled();
  });

  test("does not time out when within timeout window", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("in_progress");

    const input = {
      ...BASE_INPUT,
      deployStartedAt: minutesAgo(10),
      deployTimeoutMin: 30,
    };

    const result = await checkDeployStatus(input);

    expect(result.status).toBe("in_progress");
    expect(mockedGetWorkflowRunStatus).toHaveBeenCalled();
  });

  test("handles pending status from GitHub as in_progress", async () => {
    mockedGetWorkflowRunStatus.mockResolvedValue("pending");

    const result = await checkDeployStatus(BASE_INPUT);

    expect(result.status).toBe("in_progress");
    expect(result.message).toContain("in progress");
  });
});
