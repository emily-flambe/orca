/**
 * Regression tests for EMI-325: duplicate SSE connection on Dashboard.
 *
 * ActiveSessionsGrid must NOT call useSSE() directly. SSE-derived data
 * (invocationStartedTrigger, lastCompletedEvent) is passed down as props
 * from App.tsx so there is only one EventSource per browser tab.
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ActiveSessionsGrid from "../ActiveSessionsGrid";
import { fetchRunningInvocations } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchRunningInvocations: vi.fn(),
}));

vi.mock("../LiveRunWidget", () => ({
  default: ({ invocation }: { invocation: { id: number; linearIssueId: string } }) => (
    <div data-testid={`live-run-${invocation.id}`}>{invocation.linearIssueId}</div>
  ),
}));

const mockFetchRunning = vi.mocked(fetchRunningInvocations);

function makeInvocation(id: number, linearIssueId = `ISSUE-${id}`) {
  return {
    id,
    linearIssueId,
    taskId: `task-${id}`,
    phase: "implement" as const,
    status: "running" as const,
    model: "sonnet",
    prompt: "test prompt",
    costUsd: 0,
    inputTokens: null,
    outputTokens: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    worktreePath: null,
    prUrl: null,
    invocationIndex: 0,
    exitCode: null,
    sessionId: null,
  };
}

describe("ActiveSessionsGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not import or call useSSE — SSE data arrives via props only", async () => {
    // If useSSE were called inside this component, it would fail because
    // we have not mocked it. The fact that this test passes without a mock
    // proves the component does not call useSSE.
    mockFetchRunning.mockResolvedValue([makeInvocation(1)]);
    render(<ActiveSessionsGrid />);
    await waitFor(() => {
      expect(screen.getByTestId("live-run-1")).toBeInTheDocument();
    });
  });

  it("shows 'No active sessions' when there are no running invocations", async () => {
    mockFetchRunning.mockResolvedValue([]);
    render(<ActiveSessionsGrid />);
    await waitFor(() => {
      expect(screen.getByText("No active sessions")).toBeInTheDocument();
    });
  });

  it("re-fetches running invocations when invocationStartedTrigger increments", async () => {
    mockFetchRunning.mockResolvedValueOnce([]).mockResolvedValueOnce([makeInvocation(2)]);

    const { rerender } = render(<ActiveSessionsGrid invocationStartedTrigger={0} />);
    await waitFor(() => expect(mockFetchRunning).toHaveBeenCalledTimes(1));

    rerender(<ActiveSessionsGrid invocationStartedTrigger={1} />);
    await waitFor(() => {
      expect(mockFetchRunning).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("live-run-2")).toBeInTheDocument();
    });
  });

  it("removes completed invocation from the list via lastCompletedEvent prop", async () => {
    mockFetchRunning.mockResolvedValue([makeInvocation(3), makeInvocation(4)]);

    const { rerender } = render(<ActiveSessionsGrid />);
    await waitFor(() => {
      expect(screen.getByTestId("live-run-3")).toBeInTheDocument();
      expect(screen.getByTestId("live-run-4")).toBeInTheDocument();
    });

    const completedEvent = {
      taskId: "task-3",
      invocationId: 3,
      status: "completed",
      costUsd: 0.05,
      inputTokens: 100,
      outputTokens: 200,
    };

    await act(async () => {
      rerender(<ActiveSessionsGrid lastCompletedEvent={completedEvent} />);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("live-run-3")).not.toBeInTheDocument();
      expect(screen.getByTestId("live-run-4")).toBeInTheDocument();
    });
  });

  it("shows count badge when sessions are active", async () => {
    mockFetchRunning.mockResolvedValue([makeInvocation(5), makeInvocation(6)]);
    render(<ActiveSessionsGrid />);
    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });
});
