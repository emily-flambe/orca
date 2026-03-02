// ---------------------------------------------------------------------------
// Observability API endpoint tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  getAllInvocations,
  getAllBudgetEvents,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  } as OrcaConfig;
}

function makeTask(overrides?: Record<string, unknown>) {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: "ready" as const,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/logs/system
// ---------------------------------------------------------------------------

describe("GET /api/logs/system", () => {
  let db: OrcaDb;
  let app: Hono;
  const logPath = join(process.cwd(), "orca.log");

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
  });

  afterEach(() => {
    if (existsSync(logPath)) {
      unlinkSync(logPath);
    }
  });

  it("returns empty lines when no orca.log exists", async () => {
    // Ensure no log file exists
    if (existsSync(logPath)) unlinkSync(logPath);

    const res = await app.request("/api/logs/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lines: [], totalLines: 0 });
  });

  it("returns lines from existing orca.log", async () => {
    writeFileSync(logPath, "[orca/scheduler] tick 1\n[orca/runner] started session\n");

    const res = await app.request("/api/logs/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toBe("[orca/scheduler] tick 1");
    expect(body.lines[1]).toBe("[orca/runner] started session");
    expect(body.totalLines).toBe(2);
  });

  it("filters by level param", async () => {
    writeFileSync(
      logPath,
      "[orca/scheduler] tick 1\n[orca/runner] started\n[orca/scheduler] tick 2\n",
    );

    const res = await app.request("/api/logs/system?level=scheduler");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toContain("[orca/scheduler]");
    expect(body.lines[1]).toContain("[orca/scheduler]");
    expect(body.totalLines).toBe(2);
  });

  it("filters by search param", async () => {
    writeFileSync(
      logPath,
      "[orca/scheduler] dispatched EMI-1\n[orca/runner] started EMI-2\n[orca/scheduler] dispatched EMI-3\n",
    );

    const res = await app.request("/api/logs/system?search=dispatched");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toContain("dispatched");
    expect(body.lines[1]).toContain("dispatched");
  });

  it("combines level and search filters", async () => {
    writeFileSync(
      logPath,
      "[orca/scheduler] dispatched EMI-1\n[orca/runner] dispatched EMI-2\n[orca/scheduler] tick 3\n",
    );

    const res = await app.request("/api/logs/system?level=scheduler&search=dispatched");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toBe("[orca/scheduler] dispatched EMI-1");
  });

  it("limits to last N lines", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `[orca/scheduler] tick ${i}`).join("\n") + "\n";
    writeFileSync(logPath, lines);

    const res = await app.request("/api/logs/system?lines=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(3);
    expect(body.lines[0]).toBe("[orca/scheduler] tick 7");
    expect(body.lines[2]).toBe("[orca/scheduler] tick 9");
    expect(body.totalLines).toBe(10);
  });

  it("returns all lines when lines param exceeds total", async () => {
    writeFileSync(logPath, "[orca/scheduler] tick 1\n[orca/runner] done\n");

    const res = await app.request("/api/logs/system?lines=500");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(2);
  });

  it("rejects lines=0", async () => {
    const res = await app.request("/api/logs/system?lines=0");
    expect(res.status).toBe(400);
  });

  it("rejects negative lines", async () => {
    const res = await app.request("/api/logs/system?lines=-5");
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric lines", async () => {
    const res = await app.request("/api/logs/system?lines=abc");
    expect(res.status).toBe(400);
  });

  it("handles empty log file", async () => {
    writeFileSync(logPath, "");

    const res = await app.request("/api/logs/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual([]);
    expect(body.totalLines).toBe(0);
  });

  it("default limit is 200 lines", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(logPath, lines);

    const res = await app.request("/api/logs/system");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(200);
    // Should return the last 200 lines (100-299)
    expect(body.lines[0]).toBe("line 100");
    expect(body.lines[199]).toBe("line 299");
    expect(body.totalLines).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// GET /api/metrics
// ---------------------------------------------------------------------------

describe("GET /api/metrics", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
  });

  it("returns zero/empty metrics when DB is empty", async () => {
    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasksByStatus).toEqual({});
    expect(body.totalInvocations).toBe(0);
    expect(body.completedInvocations).toBe(0);
    expect(body.failedInvocations).toBe(0);
    expect(body.timedOutInvocations).toBe(0);
    expect(body.avgSessionDurationSec).toBe(0);
    expect(body.avgCostPerSession).toBe(0);
    expect(body.totalCost).toBe(0);
    expect(body.costTimeSeries).toEqual([]);
    expect(body.recentErrors).toEqual([]);
    expect(body.throughput).toEqual([]);
  });

  it("returns correct tasksByStatus counts", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "ready" }));
    insertTask(db, makeTask({ linearIssueId: "T-2", orcaStatus: "ready" }));
    insertTask(db, makeTask({ linearIssueId: "T-3", orcaStatus: "done" }));
    insertTask(db, makeTask({ linearIssueId: "T-4", orcaStatus: "failed" }));

    const res = await app.request("/api/metrics");
    const body = await res.json();
    expect(body.tasksByStatus).toEqual({ ready: 2, done: 1, failed: 1 });
  });

  it("returns correct invocation counts", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:05:00.000Z",
      status: "failed",
      outputSummary: "crash",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T02:00:00.000Z",
      endedAt: "2026-01-01T02:45:00.000Z",
      status: "timed_out",
      outputSummary: "timeout",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T03:00:00.000Z",
      status: "running",
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();
    expect(body.totalInvocations).toBe(4);
    expect(body.completedInvocations).toBe(1);
    expect(body.failedInvocations).toBe(1);
    expect(body.timedOutInvocations).toBe(1);
  });

  it("computes avgSessionDurationSec correctly", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    // Completed: 10 minutes
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "completed",
    });
    // Completed: 20 minutes
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:20:00.000Z",
      status: "completed",
    });
    // Failed: should NOT count toward avg duration
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T02:00:00.000Z",
      endedAt: "2026-01-01T02:05:00.000Z",
      status: "failed",
      outputSummary: "crash",
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();
    // Average of 600s + 1200s = 900s
    expect(body.avgSessionDurationSec).toBe(900);
  });

  it("computes costTimeSeries from budget events", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    const inv1 = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "completed",
      costUsd: 1.5,
    });
    const inv2 = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-02T00:00:00.000Z",
      endedAt: "2026-01-02T00:10:00.000Z",
      status: "completed",
      costUsd: 2.0,
    });

    insertBudgetEvent(db, { invocationId: inv1, costUsd: 1.5, recordedAt: "2026-01-01T00:10:00.000Z" });
    insertBudgetEvent(db, { invocationId: inv2, costUsd: 2.0, recordedAt: "2026-01-02T00:10:00.000Z" });

    const res = await app.request("/api/metrics");
    const body = await res.json();
    expect(body.costTimeSeries).toEqual([
      { date: "2026-01-01", cost: 1.5 },
      { date: "2026-01-02", cost: 2.0 },
    ]);
    expect(body.totalCost).toBe(3.5);
  });

  it("aggregates recentErrors by outputSummary", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertTask(db, makeTask({ linearIssueId: "T-2" }));

    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "failed",
      outputSummary: "worktree creation failed",
    });
    insertInvocation(db, {
      linearIssueId: "T-2",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:10:00.000Z",
      status: "failed",
      outputSummary: "worktree creation failed",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T02:00:00.000Z",
      endedAt: "2026-01-01T02:10:00.000Z",
      status: "timed_out",
      outputSummary: "session timeout",
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();

    expect(body.recentErrors).toHaveLength(2);
    // Sorted by lastSeen DESC
    const timeout = body.recentErrors.find((e: { summary: string }) => e.summary === "session timeout");
    const worktree = body.recentErrors.find((e: { summary: string }) => e.summary === "worktree creation failed");
    expect(timeout.count).toBe(1);
    expect(worktree.count).toBe(2);
  });

  it("computes throughput correctly", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:10:00.000Z",
      status: "failed",
      outputSummary: "crash",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-02T00:00:00.000Z",
      endedAt: "2026-01-02T00:10:00.000Z",
      status: "completed",
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();
    expect(body.throughput).toEqual([
      { date: "2026-01-01", completed: 1, failed: 1 },
      { date: "2026-01-02", completed: 1, failed: 0 },
    ]);
  });

  it("computes avgCostPerSession excluding zero-cost invocations", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "completed",
      costUsd: 3.0,
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:10:00.000Z",
      status: "completed",
      costUsd: 5.0,
    });
    // Zero cost invocation should not count
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T02:00:00.000Z",
      endedAt: "2026-01-01T02:10:00.000Z",
      status: "failed",
      costUsd: 0,
      outputSummary: "crash",
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();
    expect(body.avgCostPerSession).toBe(4.0); // (3+5)/2
  });
});

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

describe("observability DB queries", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("getAllInvocations returns invocations ordered by startedAt DESC", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-03T00:00:00.000Z",
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-02T00:00:00.000Z",
      status: "completed",
    });

    const result = getAllInvocations(db);
    expect(result).toHaveLength(3);
    expect(result[0].startedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result[1].startedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result[2].startedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("getAllInvocations returns empty array when no invocations", () => {
    expect(getAllInvocations(db)).toEqual([]);
  });

  it("getAllBudgetEvents returns events ordered by recordedAt DESC", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    const inv = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
    });

    insertBudgetEvent(db, { invocationId: inv, costUsd: 1.0, recordedAt: "2026-01-01T00:00:00.000Z" });
    insertBudgetEvent(db, { invocationId: inv, costUsd: 3.0, recordedAt: "2026-01-03T00:00:00.000Z" });
    insertBudgetEvent(db, { invocationId: inv, costUsd: 2.0, recordedAt: "2026-01-02T00:00:00.000Z" });

    const result = getAllBudgetEvents(db);
    expect(result).toHaveLength(3);
    expect(result[0].recordedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result[1].recordedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result[2].recordedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("getAllBudgetEvents returns empty array when no events", () => {
    expect(getAllBudgetEvents(db)).toEqual([]);
  });
});
