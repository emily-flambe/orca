import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import CronPage from "../CronPage";
import type {
  CronSchedule,
  TaskWithInvocations,
  Invocation,
} from "../../types";
import {
  fetchCronSchedules,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  fetchCronScheduleTasks,
  fetchInvocationLogs,
} from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchCronSchedules: vi.fn(),
  createCronSchedule: vi.fn(),
  updateCronSchedule: vi.fn(),
  deleteCronSchedule: vi.fn(),
  fetchCronScheduleTasks: vi.fn(),
  fetchInvocationLogs: vi.fn(),
}));

const mockFetchCronSchedules = vi.mocked(fetchCronSchedules);
const mockCreateCronSchedule = vi.mocked(createCronSchedule);
const mockUpdateCronSchedule = vi.mocked(updateCronSchedule);
const mockDeleteCronSchedule = vi.mocked(deleteCronSchedule);
const mockFetchCronScheduleTasks = vi.mocked(fetchCronScheduleTasks);
const mockFetchInvocationLogs = vi.mocked(fetchInvocationLogs);

function makeSchedule(overrides: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: 1,
    name: "Test schedule",
    type: "claude",
    schedule: "0 2 * * *",
    prompt: "Run daily task",
    repoPath: null,
    model: null,
    maxTurns: null,
    timeoutMin: 60,
    maxRuns: null,
    runCount: 0,
    enabled: 1,
    lastRunAt: null,
    lastRunStatus: null,
    nextRunAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    id: 100,
    linearIssueId: "issue-abc-123456789012",
    startedAt: new Date(Date.now() - 60000).toISOString(),
    endedAt: new Date().toISOString(),
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

function makeTask(
  overrides: Partial<TaskWithInvocations> = {},
): TaskWithInvocations {
  return {
    linearIssueId: "issue-abc-123456789012",
    agentPrompt: "Do the task",
    repoPath: "/repo",
    orcaStatus: "done",
    priority: 0,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: new Date().toISOString(),
    projectName: null,
    invocationCount: 1,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: new Date().toISOString(),
    taskType: "linear",
    cronScheduleId: 1,
    invocations: [makeInvocation()],
    ...overrides,
  };
}

describe("CronPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state when fetchCronSchedules never resolves", () => {
    mockFetchCronSchedules.mockReturnValue(new Promise(() => {}));
    render(<CronPage />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when fetchCronSchedules rejects", async () => {
    mockFetchCronSchedules.mockRejectedValue(new Error("Network failure"));
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText(/Network failure/)).toBeInTheDocument();
    });
  });

  it("shows empty state when fetchCronSchedules resolves with empty array", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(
        screen.getByText("No cron schedules configured."),
      ).toBeInTheDocument();
    });
  });

  it("renders schedule names, type badges, and schedule expressions", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({
        id: 1,
        name: "Nightly sync",
        schedule: "0 2 * * *",
        type: "claude",
      }),
      makeSchedule({
        id: 2,
        name: "Weekly report",
        schedule: "0 9 * * 1",
        type: "shell",
      }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Nightly sync")).toBeInTheDocument();
      expect(screen.getByText("Weekly report")).toBeInTheDocument();
    });

    expect(screen.getByText("0 2 * * *")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * 1")).toBeInTheDocument();
    expect(screen.getAllByText("claude")).toHaveLength(1);
    expect(screen.getByText("shell")).toBeInTheDocument();
  });

  it("hides 'New schedule' button when form is open", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("New schedule")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New schedule"));

    expect(screen.queryByText("New schedule")).not.toBeInTheDocument();
  });

  it("shows validation error when submitting form with no fields filled", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("New schedule")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New schedule"));
    fireEvent.click(screen.getByText("Save"));

    expect(
      screen.getByText("Name, schedule, and prompt are required."),
    ).toBeInTheDocument();
  });

  it("shows validation error when only name is filled", async () => {
    mockFetchCronSchedules.mockResolvedValue([]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("New schedule")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New schedule"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Nightly sync"), {
      target: { value: "My schedule" },
    });
    fireEvent.click(screen.getByText("Save"));

    expect(
      screen.getByText("Name, schedule, and prompt are required."),
    ).toBeInTheDocument();
  });

  it("creates a schedule when all required fields are filled", async () => {
    const newSchedule = makeSchedule({
      id: 10,
      name: "My new cron",
      schedule: "*/5 * * * *",
      prompt: "Do something",
    });
    mockFetchCronSchedules.mockResolvedValue([]);
    mockCreateCronSchedule.mockResolvedValue(newSchedule);

    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("New schedule")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("New schedule"));

    fireEvent.change(screen.getByPlaceholderText("e.g. Nightly sync"), {
      target: { value: "My new cron" },
    });
    fireEvent.change(screen.getByPlaceholderText("0 2 * * *"), {
      target: { value: "*/5 * * * *" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe the task..."), {
      target: { value: "Do something" },
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockCreateCronSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "My new cron",
          schedule: "*/5 * * * *",
          prompt: "Do something",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("My new cron")).toBeInTheDocument();
    });

    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("calls updateCronSchedule with enabled=0 when toggling an enabled schedule", async () => {
    const schedule = makeSchedule({ id: 1, enabled: 1 });
    const updated = makeSchedule({ id: 1, enabled: 0 });
    mockFetchCronSchedules.mockResolvedValue([schedule]);
    mockUpdateCronSchedule.mockResolvedValue(updated);

    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByTitle("Disable")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Disable"));

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(1, { enabled: 0 });
    });
  });

  it("shows Confirm? and Yes/No buttons when Delete is clicked", async () => {
    mockFetchCronSchedules.mockResolvedValue([makeSchedule()]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Delete"));

    expect(screen.getByText("Confirm?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("cancels delete when No is clicked", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ name: "Keep me" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("No"));

    expect(screen.queryByText("Confirm?")).not.toBeInTheDocument();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
  });

  it("removes schedule from list when Yes is clicked on delete confirmation", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ id: 5, name: "Delete me" }),
    ]);
    mockDeleteCronSchedule.mockResolvedValue({ ok: true });

    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Delete me")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Yes"));

    await waitFor(() => {
      expect(mockDeleteCronSchedule).toHaveBeenCalledWith(5);
    });

    await waitFor(() => {
      expect(screen.queryByText("Delete me")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // formatLastRun — via rendered output
  // ---------------------------------------------------------------------------

  it("does not render Last: line when lastRunAt is null", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: null }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Test schedule")).toBeInTheDocument();
    });

    expect(screen.queryByText(/^Last:/)).not.toBeInTheDocument();
  });

  it("renders 'Last: just now' when lastRunAt is within the last minute", async () => {
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: recentTime, lastRunStatus: "success" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Last: just now")).toBeInTheDocument();
    });
  });

  it("renders 'Last: Xm ago' for a run several minutes ago", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: fiveMinAgo, lastRunStatus: "success" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Last: 5m ago")).toBeInTheDocument();
    });
  });

  it("renders 'Last: Xh ago' for a run several hours ago", async () => {
    const threeHoursAgo = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: threeHoursAgo, lastRunStatus: "failed" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Last: 3h ago")).toBeInTheDocument();
    });
  });

  it("renders 'Last: Xd ago' for a run several days ago", async () => {
    const twoDaysAgo = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: twoDaysAgo, lastRunStatus: null }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Last: 2d ago")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // lastRunStatus — color coding
  // ---------------------------------------------------------------------------

  it("applies green text class for lastRunStatus='success'", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: recentTime, lastRunStatus: "success" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      const el = screen.getByText("Last: 5m ago");
      expect(el.className).toContain("text-green-400");
    });
  });

  it("applies red text class for lastRunStatus='failed'", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: recentTime, lastRunStatus: "failed" }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      const el = screen.getByText("Last: 5m ago");
      expect(el.className).toContain("text-red-400");
    });
  });

  it("applies gray text class for lastRunStatus=null", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunAt: recentTime, lastRunStatus: null }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      const el = screen.getByText("Last: 5m ago");
      expect(el.className).toContain("text-gray-500");
    });
  });

  // ---------------------------------------------------------------------------
  // lastRunStatus — failure badge
  // ---------------------------------------------------------------------------

  it("renders a red dot badge when lastRunStatus is 'failed'", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "failed",
      }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByTitle("Last run failed")).toBeInTheDocument();
    });
  });

  it("does not render the failure badge when lastRunStatus is 'success'", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "success",
      }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Test schedule")).toBeInTheDocument();
    });

    expect(screen.queryByTitle("Last run failed")).not.toBeInTheDocument();
  });

  it("does not render the failure badge when lastRunStatus is null", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ lastRunStatus: null }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Test schedule")).toBeInTheDocument();
    });

    expect(screen.queryByTitle("Last run failed")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Schedule expand / collapse
  // ---------------------------------------------------------------------------

  it("clicking a schedule row toggles history panel open and closed", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "shell", lastRunAt: null, lastRunStatus: null }),
    ]);
    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Test schedule")).toBeInTheDocument();
    });

    // History panel not visible initially
    expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    });

    // Click again to collapse
    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.queryByText("No runs yet.")).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CronHistoryPanel — shell cron
  // ---------------------------------------------------------------------------

  it("shell cron with no run history shows 'No runs yet'", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "shell", lastRunAt: null, lastRunStatus: null }),
    ]);
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    });
    // fetchCronScheduleTasks should NOT be called for shell crons
    expect(mockFetchCronScheduleTasks).not.toHaveBeenCalled();
  });

  it("shell cron with run history shows lastRunStatus and lastRunAt", async () => {
    const lastRunAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "shell", lastRunAt, lastRunStatus: "success" }),
    ]);
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("Last run:")).toBeInTheDocument();
      expect(screen.getByText("success")).toBeInTheDocument();
      expect(screen.getByText("2h ago")).toBeInTheDocument();
    });
    expect(mockFetchCronScheduleTasks).not.toHaveBeenCalled();
  });

  it("shell cron with failed lastRunStatus shows failure badge in history panel", async () => {
    const lastRunAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "shell", lastRunAt, lastRunStatus: "failed" }),
    ]);
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("failed")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CronHistoryPanel — claude cron loading / error / empty
  // ---------------------------------------------------------------------------

  it("claude cron shows loading state while fetchCronScheduleTasks is pending", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude" }),
    ]);
    mockFetchCronScheduleTasks.mockReturnValue(new Promise(() => {}));
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("Loading history...")).toBeInTheDocument();
    });
  });

  it("claude cron shows error state when fetchCronScheduleTasks rejects", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude" }),
    ]);
    mockFetchCronScheduleTasks.mockRejectedValue(new Error("fetch failed"));
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText(/Error: fetch failed/)).toBeInTheDocument();
    });
  });

  it("claude cron shows 'No runs yet' when fetchCronScheduleTasks returns empty", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude" }),
    ]);
    mockFetchCronScheduleTasks.mockResolvedValue({ tasks: [], total: 0 });
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    });
  });

  it("claude cron renders task rows with status badge and creation time", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude", id: 2 }),
    ]);
    const task = makeTask({ orcaStatus: "done", cronScheduleId: 2 });
    mockFetchCronScheduleTasks.mockResolvedValue({ tasks: [task], total: 1 });
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      // Status badge
      expect(screen.getByText("done")).toBeInTheDocument();
      // Short task ID (last 12 chars of linearIssueId)
      expect(screen.getByText("123456789012")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CronHistoryPanel — inline task expansion (claude)
  // ---------------------------------------------------------------------------

  it("clicking a task row expands and collapses inline log content", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude", id: 3 }),
    ]);
    const invocation = makeInvocation({ id: 42, status: "completed" });
    const task = makeTask({ cronScheduleId: 3, invocations: [invocation] });
    mockFetchCronScheduleTasks.mockResolvedValue({ tasks: [task], total: 1 });
    mockFetchInvocationLogs.mockReturnValue(new Promise(() => {})); // keep loading
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    // Expand schedule
    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );
    await waitFor(() => {
      expect(screen.getByText("done")).toBeInTheDocument();
    });

    // Expand task row — LogViewer is rendered, which calls fetchInvocationLogs
    const taskRow = screen.getByText("done").closest("button")!;
    fireEvent.click(taskRow);

    await waitFor(() => {
      expect(mockFetchInvocationLogs).toHaveBeenCalledWith(42);
    });

    // Collapse task row
    fireEvent.click(taskRow);

    await waitFor(() => {
      // fetchInvocationLogs was called once (LogViewer unmounted on collapse)
      expect(mockFetchInvocationLogs).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // CronHistoryPanel — pagination
  // ---------------------------------------------------------------------------

  it("pagination controls are shown when total exceeds page size", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude", id: 4 }),
    ]);
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({
        linearIssueId: `issue-${i.toString().padStart(12, "0")}`,
        cronScheduleId: 4,
      }),
    );
    mockFetchCronScheduleTasks.mockResolvedValue({ tasks, total: 45 });
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("Prev")).toBeInTheDocument();
      expect(screen.getByText("Next")).toBeInTheDocument();
      expect(screen.getByText("Showing 1–20 of 45")).toBeInTheDocument();
    });

    // Prev is disabled on first page
    expect(screen.getByText("Prev")).toBeDisabled();
    // Next is enabled
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("clicking Next fetches the next page", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude", id: 5 }),
    ]);
    const firstPageTasks = Array.from({ length: 20 }, (_, i) =>
      makeTask({
        linearIssueId: `issue-page1-${i.toString().padStart(6, "0")}`,
        cronScheduleId: 5,
      }),
    );
    const secondPageTasks = [
      makeTask({ linearIssueId: "issue-page2-000000", cronScheduleId: 5 }),
    ];
    mockFetchCronScheduleTasks
      .mockResolvedValueOnce({ tasks: firstPageTasks, total: 21 })
      .mockResolvedValueOnce({ tasks: secondPageTasks, total: 21 });
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("Next")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(mockFetchCronScheduleTasks).toHaveBeenCalledWith(5, 20, 20);
    });
  });

  it("pagination controls are hidden when total fits on one page", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ type: "claude", id: 6 }),
    ]);
    const tasks = [makeTask({ cronScheduleId: 6 })];
    mockFetchCronScheduleTasks.mockResolvedValue({ tasks, total: 1 });
    render(<CronPage />);

    await waitFor(() =>
      expect(screen.getByText("Test schedule")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByText("Test schedule").closest("[class*='cursor-pointer']")!,
    );

    await waitFor(() => {
      expect(screen.getByText("done")).toBeInTheDocument();
    });

    expect(screen.queryByText("Prev")).not.toBeInTheDocument();
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
  });

  it("opens CronForm pre-filled with schedule data when Edit is clicked", async () => {
    mockFetchCronSchedules.mockResolvedValue([
      makeSchedule({ id: 3, name: "Edit me", schedule: "0 6 * * *" }),
    ]);
    const updated = makeSchedule({
      id: 3,
      name: "Edit me",
      schedule: "0 6 * * *",
    });
    mockUpdateCronSchedule.mockResolvedValue(updated);

    render(<CronPage />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText("e.g. Nightly sync");
      expect((nameInput as HTMLInputElement).value).toBe("Edit me");
    });

    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(mockUpdateCronSchedule).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ name: "Edit me" }),
      );
    });
  });
});
