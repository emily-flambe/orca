// ---------------------------------------------------------------------------
// Observability feature tests — adversarial coverage
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  getTasksByStatus,
  getInvocationsByStatusGroup,
  getTotalCostAllTime,
  getCostByDay,
  getAvgSessionDuration,
  getTotalInvocations,
  getRecentCompletions,
  getRecentErrors,
  getErrorPatterns,
  getFailureRate,
  getInvocationsForLogSearch,
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

function now(): string {
  return new Date().toISOString();
}

function makeApp(db: OrcaDb): Hono {
  const mockClient = {
    updateIssueState: vi.fn().mockResolvedValue(true),
    createComment: vi.fn().mockResolvedValue(undefined),
  } as any;
  return createApiRoutes({
    db,
    config: makeConfig(),
    syncTasks: vi.fn().mockResolvedValue(0),
    client: mockClient,
    stateMap: new Map(),
  });
}

// ===========================================================================
// UNIT TESTS: Observability query functions
// ===========================================================================

describe("getTasksByStatus", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty object when no tasks exist", () => {
    const result = getTasksByStatus(db);
    expect(result).toEqual({});
  });

  it("counts tasks correctly for each status", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "ready" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-2", orcaStatus: "ready" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-3", orcaStatus: "done" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-4", orcaStatus: "failed" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-5", orcaStatus: "running" as const }));

    const result = getTasksByStatus(db);
    expect(result.ready).toBe(2);
    expect(result.done).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.running).toBe(1);
  });

  it("includes all status types present in the DB", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "backlog" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-2", orcaStatus: "dispatched" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-3", orcaStatus: "in_review" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-4", orcaStatus: "changes_requested" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-5", orcaStatus: "deploying" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-6", orcaStatus: "awaiting_ci" as const }));

    const result = getTasksByStatus(db);
    expect(Object.keys(result)).toHaveLength(6);
    expect(result.backlog).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(result.in_review).toBe(1);
    expect(result.changes_requested).toBe(1);
    expect(result.deploying).toBe(1);
    expect(result.awaiting_ci).toBe(1);
  });

  it("does not include statuses with 0 tasks", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "ready" as const }));

    const result = getTasksByStatus(db);
    expect(result).toEqual({ ready: 1 });
    expect(result.done).toBeUndefined();
    expect(result.failed).toBeUndefined();
  });
});

describe("getInvocationsByStatusGroup", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty object when no invocations exist", () => {
    const result = getInvocationsByStatusGroup(db);
    expect(result).toEqual({});
  });

  it("counts invocations correctly for each status", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getInvocationsByStatusGroup(db);
    expect(result.running).toBe(1);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.timed_out).toBe(1);
  });
});

describe("getTotalCostAllTime", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns 0 when no invocations exist", () => {
    const result = getTotalCostAllTime(db);
    expect(result).toBe(0);
  });

  it("sums costUsd correctly", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 1.50 });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 2.75 });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed", costUsd: 0.25 });

    const result = getTotalCostAllTime(db);
    expect(result).toBeCloseTo(4.50, 2);
  });

  it("handles null costUsd values (invocations without cost data)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 1.00 });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" }); // no cost

    const result = getTotalCostAllTime(db);
    expect(result).toBeCloseTo(1.00, 2);
  });

  it("returns 0 when all invocations have null costUsd", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });

    const result = getTotalCostAllTime(db);
    expect(result).toBe(0);
  });

  it("handles very small cost values without floating point issues", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 0.001 });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 0.002 });

    const result = getTotalCostAllTime(db);
    expect(result).toBeCloseTo(0.003, 4);
  });

  it("handles zero costUsd (which is truthy as a number but passes the null check)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 0 });

    // BUG CANDIDATE: result?.total is "0" (string from sum()) which is falsy
    // The code does: result?.total ? Number(result.total) : 0
    // When sum is "0", the string "0" is falsy, so it returns 0.
    // This is actually correct for costUsd=0, but let's verify the behavior is at least consistent.
    const result = getTotalCostAllTime(db);
    expect(result).toBe(0);
  });
});

describe("getCostByDay", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty array when no budget events exist", () => {
    const result = getCostByDay(db);
    expect(result).toEqual([]);
  });

  it("returns daily aggregates ordered by date", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
    });

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    insertBudgetEvent(db, { invocationId: invId, costUsd: 1.00, recordedAt: `${today}T10:00:00.000Z` });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 2.00, recordedAt: `${today}T11:00:00.000Z` });
    insertBudgetEvent(db, { invocationId: invId, costUsd: 0.50, recordedAt: `${yesterday}T10:00:00.000Z` });

    const result = getCostByDay(db);
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Find today's entry
    const todayEntry = result.find((r) => r.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.cost).toBeCloseTo(3.00, 2);

    // Find yesterday's entry
    const yesterdayEntry = result.find((r) => r.date === yesterday);
    expect(yesterdayEntry).toBeDefined();
    expect(yesterdayEntry!.cost).toBeCloseTo(0.50, 2);
  });

  it("excludes budget events older than 30 days", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
    });

    // Event from 31 days ago
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    insertBudgetEvent(db, { invocationId: invId, costUsd: 5.00, recordedAt: oldDate });

    // Event from today
    insertBudgetEvent(db, { invocationId: invId, costUsd: 1.00, recordedAt: now() });

    const result = getCostByDay(db);
    // Should only contain today's entry, not the 31-day-old one
    expect(result.length).toBe(1);
    expect(result[0].cost).toBeCloseTo(1.00, 2);
  });
});

describe("getAvgSessionDuration", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns 0 when no invocations exist", () => {
    const result = getAvgSessionDuration(db);
    expect(result).toBe(0);
  });

  it("returns 0 when no completed invocations exist", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "running",
    });

    const result = getAvgSessionDuration(db);
    expect(result).toBe(0);
  });

  it("returns 0 when completed invocations have null endedAt", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    // A completed invocation without endedAt (shouldn't happen in practice but
    // let's make sure it doesn't crash)
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      // endedAt is null
    });

    // The query filters on isNotNull(endedAt), so this should be excluded
    const result = getAvgSessionDuration(db);
    expect(result).toBe(0);
  });

  it("calculates average duration correctly for completed invocations", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    // 60 seconds duration
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
    });

    // 120 seconds duration
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:02:00.000Z",
      status: "completed",
    });

    const result = getAvgSessionDuration(db);
    // Average of 60 and 120 = 90 seconds
    expect(result).toBe(90);
  });

  it("excludes non-completed invocations from average", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    // Completed: 60s
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
    });

    // Failed with endedAt: should NOT be included
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      status: "failed",
    });

    const result = getAvgSessionDuration(db);
    // Only the completed one counts (60s)
    expect(result).toBe(60);
  });

  it("BUG: rounds the average but julianday has floating-point precision loss", () => {
    // BUG: SQLite's julianday() introduces systematic precision errors.
    // A 61-second gap computes as ~60.9999 seconds, and a 62-second gap
    // as ~61.9999 seconds. The average of these is ~61.4999 instead of 61.5,
    // causing Math.round to round DOWN to 61 instead of UP to 62.
    // This means getAvgSessionDuration can be off by ~1 second.
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    // 61s
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:01.000Z",
      status: "completed",
    });

    // 62s
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:02.000Z",
      status: "completed",
    });

    const result = getAvgSessionDuration(db);
    // Using strftime('%s') for integer-second arithmetic avoids julianday
    // floating-point precision loss. avg(61, 62) = 61.5, rounds to 62.
    expect(result).toBe(62);
  });
});

describe("getTotalInvocations", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns 0 when no invocations exist", () => {
    const result = getTotalInvocations(db);
    expect(result).toBe(0);
  });

  it("counts all invocations regardless of status", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getTotalInvocations(db);
    expect(result).toBe(4);
  });
});

describe("getRecentCompletions", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty array when no invocations exist", () => {
    const result = getRecentCompletions(db);
    expect(result).toEqual([]);
  });

  it("excludes running invocations", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });

    const result = getRecentCompletions(db);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
  });

  it("includes failed and timed_out invocations (not just completed)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:01:00.000Z", status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:02:00.000Z", status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:03:00.000Z", status: "timed_out" });

    const result = getRecentCompletions(db);
    expect(result).toHaveLength(3);
  });

  it("respects the limit parameter", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 5; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-01T00:0${i}:00.000Z`,
        status: "completed",
      });
    }

    const result = getRecentCompletions(db, 3);
    expect(result).toHaveLength(3);
  });

  it("orders by startedAt desc (most recent first)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:00:00.000Z", status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:02:00.000Z", status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:01:00.000Z", status: "completed" });

    const result = getRecentCompletions(db);
    expect(result[0].startedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(result[1].startedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(result[2].startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("getRecentErrors", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty array when no invocations exist", () => {
    const result = getRecentErrors(db);
    expect(result).toEqual([]);
  });

  it("only returns failed and timed_out invocations", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getRecentErrors(db);
    expect(result).toHaveLength(2);
    const statuses = result.map((r) => r.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("timed_out");
    expect(statuses).not.toContain("running");
    expect(statuses).not.toContain("completed");
  });

  it("respects the limit parameter", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 10; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        status: "failed",
      });
    }

    const result = getRecentErrors(db, 5);
    expect(result).toHaveLength(5);
  });

  it("orders by startedAt desc", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:00:00.000Z", status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:02:00.000Z", status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:01:00.000Z", status: "timed_out" });

    const result = getRecentErrors(db);
    expect(result[0].startedAt).toBe("2026-01-01T00:02:00.000Z");
    expect(result[1].startedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(result[2].startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("getErrorPatterns", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty array when no errors exist", () => {
    const result = getErrorPatterns(db);
    expect(result).toEqual([]);
  });

  it("groups by outputSummary correctly", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));

    // Same error 3 times
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "failed",
      outputSummary: "max turns reached",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-02T00:00:00.000Z",
      status: "failed",
      outputSummary: "max turns reached",
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-03T00:00:00.000Z",
      status: "failed",
      outputSummary: "max turns reached",
    });

    // Different error once
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "timed_out",
      outputSummary: "session timeout",
    });

    const result = getErrorPatterns(db);
    expect(result).toHaveLength(2);

    // Ordered by count desc
    expect(result[0].pattern).toBe("max turns reached");
    expect(result[0].count).toBe(3);
    expect(result[0].lastSeen).toBe("2026-01-03T00:00:00.000Z");

    expect(result[1].pattern).toBe("session timeout");
    expect(result[1].count).toBe(1);
  });

  it("excludes errors with null outputSummary", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "failed",
      outputSummary: null,
    });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "failed",
      outputSummary: "real error",
    });

    const result = getErrorPatterns(db);
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe("real error");
  });

  it("excludes completed invocations from patterns", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
      outputSummary: "some output",
    });

    const result = getErrorPatterns(db);
    expect(result).toEqual([]);
  });

  it("respects the limit parameter", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 25; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: now(),
        status: "failed",
        outputSummary: `error type ${i}`,
      });
    }

    const result = getErrorPatterns(db, 10);
    expect(result).toHaveLength(10);
  });
});

describe("getFailureRate", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns zero rate when no invocations exist", () => {
    const result = getFailureRate(db);
    expect(result).toEqual({ total: 0, failed: 0, rate: 0 });
  });

  it("returns correct failure rate", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });

    const result = getFailureRate(db);
    expect(result.total).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.rate).toBe(0.25);
  });

  it("excludes running invocations from total", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });

    const result = getFailureRate(db);
    // Total should be 2 (completed + failed), not 3
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.rate).toBe(0.5);
  });

  it("includes timed_out in the failed count", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getFailureRate(db);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.rate).toBe(0.5);
  });

  it("returns 1.0 when all invocations failed", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getFailureRate(db);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.rate).toBe(1);
  });

  it("rounds rate to 2 decimal places", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });

    const result = getFailureRate(db);
    // 1/3 = 0.3333... should be rounded to 0.33
    expect(result.rate).toBe(0.33);
  });

  it("handles only running invocations (total=0 for non-running, rate=0)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });

    const result = getFailureRate(db);
    expect(result.total).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.rate).toBe(0);
  });
});

describe("getInvocationsForLogSearch", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns empty array when no invocations exist", () => {
    const result = getInvocationsForLogSearch(db);
    expect(result).toEqual([]);
  });

  it("returns all invocations without taskId filter (up to 100)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertTask(db, makeTask({ linearIssueId: "T-2" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", logPath: "logs/1.ndjson" });
    insertInvocation(db, { linearIssueId: "T-2", startedAt: now(), status: "failed", logPath: "logs/2.ndjson" });

    const result = getInvocationsForLogSearch(db);
    expect(result).toHaveLength(2);
  });

  it("filters by taskId when provided", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertTask(db, makeTask({ linearIssueId: "T-2" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", logPath: "logs/1.ndjson" });
    insertInvocation(db, { linearIssueId: "T-2", startedAt: now(), status: "completed", logPath: "logs/2.ndjson" });

    const result = getInvocationsForLogSearch(db, "T-1");
    expect(result).toHaveLength(1);
    expect(result[0].linearIssueId).toBe("T-1");
  });

  it("returns only id, linearIssueId, startedAt, logPath fields", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
      logPath: "logs/1.ndjson",
      costUsd: 5.0,
      outputSummary: "done",
    });

    const result = getInvocationsForLogSearch(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("id");
    expect(result[0]).toHaveProperty("linearIssueId");
    expect(result[0]).toHaveProperty("startedAt");
    expect(result[0]).toHaveProperty("logPath");
    // Should NOT have these fields
    expect(result[0]).not.toHaveProperty("costUsd");
    expect(result[0]).not.toHaveProperty("outputSummary");
    expect(result[0]).not.toHaveProperty("status");
  });

  it("limits to 100 when no taskId is provided", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 110; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        status: "completed",
        logPath: `logs/${i}.ndjson`,
      });
    }

    const result = getInvocationsForLogSearch(db);
    expect(result).toHaveLength(100);
  });

  it("has NO limit when taskId is provided (returns all matching)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 110; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        status: "completed",
        logPath: `logs/${i}.ndjson`,
      });
    }

    // When filtered by taskId, there's no limit(100) in the code
    const result = getInvocationsForLogSearch(db, "T-1");
    expect(result).toHaveLength(110);
  });

  it("returns empty for non-existent taskId", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });

    const result = getInvocationsForLogSearch(db, "NONEXISTENT");
    expect(result).toEqual([]);
  });

  it("orders by startedAt desc", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-01T00:00:00.000Z", status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-03T00:00:00.000Z", status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: "2026-01-02T00:00:00.000Z", status: "completed" });

    const result = getInvocationsForLogSearch(db);
    expect(result[0].startedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(result[1].startedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result[2].startedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ===========================================================================
// API ROUTE TESTS: Observability endpoints
// ===========================================================================

describe("GET /api/observability/metrics", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 200 with expected shape on empty DB", async () => {
    const res = await app.request("/api/observability/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("tasksByStatus");
    expect(body).toHaveProperty("invocationsByStatus");
    expect(body).toHaveProperty("totalCostAllTime");
    expect(body).toHaveProperty("costByDay");
    expect(body).toHaveProperty("avgSessionDuration");
    expect(body).toHaveProperty("totalInvocations");
    expect(body).toHaveProperty("recentCompletions");

    // Verify types on empty DB
    expect(body.tasksByStatus).toEqual({});
    expect(body.invocationsByStatus).toEqual({});
    expect(body.totalCostAllTime).toBe(0);
    expect(body.costByDay).toEqual([]);
    expect(body.avgSessionDuration).toBe(0);
    expect(body.totalInvocations).toBe(0);
    expect(body.recentCompletions).toEqual([]);
  });

  it("returns populated metrics with data", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "done" as const }));
    insertTask(db, makeTask({ linearIssueId: "T-2", orcaStatus: "ready" as const }));

    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      status: "completed",
      costUsd: 1.50,
      numTurns: 10,
      phase: "implement",
    });

    const res = await app.request("/api/observability/metrics");
    const body = await res.json();

    expect(body.tasksByStatus.done).toBe(1);
    expect(body.tasksByStatus.ready).toBe(1);
    expect(body.totalCostAllTime).toBeCloseTo(1.50, 2);
    expect(body.totalInvocations).toBe(1);
    expect(body.recentCompletions).toHaveLength(1);
    expect(body.recentCompletions[0].costUsd).toBeCloseTo(1.50, 2);
    expect(body.recentCompletions[0].phase).toBe("implement");
  });

  it("recentCompletions in metrics only includes non-running invocations", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "running" });
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
      endedAt: now(),
    });

    const res = await app.request("/api/observability/metrics");
    const body = await res.json();

    // running should be excluded from recentCompletions
    expect(body.recentCompletions).toHaveLength(1);
    expect(body.recentCompletions[0].status).toBe("completed");

    // But totalInvocations counts everything
    expect(body.totalInvocations).toBe(2);
  });

  it("recentCompletions maps only the expected fields (no logPath, no outputSummary, etc.)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      endedAt: now(),
      status: "completed",
      costUsd: 1.0,
      numTurns: 5,
      phase: "implement",
      outputSummary: "done",
      logPath: "/tmp/log.ndjson",
      sessionId: "sess-123",
    });

    const res = await app.request("/api/observability/metrics");
    const body = await res.json();
    const comp = body.recentCompletions[0];

    // Should have these
    expect(comp).toHaveProperty("id");
    expect(comp).toHaveProperty("linearIssueId");
    expect(comp).toHaveProperty("startedAt");
    expect(comp).toHaveProperty("endedAt");
    expect(comp).toHaveProperty("status");
    expect(comp).toHaveProperty("costUsd");
    expect(comp).toHaveProperty("numTurns");
    expect(comp).toHaveProperty("phase");

    // Should NOT have these (they're stripped in the route)
    expect(comp).not.toHaveProperty("logPath");
    expect(comp).not.toHaveProperty("outputSummary");
    expect(comp).not.toHaveProperty("sessionId");
    expect(comp).not.toHaveProperty("branchName");
    expect(comp).not.toHaveProperty("worktreePath");
  });
});

describe("GET /api/observability/errors", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 200 with expected shape on empty DB", async () => {
    const res = await app.request("/api/observability/errors");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("recentErrors");
    expect(body).toHaveProperty("errorPatterns");
    expect(body).toHaveProperty("failureRate");

    expect(body.recentErrors).toEqual([]);
    expect(body.errorPatterns).toEqual([]);
    expect(body.failureRate).toEqual({ total: 0, failed: 0, rate: 0 });
  });

  it("returns error data when failures exist", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      endedAt: now(),
      status: "failed",
      outputSummary: "build failed",
      phase: "implement",
      costUsd: 0.50,
    });

    const res = await app.request("/api/observability/errors");
    const body = await res.json();

    expect(body.recentErrors).toHaveLength(1);
    expect(body.recentErrors[0].outputSummary).toBe("build failed");
    expect(body.recentErrors[0].phase).toBe("implement");

    expect(body.errorPatterns).toHaveLength(1);
    expect(body.errorPatterns[0].pattern).toBe("build failed");
    expect(body.errorPatterns[0].count).toBe(1);

    expect(body.failureRate.total).toBe(1);
    expect(body.failureRate.failed).toBe(1);
    expect(body.failureRate.rate).toBe(1);
  });

  it("recentErrors maps only expected fields (no logPath, no sessionId, etc.)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      endedAt: now(),
      status: "failed",
      outputSummary: "crash",
      phase: "review",
      costUsd: 0.10,
      logPath: "/tmp/log.ndjson",
      sessionId: "sess-456",
    });

    const res = await app.request("/api/observability/errors");
    const body = await res.json();
    const err = body.recentErrors[0];

    // Should have these
    expect(err).toHaveProperty("id");
    expect(err).toHaveProperty("linearIssueId");
    expect(err).toHaveProperty("startedAt");
    expect(err).toHaveProperty("endedAt");
    expect(err).toHaveProperty("outputSummary");
    expect(err).toHaveProperty("phase");
    expect(err).toHaveProperty("costUsd");

    // Should NOT have these
    expect(err).not.toHaveProperty("logPath");
    expect(err).not.toHaveProperty("sessionId");
    expect(err).not.toHaveProperty("status");
    expect(err).not.toHaveProperty("branchName");
    expect(err).not.toHaveProperty("numTurns");
  });
});

describe("GET /api/observability/logs/search", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 400 when no query params are provided", async () => {
    const res = await app.request("/api/observability/logs/search");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at least one");
  });

  it("returns 200 with empty results when q is provided but no log files exist", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
      logPath: "/nonexistent/path/log.ndjson",
    });

    const res = await app.request("/api/observability/logs/search?q=error");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("accepts taskId alone without q", async () => {
    const res = await app.request("/api/observability/logs/search?taskId=T-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
  });

  it("accepts q alone without taskId", async () => {
    const res = await app.request("/api/observability/logs/search?q=test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });

  it("accepts both q and taskId", async () => {
    const res = await app.request("/api/observability/logs/search?q=test&taskId=T-1");
    expect(res.status).toBe(200);
  });

  it("returns 400 when q is empty string and no taskId", async () => {
    // q="" is a falsy string, so !q is true. taskId is undefined, so !taskId is true.
    // Both are falsy, should trigger the 400.
    const res = await app.request("/api/observability/logs/search?q=");
    expect(res.status).toBe(400);
  });

  it("handles taskId with special characters in query string", async () => {
    // e.g. taskId=EMI-90 (the hyphen is fine, but test URL encoding)
    const res = await app.request("/api/observability/logs/search?taskId=EMI%2D90");
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// EDGE CASE / BUG HUNTING TESTS
// ===========================================================================

describe("Edge cases: large data sets", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("getRecentCompletions default limit is 20", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 30; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        status: "completed",
      });
    }

    const result = getRecentCompletions(db); // default limit=20
    expect(result).toHaveLength(20);
  });

  it("getRecentErrors default limit is 50", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 60; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
        status: "failed",
      });
    }

    const result = getRecentErrors(db); // default limit=50
    expect(result).toHaveLength(50);
  });

  it("getErrorPatterns default limit is 20", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 25; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: now(),
        status: "failed",
        outputSummary: `unique error ${i}`,
      });
    }

    const result = getErrorPatterns(db); // default limit=20
    expect(result).toHaveLength(20);
  });
});

describe("Edge cases: cost calculations with floating point", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("getTotalCostAllTime handles many small values", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 100; i++) {
      insertInvocation(db, {
        linearIssueId: "T-1",
        startedAt: now(),
        status: "completed",
        costUsd: 0.01,
      });
    }

    const result = getTotalCostAllTime(db);
    expect(result).toBeCloseTo(1.00, 1);
  });
});

describe("Edge cases: failure rate precision", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("failure rate with 1 failed out of 7 rounds to 0.14", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    for (let i = 0; i < 6; i++) {
      insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    }
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });

    const result = getFailureRate(db);
    expect(result.total).toBe(7);
    expect(result.failed).toBe(1);
    // 1/7 = 0.142857... toFixed(2) = "0.14"
    expect(result.rate).toBe(0.14);
  });

  it("failure rate with 2 failed out of 3 rounds to 0.67", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "timed_out" });

    const result = getFailureRate(db);
    expect(result.total).toBe(3);
    expect(result.failed).toBe(2);
    // 2/3 = 0.6666... toFixed(2) = "0.67"
    expect(result.rate).toBe(0.67);
  });
});

describe("Edge case: getAvgSessionDuration with very long sessions", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("handles multi-hour sessions correctly", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    // 2 hour session
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T02:00:00.000Z",
      status: "completed",
    });

    const result = getAvgSessionDuration(db);
    expect(result).toBe(7200); // 2 hours in seconds
  });

  it("handles sub-second sessions correctly (rounds to 0 or 1)", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    // Same second timestamps (0 duration)
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
    });

    const result = getAvgSessionDuration(db);
    expect(result).toBe(0);
  });
});

describe("Edge case: getTasksByStatus with single task", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns correct count for single task", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1", orcaStatus: "ready" as const }));

    const result = getTasksByStatus(db);
    expect(result).toEqual({ ready: 1 });
  });
});

describe("Edge case: cross-task invocations in observability queries", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("aggregation queries span across all tasks", () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertTask(db, makeTask({ linearIssueId: "T-2" }));

    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed", costUsd: 1.0 });
    insertInvocation(db, { linearIssueId: "T-2", startedAt: now(), status: "failed", costUsd: 2.0 });

    const totalCost = getTotalCostAllTime(db);
    expect(totalCost).toBeCloseTo(3.0, 2);

    const totalInv = getTotalInvocations(db);
    expect(totalInv).toBe(2);
  });
});

// ===========================================================================
// BUG-HUNTING: Potential issues found during analysis
// ===========================================================================

describe("BUG HUNT: getTotalCostAllTime truthiness check", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("BUG: getTotalCostAllTime returns 0 for costUsd=0 entries (falsy string '0' from SQL sum)", () => {
    // The function uses: result?.total ? Number(result.total) : 0
    // SQL sum("0") returns the string "0" which is falsy in JS.
    // This means if ALL costs are exactly 0, the function returns 0 which
    // happens to be correct, but it's a latent bug if you add 0 + 1.5 + 0:
    // the sum would be "1.5" which is truthy, so it works. The bug only
    // manifests if the sum is literally "0".
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "completed",
      costUsd: 0,
    });

    // This is technically correct behavior (sum of zeros is zero), but
    // the code path is wrong: it's taking the else branch due to falsiness
    // rather than the intended Number conversion branch.
    const result = getTotalCostAllTime(db);
    expect(result).toBe(0);
  });
});

describe("BUG HUNT: getErrorPatterns null pattern fallback", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("pattern field is never null because query already filters isNotNull(outputSummary)", () => {
    // The code maps r.pattern ?? "unknown" as a fallback, but the query
    // already filters with isNotNull(invocations.outputSummary), so
    // r.pattern should never be null. This is defensive but correct.
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      status: "failed",
      outputSummary: "real error",
    });

    const result = getErrorPatterns(db);
    expect(result[0].pattern).toBe("real error");
    expect(result[0].pattern).not.toBe("unknown");
  });
});

describe("BUG HUNT: API endpoint response shapes match frontend types", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("metrics endpoint status field in recentCompletions is string type", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      endedAt: now(),
      status: "completed",
      costUsd: 0.50,
    });

    const res = await app.request("/api/observability/metrics");
    const body = await res.json();
    const comp = body.recentCompletions[0];

    // Frontend type says status: string
    expect(typeof comp.status).toBe("string");
    // Frontend type says costUsd: number | null
    expect(typeof comp.costUsd).toBe("number");
  });

  it("errors endpoint status field is NOT included in recentErrors", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, {
      linearIssueId: "T-1",
      startedAt: now(),
      endedAt: now(),
      status: "failed",
      outputSummary: "crash",
    });

    const res = await app.request("/api/observability/errors");
    const body = await res.json();
    const err = body.recentErrors[0];

    // The frontend type ObservabilityErrors.recentErrors does NOT include status
    // Verify the API matches
    expect(err).not.toHaveProperty("status");
  });
});

describe("BUG HUNT: empty string q parameter behavior", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("q='' with taskId still returns 400 because !q is true but taskId is provided -- wait no", async () => {
    // If q="" and taskId="T-1", then !q is true (empty string is falsy) but
    // !taskId is false. So the condition (!q && !taskId) is false.
    // The endpoint will proceed with q="" which is a weird edge case.
    const res = await app.request("/api/observability/logs/search?q=&taskId=T-1");
    // This should be 200 because taskId is provided (validation passes)
    expect(res.status).toBe(200);
  });

  it("empty q with valid taskId searches without text filter (returns all log content)", async () => {
    // When q is empty string (falsy), the search logic does:
    // if (!q) { push all lines with textContent }
    // So empty q + taskId = return all log lines for that task
    // This is probably not the intended behavior: "" should be treated like no filter
    const res = await app.request("/api/observability/logs/search?q=&taskId=T-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("totalMatches");
  });
});

describe("BUG HUNT: getInvocationsForLogSearch SQL injection via taskId", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("taskId with SQL injection attempt does not cause errors", () => {
    // Drizzle uses parameterized queries, so this should be safe
    insertTask(db, makeTask({ linearIssueId: "T-1" }));
    insertInvocation(db, { linearIssueId: "T-1", startedAt: now(), status: "completed" });

    // This should not throw or return unexpected results
    const result = getInvocationsForLogSearch(db, "'; DROP TABLE invocations; --");
    expect(result).toEqual([]);
  });
});

describe("BUG HUNT: API log search SQL injection via query params", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("SQL injection in taskId query param is safe (parameterized queries)", async () => {
    const res = await app.request(
      "/api/observability/logs/search?taskId=' OR 1=1 --",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });

  it("SQL injection in q query param is safe (search is in-memory, not SQL)", async () => {
    // The q param is used for in-memory string matching, not SQL, so this is safe
    const res = await app.request(
      "/api/observability/logs/search?q=' OR 1=1 --&taskId=T-1",
    );
    expect(res.status).toBe(200);
  });
});
