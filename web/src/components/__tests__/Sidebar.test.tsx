import { render, screen, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import Sidebar from "../Sidebar";
import type { OrcaStatus, Task } from "../../types";

vi.mock("../CreateTicketModal", () => ({
  default: () => null,
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    linearIssueId: "ENG-1",
    agentPrompt: "Test task",
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

function makeStatus(overrides: Partial<OrcaStatus> = {}): OrcaStatus {
  return {
    activeSessions: 0,
    activeTaskIds: [],
    queuedTasks: 0,
    costInWindow: 0,
    budgetLimit: 100,
    budgetWindowHours: 24,
    concurrencyCap: 4,
    implementModel: "claude-3-5-sonnet",
    reviewModel: "claude-3-5-sonnet",
    fixModel: "claude-3-5-sonnet",
    draining: false,
    drainSessionCount: 0,
    ...overrides,
  };
}

const defaultProps = {
  activePage: "dashboard" as const,
  onNavigate: vi.fn(),
  status: null,
  tasks: [],
  onSync: vi.fn().mockResolvedValue(undefined),
  onNewTicket: vi.fn(),
  isOpen: true,
};

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows active session badge count when activeSessions > 0", () => {
    const status = makeStatus({ activeSessions: 3 });
    render(<Sidebar {...defaultProps} status={status} />);

    // The count is displayed in a blue span
    const badge = screen.getByText("3");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("blue");
  });

  it("does not show badge when status is null", () => {
    render(<Sidebar {...defaultProps} status={null} />);

    const dashboardButton = screen.getByText("Dashboard").closest("button");
    expect(dashboardButton?.querySelector(".text-blue-400")).toBeNull();
  });

  it("does not show badge when activeSessions is 0", () => {
    const status = makeStatus({ activeSessions: 0 });
    render(<Sidebar {...defaultProps} status={status} />);

    const dashboardButton = screen.getByText("Dashboard").closest("button");
    // The badge span with the count should not be in the dashboard button
    expect(dashboardButton?.querySelector(".text-blue-400")).toBeNull();
  });

  it("shows task count in Tasks nav item", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-1" }),
      makeTask({ linearIssueId: "ENG-2" }),
      makeTask({ linearIssueId: "ENG-3" }),
    ];
    render(<Sidebar {...defaultProps} tasks={tasks} />);

    const tasksButton = screen.getByText("Tasks").closest("button");
    expect(within(tasksButton!).getByText("3")).toBeInTheDocument();
  });

  it("calls onNavigate('tasks') when Tasks button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Tasks"));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("shows project list when tasks have projectName", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-1", projectName: "ProjectAlpha" }),
      makeTask({ linearIssueId: "ENG-2", projectName: "ProjectBeta" }),
    ];
    render(<Sidebar {...defaultProps} tasks={tasks} />);

    expect(screen.getByText("ProjectAlpha")).toBeInTheDocument();
    expect(screen.getByText("ProjectBeta")).toBeInTheDocument();
  });

  it("shows 'No projects' when no tasks have a projectName", () => {
    const tasks = [
      makeTask({ linearIssueId: "ENG-1", projectName: null }),
    ];
    render(<Sidebar {...defaultProps} tasks={tasks} />);

    expect(screen.getByText("No projects")).toBeInTheDocument();
  });
});
