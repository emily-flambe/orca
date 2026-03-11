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
      avgTokens: 5000,
      totalTokens: 54200,
    },
    recentErrors: [],
    tokensLast24h: 12300,
    tokensLast7d: 85000,
    tokensPrev24h: 9000,
    dailyStats: Array.from({ length: 14 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      completed: i % 3,
      failed: i % 2,
      tokens: i * 1000,
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

  it("renders dashboard content after data loads without errors", async () => {
    mockFetchMetrics.mockResolvedValue(makeMetrics());
    render(<Dashboard />);

    await waitFor(() => {
      // Dashboard mounts the active sessions grid after data loads
      expect(screen.getByTestId("active-sessions-grid")).toBeInTheDocument();
    });
  });
});
