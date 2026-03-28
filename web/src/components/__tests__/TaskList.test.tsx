import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import TaskList from "../TaskList";
import type { Task } from "../../types";
import { updateTaskStatus } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true }),
  toggleTaskHidden: vi.fn().mockResolvedValue({ ok: true, hidden: 1 }),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

const STATUS_TO_LIFECYCLE: Record<
  string,
  { stage: string; phase: string | null }
> = {
  backlog: { stage: "backlog", phase: null },
  ready: { stage: "ready", phase: null },
  running: { stage: "active", phase: "implement" },
  in_review: { stage: "active", phase: "review" },
  changes_requested: { stage: "active", phase: "fix" },
  awaiting_ci: { stage: "active", phase: "ci" },
  deploying: { stage: "active", phase: "deploy" },
  done: { stage: "done", phase: null },
  failed: { stage: "failed", phase: null },
  canceled: { stage: "canceled", phase: null },
};

function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    linearIssueId: "ENG-1",
    agentPrompt: "Test task prompt",
    repoPath: "/repo",
    orcaStatus: "ready",
    lifecycleStage: "ready",
    currentPhase: null,
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
    taskType: "linear",
    cronScheduleId: null,
    agentId: null,
    lastFailureReason: null,
    lastFailedPhase: null,
    lastFailedAt: null,
    prUrl: null,
    prState: null,
    hidden: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const merged = { ...base, ...overrides };
  if (overrides.orcaStatus && !overrides.lifecycleStage) {
    const derived = STATUS_TO_LIFECYCLE[overrides.orcaStatus as string];
    if (derived) {
      merged.lifecycleStage = derived.stage as Task["lifecycleStage"];
      merged.currentPhase = derived.phase as Task["currentPhase"];
    }
  }
  return merged;
}

const defaultProps = {
  selectedTaskId: null,
  onSelect: vi.fn(),
};

describe("TaskList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders task IDs for tasks in visible statuses (all except backlog by default)", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-1", orcaStatus: "ready" }),
      makeTask({ linearIssueId: "ENG-2", orcaStatus: "running" }),
      makeTask({ linearIssueId: "ENG-3", orcaStatus: "in_review" }),
      makeTask({ linearIssueId: "ENG-4", orcaStatus: "awaiting_ci" }),
      makeTask({ linearIssueId: "ENG-5", orcaStatus: "failed" }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.getByText("ENG-1")).toBeInTheDocument();
    expect(screen.getByText("ENG-2")).toBeInTheDocument();
    expect(screen.getByText("ENG-3")).toBeInTheDocument();
    expect(screen.getByText("ENG-4")).toBeInTheDocument();
    expect(screen.getByText("ENG-5")).toBeInTheDocument();
  });

  it("filters out tasks with backlog status by default", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-10", orcaStatus: "backlog" }),
      makeTask({ linearIssueId: "ENG-11", orcaStatus: "ready" }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByText("ENG-10")).not.toBeInTheDocument();
    expect(screen.getByText("ENG-11")).toBeInTheDocument();
  });

  it("filters tasks by linearIssueId search", () => {
    const tasks = [
      makeTask({
        linearIssueId: "ENG-100",
        orcaStatus: "ready",
        agentPrompt: "Alpha task",
      }),
      makeTask({
        linearIssueId: "ENG-200",
        orcaStatus: "ready",
        agentPrompt: "Beta task",
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const searchInput = screen.getByPlaceholderText("Search by ID or title…");
    fireEvent.change(searchInput, { target: { value: "ENG-100" } });

    expect(screen.getByText("ENG-100")).toBeInTheDocument();
    expect(screen.queryByText("ENG-200")).not.toBeInTheDocument();
  });

  it("filters tasks by agentPrompt (title) search", () => {
    const tasks = [
      makeTask({
        linearIssueId: "ENG-100",
        orcaStatus: "ready",
        agentPrompt: "Fix login bug",
      }),
      makeTask({
        linearIssueId: "ENG-200",
        orcaStatus: "ready",
        agentPrompt: "Add dark mode",
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const searchInput = screen.getByPlaceholderText("Search by ID or title…");
    fireEvent.change(searchInput, { target: { value: "dark mode" } });

    expect(screen.queryByText("ENG-100")).not.toBeInTheDocument();
    expect(screen.getByText("ENG-200")).toBeInTheDocument();
  });

  it("status badge counts reflect all tasks regardless of filters", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-1", orcaStatus: "backlog" }),
      makeTask({ linearIssueId: "ENG-2", orcaStatus: "backlog" }),
      makeTask({ linearIssueId: "ENG-3", orcaStatus: "ready" }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    // Open the status dropdown
    const dropdownButton = screen.getByText(/of \d+/).closest("button")!;
    fireEvent.click(dropdownButton);

    // Find the backlog filter row and verify its count shows 2
    const allFilterOptions = screen.getAllByRole("option");
    const backlogFilterBtn = allFilterOptions.find((btn) =>
      btn.textContent?.includes("backlog"),
    );
    expect(backlogFilterBtn).toBeTruthy();
    expect(backlogFilterBtn!.textContent).toContain("2");
  });

  it("hides done tasks with zero invocations", () => {
    const tasks = [
      makeTask({
        linearIssueId: "ENG-ZERO",
        orcaStatus: "done",
        invocationCount: 0,
      }),
      makeTask({
        linearIssueId: "ENG-ONE",
        orcaStatus: "done",
        invocationCount: 1,
        doneAt: new Date().toISOString(),
      }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByText("ENG-ZERO")).not.toBeInTheDocument();
    expect(screen.getByText("ENG-ONE")).toBeInTheDocument();
  });

  describe("sort behavior", () => {
    function getTaskIds(): string[] {
      // Each task ID appears as a text node inside a font-mono span.
      // getAllByRole("button") returns task rows (role="button") among other buttons.
      // Safer: find all elements whose text matches ENG-\d+ pattern.
      return screen.getAllByText(/^ENG-\d+$/).map((el) => el.textContent ?? "");
    }

    it("default sort is status ascending — running tasks appear before ready/queued tasks", () => {
      const tasks = [
        makeTask({ linearIssueId: "ENG-1", orcaStatus: "ready" }),
        makeTask({ linearIssueId: "ENG-2", orcaStatus: "running" }),
        makeTask({ linearIssueId: "ENG-3", orcaStatus: "in_review" }),
      ];
      render(<TaskList {...defaultProps} tasks={tasks} />);

      const ids = getTaskIds();
      // running (0) < in_review (1) < ready (5) in STATUS_ORDER
      expect(ids.indexOf("ENG-2")).toBeLessThan(ids.indexOf("ENG-3"));
      expect(ids.indexOf("ENG-3")).toBeLessThan(ids.indexOf("ENG-1"));
    });

    it("default sort button shows '↑' on the status sort option", () => {
      render(<TaskList {...defaultProps} tasks={[]} />);

      const statusSortBtn = screen.getByRole("button", { name: /status ↑/ });
      expect(statusSortBtn).toBeInTheDocument();
    });

    it("clicking a sort button sets it to asc and shows '↑'", () => {
      render(<TaskList {...defaultProps} tasks={[]} />);

      const priorityBtn = screen.getByRole("button", { name: "priority" });
      fireEvent.click(priorityBtn);

      expect(
        screen.getByRole("button", { name: /priority ↑/ }),
      ).toBeInTheDocument();
    });

    it("clicking the same active asc sort button switches it to desc and shows '↓'", () => {
      render(<TaskList {...defaultProps} tasks={[]} />);

      // status is already asc by default — click it once to go to desc
      const statusBtn = screen.getByRole("button", { name: /status ↑/ });
      fireEvent.click(statusBtn);

      expect(
        screen.getByRole("button", { name: /status ↓/ }),
      ).toBeInTheDocument();
    });

    it("clicking the same active desc sort button clears sort — no '↑' or '↓' shown", () => {
      render(<TaskList {...defaultProps} tasks={[]} />);

      // status starts asc
      const statusBtnAsc = screen.getByRole("button", { name: /status ↑/ });
      fireEvent.click(statusBtnAsc); // → desc

      const statusBtnDesc = screen.getByRole("button", { name: /status ↓/ });
      fireEvent.click(statusBtnDesc); // → cleared

      // After clearing, neither ↑ nor ↓ should appear in any button text
      const allButtons = screen.getAllByRole("button");
      const hasArrow = allButtons.some(
        (btn) =>
          btn.textContent?.includes("↑") || btn.textContent?.includes("↓"),
      );
      expect(hasArrow).toBe(false);
    });

    it("clicking a different sort button from an active one resets to asc on the new option", () => {
      render(<TaskList {...defaultProps} tasks={[]} />);

      // status is active asc by default; click it to go desc
      const statusBtnAsc = screen.getByRole("button", { name: /status ↑/ });
      fireEvent.click(statusBtnAsc); // status → desc

      // Now click a different sort button (priority)
      const priorityBtn = screen.getByRole("button", { name: "priority" });
      fireEvent.click(priorityBtn);

      // priority should be asc
      expect(
        screen.getByRole("button", { name: /priority ↑/ }),
      ).toBeInTheDocument();
      // status should have no arrow (inactive)
      const statusBtn = screen.getByRole("button", { name: "status" });
      expect(statusBtn.textContent).toBe("status");
      expect(statusBtn.textContent).not.toContain("↑");
      expect(statusBtn.textContent).not.toContain("↓");
    });
  });

  describe("status update toasts", () => {
    const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);

    it("calls onToast.success with status label when updateTaskStatus resolves", async () => {
      mockUpdateTaskStatus.mockResolvedValue({ ok: true });
      const onToast = { success: vi.fn(), error: vi.fn() };
      const task = makeTask({ linearIssueId: "ENG-42", orcaStatus: "ready" });

      render(<TaskList {...defaultProps} tasks={[task]} onToast={onToast} />);

      // Click the status badge button to open the menu
      const statusBadge = screen.getByText(/queued/);
      fireEvent.click(statusBadge);

      // Click "cancel" from the dropdown (excludes current status "ready")
      const cancelOption = screen.getByText("cancel");
      fireEvent.click(cancelOption);

      await waitFor(() => {
        expect(onToast.success).toHaveBeenCalledWith(
          "Status updated to cancel",
        );
      });
      expect(onToast.error).not.toHaveBeenCalled();
    });

    it("calls onToast.error when updateTaskStatus rejects", async () => {
      mockUpdateTaskStatus.mockRejectedValue(new Error("Server error"));
      const onToast = { success: vi.fn(), error: vi.fn() };
      const task = makeTask({ linearIssueId: "ENG-42", orcaStatus: "ready" });

      render(<TaskList {...defaultProps} tasks={[task]} onToast={onToast} />);

      const statusBadge = screen.getByText(/queued/);
      fireEvent.click(statusBadge);

      const cancelOption = screen.getByText("cancel");
      fireEvent.click(cancelOption);

      await waitFor(() => {
        expect(onToast.error).toHaveBeenCalledWith("Server error");
      });
      expect(onToast.success).not.toHaveBeenCalled();
    });
  });
});
