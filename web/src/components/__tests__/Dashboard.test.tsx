import { render, screen, waitFor, within } from "@testing-library/react";
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
      avgCostUsd: 0.05,
      totalCostUsd: 5.42,
    },
    recentErrors: [],
    costLast24h: 1.23,
    costLast7d: 8.5,
    costPrev24h: 0.9,
    dailyStats: Array.from({ length: 14 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      completed: i % 3,
      failed: i % 2,
      costUsd: i * 0.1,
    })),
    recentActivity: [],
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

  it("shows metric cards after data loads", async () => {
    mockFetchMetrics.mockResolvedValue(makeMetrics());
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Total Cost")).toBeInTheDocument();
      expect(screen.getByText("Active Sessions")).toBeInTheDocument();
      expect(screen.getByText("Success Rate")).toBeInTheDocument();
      expect(screen.getByText("24h Cost")).toBeInTheDocument();
    });
  });

  it("shows total cost formatted as $X.XX", async () => {
    mockFetchMetrics.mockResolvedValue(
      makeMetrics({
        invocationStats: {
          byStatus: [{ status: "completed", count: 5 }],
          avgDurationSecs: null,
          avgCostUsd: null,
          totalCostUsd: 12.34,
        },
      }),
    );
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("$12.34")).toBeInTheDocument();
    });
  });

  it("shows active sessions count", async () => {
    mockFetchMetrics.mockResolvedValue(
      makeMetrics({
        invocationStats: {
          byStatus: [
            { status: "running", count: 4 },
            { status: "completed", count: 20 },
          ],
          avgDurationSecs: 90,
          avgCostUsd: 0.03,
          totalCostUsd: 3.0,
        },
      }),
    );
    render(<Dashboard />);

    await waitFor(() => {
      // The "Active Sessions" card shows the running count — scoped to that card
      const label = screen.getByText("Active Sessions");
      expect(within(label.parentElement!).getByText("4")).toBeInTheDocument();
    });
  });
});
