import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import TaskDetail from "../TaskDetail";
import type { TaskWithInvocations, Invocation } from "../../types";

vi.mock("../../hooks/useApi", () => ({
  fetchTaskDetail: vi.fn(),
  abortInvocation: vi.fn(),
  retryTask: vi.fn().mockResolvedValue({}),
  updateTaskStatus: vi.fn().mockResolvedValue({}),
}));

vi.mock("../LiveRunWidget", () => ({
  default: () => <div data-testid="live-run-widget" />,
}));

vi.mock("../LogViewer", () => ({
  default: () => <div data-testid="log-viewer" />,
}));

import {
  fetchTaskDetail,
  retryTask,
  updateTaskStatus,
} from "../../hooks/useApi";

const mockFetchTaskDetail = vi.mocked(fetchTaskDetail);
const mockRetryTask = vi.mocked(retryTask);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    id: 1,
    linearIssueId: "TEST-1",
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "completed",
    sessionId: null,
    branchName: null,
    worktreePath: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
    outputSummary: null,
    logPath: null,
    phase: "implement",
    model: null,
    agentPrompt: null,
    ...overrides,
  };
}

function makeTaskWithInvocations(
  overrides: Partial<TaskWithInvocations> = {},
): TaskWithInvocations {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Implement the feature",
    repoPath: "/repo",
    orcaStatus: "ready",
    priority: 3,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: null,
    projectName: null,
    invocationCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    taskType: "linear",
    cronScheduleId: null,
    invocations: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskDetail", () => {
  it("shows skeleton while detail is loading (before fetchTaskDetail resolves)", () => {
    // Never-resolving promise keeps detail=null
    mockFetchTaskDetail.mockReturnValue(new Promise(() => {}));

    render(<TaskDetail taskId="TEST-1" />);

    // Skeleton renders while loading — task ID should not be shown yet
    expect(screen.queryByText("TEST-1")).not.toBeInTheDocument();
  });

  it("shows task ID after detail loads", async () => {
    mockFetchTaskDetail.mockResolvedValue(makeTaskWithInvocations());

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText("TEST-1")).toBeInTheDocument();
    });
  });

  it("shows Retry button for failed tasks", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "failed" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
  });

  it("does NOT show Retry button for non-failed tasks", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "ready" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText("TEST-1")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("Retry button calls retryTask when clicked (with window.confirm)", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "failed" }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockRetryTask.mockResolvedValue({ ok: true });

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockRetryTask).toHaveBeenCalledWith("TEST-1");
    });
  });

  it("shows status badge with correct status text for 'running' task", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "running" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      // Status badge shows "running" with a dropdown arrow character
      expect(screen.getByText(/running/)).toBeInTheDocument();
    });
  });

  it("shows 'queued' in status badge for ready task (ready maps to 'queued')", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "ready" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText(/queued/)).toBeInTheDocument();
    });
  });

  it("clicking status badge opens the status dropdown menu", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "ready" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText(/queued/)).toBeInTheDocument();
    });

    // Click the status badge button
    fireEvent.click(screen.getByText(/queued/));

    // Should show dropdown options (excluding current status 'ready')
    await waitFor(() => {
      expect(screen.getByText("done")).toBeInTheDocument();
    });
  });

  it("clicking a status in dropdown calls updateTaskStatus", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ orcaStatus: "ready" }),
    );
    mockUpdateTaskStatus.mockResolvedValue({ ok: true });

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText(/queued/)).toBeInTheDocument();
    });

    // Open dropdown
    fireEvent.click(screen.getByText(/queued/));

    await waitFor(() => {
      expect(screen.getByText("done")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("done"));

    await waitFor(() => {
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith("TEST-1", "done");
    });
  });

  it("shows invocation history rows when invocations exist", async () => {
    const invocation = makeInvocation({
      id: 42,
      status: "completed",
      startedAt: new Date().toISOString(),
    });
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ invocations: [invocation] }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      // Invocation history section should be visible
      expect(screen.getByText("Invocation History")).toBeInTheDocument();
    });

    // Should not show the empty state message
    expect(screen.queryByText("No invocations yet")).not.toBeInTheDocument();
  });

  it("shows 'No invocations yet' when task has no invocations", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ invocations: [] }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText("No invocations yet")).toBeInTheDocument();
    });
  });

  it("shows LiveRunWidget when task has a running invocation", async () => {
    const runningInvocation = makeInvocation({
      id: 55,
      status: "running",
      endedAt: null,
    });
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({
        orcaStatus: "running",
        invocations: [runningInvocation],
      }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("live-run-widget")).toBeInTheDocument();
    });
  });

  it("does NOT show LiveRunWidget when no running invocation", async () => {
    const completedInvocation = makeInvocation({
      id: 66,
      status: "completed",
    });
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ invocations: [completedInvocation] }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText("TEST-1")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("live-run-widget")).not.toBeInTheDocument();
  });

  it("shows agent prompt from detail", async () => {
    mockFetchTaskDetail.mockResolvedValue(
      makeTaskWithInvocations({ agentPrompt: "Build the new dashboard" }),
    );

    render(<TaskDetail taskId="TEST-1" />);

    await waitFor(() => {
      expect(screen.getByText("Build the new dashboard")).toBeInTheDocument();
    });
  });
});
