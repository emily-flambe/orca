import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import Dashboard from "../Dashboard";
import type { MetricsData } from "../../hooks/useApi";
import { fetchMetrics } from "../../hooks/useApi";

vi.mock("../../hooks/useApi", () => ({
  fetchMetrics: vi.fn(),
}));

vi.mock("../ActiveSessionsGrid", () => ({
  default: () => <div data-testid="active-sessions-grid" />,
}));

vi.mock("../ActivityFeed", () => ({
  default: () => <div data-testid="activity-feed" />,
}));

vi.mock("../SystemMetrics", () => ({
  default: () => <div data-testid="system-metrics" />,
}));

const mockFetchMetrics = vi.mocked(fetchMetrics);

function makeMetrics(overrides: Partial<MetricsData> = {}): MetricsData {
  return {
    tasksByStatus: { ready: 2, running: 1 },
    invocationStats: {
      byStatus: [
        { status: "completed", count: 10 },
        { status: "failed", count: 2 },
        { status: "running", count: 1 },
      ],
      avgDurationSecs: 120,
      avgCostUsd: 0.05,
      totalCostUsd: 5.42,
      avgTokens: 125000,
      totalTokens: 1250000,
    },
    recentErrors: [],
    costLast24h: 1.23,
    costLast7d: 8.5,
    costPrev24h: 0.9,
    tokensLast24h: 500000,
    tokensLast7d: 3500000,
    tokensPrev24h: 400000,
    dailyStats: Array.from({ length: 14 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      completed: i % 3,
      failed: i % 2,
      costUsd: i * 0.1,
      tokens: i * 10000,
    })),
    recentActivity: [],
    successRate12h: 0.83,
    ...overrides,
  };
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeleton initially before fetchMetrics resolves", () => {
    // Return a promise that never resolves to keep loading state
    mockFetchMetrics.mockReturnValue(new Promise(() => {}));
    render(<Dashboard />);

    // While loading, metric card labels are not rendered
    expect(screen.queryByText("Total Cost")).not.toBeInTheDocument();
    expect(screen.queryByText("Active Sessions")).not.toBeInTheDocument();
  });

  it("shows error message when fetchMetrics rejects", async () => {
    mockFetchMetrics.mockRejectedValue(new Error("Network failure"));
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Error:.*Network failure/)).toBeInTheDocument();
    });
  });

  it("shows active sessions and activity feed after data loads", async () => {
    mockFetchMetrics.mockResolvedValue(makeMetrics());
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByTestId("active-sessions-grid")).toBeInTheDocument();
      expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
    });
  });
});
