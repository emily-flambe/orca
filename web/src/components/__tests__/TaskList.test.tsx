import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import TaskList from "../TaskList";
import type { Task } from "../../types";

vi.mock("../../hooks/useApi", () => ({
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    linearIssueId: "ENG-1",
    agentPrompt: "Test task prompt",
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
    ...overrides,
  };
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
      makeTask({ linearIssueId: "ENG-3", orcaStatus: "dispatched" }),
      makeTask({ linearIssueId: "ENG-4", orcaStatus: "in_review" }),
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
      makeTask({ linearIssueId: "ENG-100", orcaStatus: "ready", agentPrompt: "Alpha task" }),
      makeTask({ linearIssueId: "ENG-200", orcaStatus: "ready", agentPrompt: "Beta task" }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    const searchInput = screen.getByPlaceholderText("Search by ID or title…");
    fireEvent.change(searchInput, { target: { value: "ENG-100" } });

    expect(screen.getByText("ENG-100")).toBeInTheDocument();
    expect(screen.queryByText("ENG-200")).not.toBeInTheDocument();
  });

  it("filters tasks by agentPrompt (title) search", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-100", orcaStatus: "ready", agentPrompt: "Fix login bug" }),
      makeTask({ linearIssueId: "ENG-200", orcaStatus: "ready", agentPrompt: "Add dark mode" }),
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
    const allFilterButtons = screen.getAllByRole("button");
    const backlogFilterBtn = allFilterButtons.find((btn) =>
      btn.textContent?.includes("backlog"),
    );
    expect(backlogFilterBtn).toBeTruthy();
    expect(backlogFilterBtn!.textContent).toContain("2");
  });

  it("hides done tasks with zero invocations", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-ZERO", orcaStatus: "done", invocationCount: 0 }),
      makeTask({ linearIssueId: "ENG-ONE", orcaStatus: "done", invocationCount: 1, doneAt: new Date().toISOString() }),
    ];
    render(<TaskList {...defaultProps} tasks={tasks} />);

    expect(screen.queryByText("ENG-ZERO")).not.toBeInTheDocument();
    expect(screen.getByText("ENG-ONE")).toBeInTheDocument();
  });
});
