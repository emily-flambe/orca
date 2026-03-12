import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockTasks = [
  {
    linearIssueId: "EMI-001",
    agentPrompt: "Implement feature X",
    repoPath: "/repos/orca",
    orcaStatus: "ready",
    priority: 1,
    retryCount: 0,
    prBranchName: null,
    reviewCycleCount: 0,
    mergeCommitSha: null,
    prNumber: null,
    deployStartedAt: null,
    ciStartedAt: null,
    doneAt: null,
    projectName: "Orca",
    invocationCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
];

const mockStatus = {
  activeSessions: 0,
  activeTaskIds: [],
  queuedTasks: 1,
  costInWindow: 0,
  budgetLimit: 50,
  budgetWindowHours: 24,
  tokensInWindow: 12500,
  tokenBudgetLimit: 100000,
  concurrencyCap: 3,
  implementModel: "sonnet",
  reviewModel: "sonnet",
  fixModel: "haiku",
  draining: false,
  drainSessionCount: 0,
};

const mockMetrics = {
  tasksByStatus: { ready: 1 },
  invocationStats: {
    byStatus: [
      { status: "completed", count: 5 },
      { status: "failed", count: 1 },
      { status: "running", count: 0 },
    ],
    avgDurationSecs: 90,
    avgCostUsd: 0.04,
    totalCostUsd: 2.5,
  },
  recentErrors: [],
  costLast24h: 0.5,
  costLast7d: 3.2,
  costPrev24h: 0.4,
  dailyStats: Array.from({ length: 14 }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, "0")}`,
    completed: i % 3,
    failed: i % 2,
    costUsd: i * 0.05,
  })),
  recentActivity: [],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("Dashboard smoke test", () => {
  test.beforeEach(async ({ page }) => {
    // Mock all API endpoints before navigation
    await page.route("/api/tasks", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockTasks),
      }),
    );

    await page.route("/api/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockStatus),
      }),
    );

    await page.route("/api/metrics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockMetrics),
      }),
    );

    await page.route("/api/invocations/running", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      }),
    );

    // Mock SSE endpoint to return a valid stream that immediately ends
    await page.route("/api/events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": keepalive\n\n",
      }),
    );

    await page.goto("/");
  });

  test("sidebar renders with title and nav items", async ({ page }) => {
    await expect(page.getByText("Orca").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Logs" })).toBeVisible();
  });

  test("dashboard token budget gauge is visible", async ({ page }) => {
    await expect(page.getByText(/active/).first()).toBeVisible();
    await expect(page.getByText(/Queued/)).toBeVisible();
  });

  test("SSE endpoint /api/events is requested", async ({ page }) => {
    let sseRequested = false;

    page.on("request", (request) => {
      if (request.url().includes("/api/events")) {
        sseRequested = true;
      }
    });

    // Reload to capture the SSE request via the listener
    await page.reload();

    // Wait briefly for the app to initialize and make requests
    await page.waitForTimeout(500);

    expect(sseRequested).toBe(true);
  });
});
