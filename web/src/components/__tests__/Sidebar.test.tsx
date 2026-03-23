import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import Sidebar from "../Sidebar";
import type { OrcaStatus } from "../../types";

function makeStatus(overrides: Partial<OrcaStatus> = {}): OrcaStatus {
  return {
    activeSessions: 0,
    activeTaskIds: [],
    queuedTasks: 0,
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
  activePage: "tasks" as const,
  onNavigate: vi.fn(),
  status: null,
  isOpen: true,
};

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows active session badge count when activeSessions > 0", () => {
    const status = makeStatus({ activeSessions: 3 });
    render(<Sidebar {...defaultProps} status={status} />);

    const badge = screen.getByText("3");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("blue");
  });

  it("does not show badge when status is null", () => {
    render(<Sidebar {...defaultProps} status={null} />);

    const tasksButton = screen.getByRole("button", { name: "Tasks" });
    expect(tasksButton.querySelector(".bg-blue-600")).toBeNull();
  });

  it("does not show badge when activeSessions is 0", () => {
    const status = makeStatus({ activeSessions: 0 });
    render(<Sidebar {...defaultProps} status={status} />);

    const tasksButton = screen.getByRole("button", { name: "Tasks" });
    expect(tasksButton.querySelector(".bg-blue-600")).toBeNull();
  });

  it("renders all nav items", () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByRole("button", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Metrics" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cron" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("calls onNavigate('tasks') when Tasks button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("calls onNavigate with correct page for each nav button", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    expect(onNavigate).toHaveBeenCalledWith("metrics");

    fireEvent.click(screen.getByRole("button", { name: "Cron" }));
    expect(onNavigate).toHaveBeenCalledWith("cron");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("applies active styling to the active page button", () => {
    render(<Sidebar {...defaultProps} activePage="metrics" />);

    const metricsButton = screen.getByRole("button", { name: "Metrics" });
    expect(metricsButton.className).toContain("bg-gray-800");
    expect(metricsButton.className).toContain("text-white");
  });
});
