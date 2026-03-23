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
    tokensInWindow: 0,
    tokenBudgetLimit: 1000000,
    inputTokensInWindow: 0,
    outputTokensInWindow: 0,
    concurrencyCap: 4,
    model: "claude-3-5-sonnet",
    reviewModel: "claude-3-5-sonnet",
    draining: false,
    drainSessionCount: 0,
    tokensPerMinute: null,
    ...overrides,
  };
}

const defaultProps = {
  activePage: "tasks" as const,
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

    const badge = screen.getByText("3");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("blue");
  });

  it("does not show badge when status is null", () => {
    render(<Sidebar {...defaultProps} status={null} />);

    const tasksButton = screen.getByLabelText("Tasks");
    expect(tasksButton.querySelector(".bg-blue-600")).toBeNull();
  });

  it("does not show badge when activeSessions is 0", () => {
    const status = makeStatus({ activeSessions: 0 });
    render(<Sidebar {...defaultProps} status={status} />);

    const tasksButton = screen.getByLabelText("Tasks");
    expect(tasksButton.querySelector(".bg-blue-600")).toBeNull();
  });

  it("calls onNavigate('tasks') when Tasks button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Tasks"));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("calls onNavigate('metrics') when Metrics button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Metrics"));
    expect(onNavigate).toHaveBeenCalledWith("metrics");
  });

  it("calls onNavigate('cron') when Cron button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Cron"));
    expect(onNavigate).toHaveBeenCalledWith("cron");
  });

  it("calls onNavigate('settings') when Settings button clicked", () => {
    const onNavigate = vi.fn();
    render(<Sidebar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Settings"));
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("renders all navigation buttons", () => {
    render(<Sidebar {...defaultProps} />);

    expect(screen.getByLabelText("Tasks")).toBeInTheDocument();
    expect(screen.getByLabelText("Metrics")).toBeInTheDocument();
    expect(screen.getByLabelText("Cron")).toBeInTheDocument();
    expect(screen.getByLabelText("Agents")).toBeInTheDocument();
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
  });

  it("highlights active page button", () => {
    render(<Sidebar {...defaultProps} activePage="metrics" />);

    const metricsButton = screen.getByLabelText("Metrics");
    expect(metricsButton.className).toContain("bg-gray-800");
    expect(metricsButton.className).toContain("text-white");
  });
});
