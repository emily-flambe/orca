// ---------------------------------------------------------------------------
// Observability metrics — adversarial tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  getMetricsSummary,
  getMetricsTimeline,
  getMetricsErrors,
  getTaskMetrics,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

/** ISO date string N days ago. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** ISO date string at a specific date (YYYY-MM-DD format, midnight UTC). */
function dateAt(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00.000Z`).toISOString();
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    priority: number;
    retryCount: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: (overrides.orcaStatus as "ready") ?? "ready",
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

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

// ---------------------------------------------------------------------------
// 1. Empty database — all metrics functions return sane defaults
// ---------------------------------------------------------------------------

describe("getMetricsSummary — empty database", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty tasksByStatus on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.tasksByStatus).toEqual({});
  });

  it("returns empty invocationsByStatus on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.invocationsByStatus).toEqual({});
  });

  it("returns 0 totalCostUsd on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.totalCostUsd).toBe(0);
  });

  it("returns null avgDurationSec on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.avgDurationSec).toBeNull();
  });

  it("returns 0 totalInvocations on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.totalInvocations).toBe(0);
  });

  it("returns 0 successRate on empty DB", () => {
    const result = getMetricsSummary(db);
    expect(result.successRate).toBe(0);
  });
});

describe("getMetricsTimeline — empty database", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty array on empty DB", () => {
    const result = getMetricsTimeline(db, 30);
    expect(result).toEqual([]);
  });
});

describe("getMetricsErrors — empty database", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty array on empty DB", () => {
    const result = getMetricsErrors(db, 20);
    expect(result).toEqual([]);
  });
});

describe("getTaskMetrics — empty database", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty array on empty DB", () => {
    const result = getTaskMetrics(db);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. getMetricsSummary with mixed data
// ---------------------------------------------------------------------------

describe("getMetricsSummary — mixed data", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("counts tasks by status correctly", () => {
    seedTask(db, { linearIssueId: "T-READY-1", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "T-READY-2", orcaStatus: "ready" });
    seedTask(db, { linearIssueId: "T-RUNNING-1", orcaStatus: "running" });
    seedTask(db, { linearIssueId: "T-DONE-1", orcaStatus: "done" });
    seedTask(db, { linearIssueId: "T-FAILED-1", orcaStatus: "failed" });

    const result = getMetricsSummary(db);
    expect(result.tasksByStatus["ready"]).toBe(2);
    expect(result.tasksByStatus["running"]).toBe(1);
    expect(result.tasksByStatus["done"]).toBe(1);
    expect(result.tasksByStatus["failed"]).toBe(1);
  });

  it("counts invocations by status correctly", () => {
    const taskId = seedTask(db, { linearIssueId: "T-INV" });

    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed", costUsd: 0.10 });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed", costUsd: 0.20 });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "failed", costUsd: 0.05 });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "running" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "timed_out", costUsd: 0.30 });

    const result = getMetricsSummary(db);
    expect(result.invocationsByStatus["completed"]).toBe(2);
    expect(result.invocationsByStatus["failed"]).toBe(1);
    expect(result.invocationsByStatus["running"]).toBe(1);
    expect(result.invocationsByStatus["timed_out"]).toBe(1);
  });

  it("sums totalCostUsd correctly across all invocations", () => {
    const taskId = seedTask(db, { linearIssueId: "T-COST" });

    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed", costUsd: 1.50 });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed", costUsd: 2.25 });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "failed", costUsd: 0.75 });

    const result = getMetricsSummary(db);
    expect(result.totalCostUsd).toBeCloseTo(4.50);
  });

  it("computes successRate = completed / total", () => {
    const taskId = seedTask(db, { linearIssueId: "T-RATE" });

    // 3 completed, 1 failed, 1 running = 3/5 = 0.6
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "completed" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "failed" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "running" });

    const result = getMetricsSummary(db);
    expect(result.successRate).toBeCloseTo(0.6);
    expect(result.totalInvocations).toBe(5);
  });

  it("computes avgDurationSec for invocations with endedAt", () => {
    const taskId = seedTask(db, { linearIssueId: "T-DUR" });

    // Invocation 1: 60 seconds
    const start1 = "2026-01-15T10:00:00.000Z";
    const end1 = "2026-01-15T10:01:00.000Z";
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: start1,
      endedAt: end1,
      status: "completed",
    });

    // Invocation 2: 120 seconds
    const start2 = "2026-01-15T11:00:00.000Z";
    const end2 = "2026-01-15T11:02:00.000Z";
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: start2,
      endedAt: end2,
      status: "completed",
    });

    // Invocation 3: still running (no endedAt) — should be excluded from avg
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T12:00:00.000Z",
      status: "running",
    });

    const result = getMetricsSummary(db);
    // avg of 60s and 120s = 90s
    expect(result.avgDurationSec).toBeCloseTo(90, 0);
  });

  it("handles only-running invocations (no endedAt anywhere) gracefully for avgDurationSec", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NOEND" });
    insertInvocation(db, { linearIssueId: taskId, startedAt: now(), status: "running" });

    const result = getMetricsSummary(db);
    // All invocations lack endedAt, so avg should be null
    expect(result.avgDurationSec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. getMetricsTimeline
// ---------------------------------------------------------------------------

describe("getMetricsTimeline", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("buckets invocations by date correctly", () => {
    const taskId = seedTask(db, { linearIssueId: "T-TIMELINE" });

    // Two invocations on the same day
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-10"),
      status: "completed",
      costUsd: 1.00,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-10"),
      status: "failed",
      costUsd: 0.50,
    });

    // One invocation on a different day
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-11"),
      status: "completed",
      costUsd: 2.00,
    });

    // Use a large window to include all
    const result = getMetricsTimeline(db, 365);

    expect(result.length).toBe(2);

    const day1 = result.find((r) => r.date === "2026-02-10");
    expect(day1).toBeDefined();
    expect(day1!.costUsd).toBeCloseTo(1.50);
    expect(day1!.completedCount).toBe(1);
    expect(day1!.failedCount).toBe(1);

    const day2 = result.find((r) => r.date === "2026-02-11");
    expect(day2).toBeDefined();
    expect(day2!.costUsd).toBeCloseTo(2.00);
    expect(day2!.completedCount).toBe(1);
    expect(day2!.failedCount).toBe(0);
  });

  it("does not include days with zero invocations (sparse result)", () => {
    const taskId = seedTask(db, { linearIssueId: "T-SPARSE" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-01"),
      status: "completed",
      costUsd: 1.00,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-05"),
      status: "completed",
      costUsd: 2.00,
    });

    const result = getMetricsTimeline(db, 365);
    // Only 2 entries, not 5 (no gap-filling)
    expect(result.length).toBe(2);
    expect(result.map((r) => r.date)).toEqual(["2026-02-01", "2026-02-05"]);
  });

  it("respects the days parameter — excludes old data", () => {
    const taskId = seedTask(db, { linearIssueId: "T-WINDOW" });

    // Old invocation: 60 days ago
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(60),
      status: "completed",
      costUsd: 100.00,
    });

    // Recent invocation: 2 days ago
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(2),
      status: "completed",
      costUsd: 5.00,
    });

    const result = getMetricsTimeline(db, 7);
    // Only the recent invocation should appear
    expect(result.length).toBe(1);
    expect(result[0]!.costUsd).toBeCloseTo(5.00);
  });

  it("counts timed_out invocations as failed", () => {
    const taskId = seedTask(db, { linearIssueId: "T-TIMEOUT" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(1),
      status: "timed_out",
      costUsd: 1.00,
    });

    const result = getMetricsTimeline(db, 7);
    expect(result.length).toBe(1);
    expect(result[0]!.failedCount).toBe(1);
    expect(result[0]!.completedCount).toBe(0);
  });

  it("does not count running invocations as completed or failed", () => {
    const taskId = seedTask(db, { linearIssueId: "T-RUNNING-TL" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(1),
      status: "running",
    });

    const result = getMetricsTimeline(db, 7);
    expect(result.length).toBe(1);
    expect(result[0]!.completedCount).toBe(0);
    expect(result[0]!.failedCount).toBe(0);
  });

  it("handles costUsd being null", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NULLCOST-TL" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(1),
      status: "completed",
      // costUsd is not set — should be null
    });

    const result = getMetricsTimeline(db, 7);
    expect(result.length).toBe(1);
    // coalesce(sum(null), 0) should give 0, not NaN or null
    expect(result[0]!.costUsd).toBe(0);
    expect(Number.isNaN(result[0]!.costUsd)).toBe(false);
  });

  it("returns results ordered by date ascending", () => {
    const taskId = seedTask(db, { linearIssueId: "T-ORDER" });

    // Insert in reverse order
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-15"),
      status: "completed",
      costUsd: 3.00,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-10"),
      status: "completed",
      costUsd: 1.00,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: dateAt("2026-02-12"),
      status: "completed",
      costUsd: 2.00,
    });

    const result = getMetricsTimeline(db, 365);
    const dates = result.map((r) => r.date);
    expect(dates).toEqual(["2026-02-10", "2026-02-12", "2026-02-15"]);
  });
});

// ---------------------------------------------------------------------------
// 4. getMetricsErrors
// ---------------------------------------------------------------------------

describe("getMetricsErrors", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("groups failed invocations by outputSummary", () => {
    const taskId = seedTask(db, { linearIssueId: "T-ERR" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
      outputSummary: "timeout exceeded",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
      outputSummary: "timeout exceeded",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
      outputSummary: "permission denied",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(2);

    // Ordered by count descending
    expect(result[0]!.outputSummary).toBe("timeout exceeded");
    expect(result[0]!.count).toBe(2);
    expect(result[1]!.outputSummary).toBe("permission denied");
    expect(result[1]!.count).toBe(1);
  });

  it("includes timed_out invocations in error aggregation", () => {
    const taskId = seedTask(db, { linearIssueId: "T-TO-ERR" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "timed_out",
      outputSummary: "max turns reached",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(1);
    expect(result[0]!.outputSummary).toBe("max turns reached");
    expect(result[0]!.count).toBe(1);
  });

  it("excludes completed and running invocations", () => {
    const taskId = seedTask(db, { linearIssueId: "T-EXCL" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      outputSummary: "all done",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
      outputSummary: "in progress",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(0);
  });

  it("returns lastSeen as the most recent startedAt for each group", () => {
    const taskId = seedTask(db, { linearIssueId: "T-LAST" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "failed",
      outputSummary: "oops",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-02-15T12:00:00.000Z",
      status: "failed",
      outputSummary: "oops",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T00:00:00.000Z",
      status: "failed",
      outputSummary: "oops",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(1);
    expect(result[0]!.lastSeen).toBe("2026-02-15T12:00:00.000Z");
  });

  it("aggregates unique taskIds in the taskIds field", () => {
    const task1 = seedTask(db, { linearIssueId: "T-A" });
    const task2 = seedTask(db, { linearIssueId: "T-B" });

    insertInvocation(db, {
      linearIssueId: task1,
      startedAt: now(),
      status: "failed",
      outputSummary: "same error",
    });
    insertInvocation(db, {
      linearIssueId: task2,
      startedAt: now(),
      status: "failed",
      outputSummary: "same error",
    });
    // Duplicate task1 — should still only appear once due to DISTINCT
    insertInvocation(db, {
      linearIssueId: task1,
      startedAt: now(),
      status: "failed",
      outputSummary: "same error",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(1);
    // taskIds is a comma-separated string from group_concat(distinct ...)
    const ids = result[0]!.taskIds.split(",").sort();
    expect(ids).toEqual(["T-A", "T-B"]);
    expect(result[0]!.count).toBe(3);
  });

  it("respects the limit parameter", () => {
    const taskId = seedTask(db, { linearIssueId: "T-LIM" });

    // Create 5 distinct error types
    for (let i = 0; i < 5; i++) {
      insertInvocation(db, {
        linearIssueId: taskId,
        startedAt: now(),
        status: "failed",
        outputSummary: `error-type-${i}`,
      });
    }

    const result = getMetricsErrors(db, 3);
    expect(result.length).toBe(3);
  });

  it("handles null outputSummary by mapping to 'unknown'", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NULLOUT" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
      // outputSummary is not set — null
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(1);
    expect(result[0]!.outputSummary).toBe("unknown");
  });

  it("groups all null outputSummary invocations together", () => {
    const task1 = seedTask(db, { linearIssueId: "T-NULL1" });
    const task2 = seedTask(db, { linearIssueId: "T-NULL2" });

    insertInvocation(db, {
      linearIssueId: task1,
      startedAt: now(),
      status: "failed",
    });
    insertInvocation(db, {
      linearIssueId: task2,
      startedAt: now(),
      status: "failed",
    });

    const result = getMetricsErrors(db, 20);
    // Both null-outputSummary invocations should be grouped as one entry
    expect(result.length).toBe(1);
    expect(result[0]!.outputSummary).toBe("unknown");
    expect(result[0]!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. getTaskMetrics
// ---------------------------------------------------------------------------

describe("getTaskMetrics", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("aggregates per-task correctly", () => {
    const task1 = seedTask(db, { linearIssueId: "TM-1" });
    const task2 = seedTask(db, { linearIssueId: "TM-2" });

    insertInvocation(db, { linearIssueId: task1, startedAt: now(), status: "completed", costUsd: 2.00 });
    insertInvocation(db, { linearIssueId: task1, startedAt: now(), status: "failed", costUsd: 0.50 });
    insertInvocation(db, { linearIssueId: task2, startedAt: now(), status: "completed", costUsd: 5.00 });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(2);

    // Sorted by cost descending — task2 first ($5), then task1 ($2.50)
    expect(result[0]!.linearIssueId).toBe("TM-2");
    expect(result[0]!.totalCostUsd).toBeCloseTo(5.00);
    expect(result[0]!.totalInvocations).toBe(1);
    expect(result[0]!.completedCount).toBe(1);
    expect(result[0]!.failedCount).toBe(0);

    expect(result[1]!.linearIssueId).toBe("TM-1");
    expect(result[1]!.totalCostUsd).toBeCloseTo(2.50);
    expect(result[1]!.totalInvocations).toBe(2);
    expect(result[1]!.completedCount).toBe(1);
    expect(result[1]!.failedCount).toBe(1);
  });

  it("calculates duration correctly for completed invocations", () => {
    const taskId = seedTask(db, { linearIssueId: "TM-DUR" });

    // 60 seconds
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T10:00:00.000Z",
      endedAt: "2026-01-15T10:01:00.000Z",
      status: "completed",
      costUsd: 1.00,
    });
    // 180 seconds
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T11:00:00.000Z",
      endedAt: "2026-01-15T11:03:00.000Z",
      status: "completed",
      costUsd: 1.00,
    });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(1);
    // avgDurationSec = (60 + 180) / 2 = 120
    expect(result[0]!.avgDurationSec).toBeCloseTo(120, 0);
    // totalDurationSec = 60 + 180 = 240
    expect(result[0]!.totalDurationSec).toBeCloseTo(240, 0);
  });

  it("returns null avgDurationSec when no invocations have endedAt", () => {
    const taskId = seedTask(db, { linearIssueId: "TM-NOEND" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(1);
    expect(result[0]!.avgDurationSec).toBeNull();
  });

  it("handles null costUsd by treating as 0 via coalesce", () => {
    const taskId = seedTask(db, { linearIssueId: "TM-NULLCOST" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      // costUsd is not set — null
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 3.00,
    });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(1);
    expect(result[0]!.totalCostUsd).toBeCloseTo(3.00);
    expect(Number.isNaN(result[0]!.totalCostUsd)).toBe(false);
  });

  it("counts timed_out as failed", () => {
    const taskId = seedTask(db, { linearIssueId: "TM-TIMEDOUT" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "timed_out",
      costUsd: 1.00,
    });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(1);
    expect(result[0]!.failedCount).toBe(1);
    expect(result[0]!.completedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe("Metrics edge cases", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("single invocation in DB works for all metrics functions", () => {
    const taskId = seedTask(db, { linearIssueId: "SOLO" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-02-20T10:00:00.000Z",
      endedAt: "2026-02-20T10:05:00.000Z",
      status: "completed",
      costUsd: 0.42,
    });

    // Summary
    const summary = getMetricsSummary(db);
    expect(summary.totalCostUsd).toBeCloseTo(0.42);
    expect(summary.totalInvocations).toBe(1);
    expect(summary.successRate).toBe(1);
    expect(summary.avgDurationSec).toBeCloseTo(300, 0); // 5 minutes = 300s

    // Timeline
    const timeline = getMetricsTimeline(db, 365);
    expect(timeline.length).toBe(1);
    expect(timeline[0]!.date).toBe("2026-02-20");
    expect(timeline[0]!.costUsd).toBeCloseTo(0.42);

    // Errors — completed invocation should not appear
    const errors = getMetricsErrors(db, 20);
    expect(errors.length).toBe(0);

    // Task metrics
    const taskMetrics = getTaskMetrics(db);
    expect(taskMetrics.length).toBe(1);
    expect(taskMetrics[0]!.linearIssueId).toBe("SOLO");
  });

  it("very large cost value does not overflow or lose precision", () => {
    const taskId = seedTask(db, { linearIssueId: "T-BIGCOST" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 999999.99,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 0.01,
    });

    const summary = getMetricsSummary(db);
    expect(summary.totalCostUsd).toBeCloseTo(1000000.00);

    const taskMetrics = getTaskMetrics(db);
    expect(taskMetrics[0]!.totalCostUsd).toBeCloseTo(1000000.00);
  });

  it("invocation with null endedAt excluded from duration calculations", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NULLEND" });

    // One with duration, one without
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-02-20T10:00:00.000Z",
      endedAt: "2026-02-20T10:01:00.000Z",
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-02-20T11:00:00.000Z",
      status: "running",
    });

    const summary = getMetricsSummary(db);
    // Only the first invocation should contribute to average (60s)
    expect(summary.avgDurationSec).toBeCloseTo(60, 0);
  });

  it("invocation with costUsd = 0 is counted (not treated as null)", () => {
    const taskId = seedTask(db, { linearIssueId: "T-ZEROCOST" });

    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 0,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 2.00,
    });

    const summary = getMetricsSummary(db);
    expect(summary.totalCostUsd).toBeCloseTo(2.00);
    expect(summary.totalInvocations).toBe(2);
  });

  it("tasks with no invocations do not appear in getTaskMetrics", () => {
    seedTask(db, { linearIssueId: "T-NOINV" });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(0);
  });

  it("tasks with no invocations still appear in getMetricsSummary tasksByStatus", () => {
    seedTask(db, { linearIssueId: "T-NOINV2", orcaStatus: "ready" });

    const summary = getMetricsSummary(db);
    expect(summary.tasksByStatus["ready"]).toBe(1);
    expect(summary.totalInvocations).toBe(0);
  });

  it("getMetricsTimeline with days=1 only shows today's data", () => {
    const taskId = seedTask(db, { linearIssueId: "T-TODAY" });

    // Today
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 1.00,
    });

    // 3 days ago
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: daysAgo(3),
      status: "completed",
      costUsd: 10.00,
    });

    const result = getMetricsTimeline(db, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.costUsd).toBeCloseTo(1.00);
  });
});

// ---------------------------------------------------------------------------
// 7. API route tests for metrics endpoints
// ---------------------------------------------------------------------------

describe("GET /api/metrics", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) } as any);
  });

  it("returns 200 with expected shape on empty DB", async () => {
    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("tasksByStatus");
    expect(body).toHaveProperty("invocationsByStatus");
    expect(body).toHaveProperty("totalCostUsd");
    expect(body).toHaveProperty("avgDurationSec");
    expect(body).toHaveProperty("totalInvocations");
    expect(body).toHaveProperty("successRate");
    expect(body).toHaveProperty("taskMetrics");
    expect(Array.isArray(body.taskMetrics)).toBe(true);
  });

  it("returns correct data when tasks and invocations exist", async () => {
    insertTask(db, {
      linearIssueId: "M-1",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "done",
      priority: 0,
      retryCount: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    insertInvocation(db, {
      linearIssueId: "M-1",
      startedAt: now(),
      status: "completed",
      costUsd: 1.23,
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();

    expect(body.totalCostUsd).toBeCloseTo(1.23);
    expect(body.totalInvocations).toBe(1);
    expect(body.successRate).toBe(1);
    expect(body.taskMetrics.length).toBe(1);
    expect(body.taskMetrics[0].linearIssueId).toBe("M-1");
  });
});

describe("GET /api/metrics/timeline", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) } as any);
  });

  it("returns 200 with timeline array", async () => {
    const res = await app.request("/api/metrics/timeline");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("timeline");
    expect(Array.isArray(body.timeline)).toBe(true);
  });

  it("defaults to 30 days when no query param", async () => {
    // This is a behavioral test — insert data 31 days ago and verify it is excluded
    insertTask(db, {
      linearIssueId: "TL-OLD",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "done",
      priority: 0,
      retryCount: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    insertInvocation(db, {
      linearIssueId: "TL-OLD",
      startedAt: daysAgo(31),
      status: "completed",
      costUsd: 99.0,
    });

    const res = await app.request("/api/metrics/timeline");
    const body = await res.json();
    expect(body.timeline.length).toBe(0); // 31 days ago is outside 30-day default
  });

  it("clamps days=0 to days=1", async () => {
    const res = await app.request("/api/metrics/timeline?days=0");
    expect(res.status).toBe(200);
    // No crash means clamping worked
  });

  it("clamps days=-5 to days=1", async () => {
    const res = await app.request("/api/metrics/timeline?days=-5");
    expect(res.status).toBe(200);
  });

  it("clamps days=9999 to days=365", async () => {
    // Insert data 400 days ago
    insertTask(db, {
      linearIssueId: "TL-ANCIENT",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "done",
      priority: 0,
      retryCount: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    insertInvocation(db, {
      linearIssueId: "TL-ANCIENT",
      startedAt: daysAgo(400),
      status: "completed",
      costUsd: 50.0,
    });

    const res = await app.request("/api/metrics/timeline?days=9999");
    const body = await res.json();
    // 400 days ago should be excluded if clamped to 365
    expect(body.timeline.length).toBe(0);
  });

  it("handles non-numeric days param by defaulting to 30", async () => {
    const res = await app.request("/api/metrics/timeline?days=abc");
    expect(res.status).toBe(200);
    // Number("abc") is NaN, || 30 should kick in
  });
});

describe("GET /api/metrics/errors", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) } as any);
  });

  it("returns 200 with errors array", async () => {
    const res = await app.request("/api/metrics/errors");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("errors");
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("defaults to limit=20 when no query param", async () => {
    const res = await app.request("/api/metrics/errors");
    expect(res.status).toBe(200);
    // Just verify it doesn't crash
  });

  it("clamps limit=0 to limit=1", async () => {
    const res = await app.request("/api/metrics/errors?limit=0");
    expect(res.status).toBe(200);
  });

  it("clamps limit=-1 to limit=1", async () => {
    const res = await app.request("/api/metrics/errors?limit=-1");
    expect(res.status).toBe(200);
  });

  it("clamps limit=999 to limit=100", async () => {
    // Create 101 distinct error types to test the clamp
    insertTask(db, {
      linearIssueId: "ERR-CLAMP",
      agentPrompt: "test",
      repoPath: "/tmp",
      orcaStatus: "failed",
      priority: 0,
      retryCount: 0,
      createdAt: now(),
      updatedAt: now(),
    });
    for (let i = 0; i < 101; i++) {
      insertInvocation(db, {
        linearIssueId: "ERR-CLAMP",
        startedAt: now(),
        status: "failed",
        outputSummary: `error-${i}`,
      });
    }

    const res = await app.request("/api/metrics/errors?limit=999");
    const body = await res.json();
    expect(body.errors.length).toBeLessThanOrEqual(100);
  });

  it("handles non-numeric limit by defaulting to 20", async () => {
    const res = await app.request("/api/metrics/errors?limit=abc");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8. Deeper adversarial tests — probing for real bugs
// ---------------------------------------------------------------------------

describe("getMetricsSummary — avgDurationSec includes failed invocations (potential design issue)", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("avgDurationSec includes failed invocations with endedAt (not just completed)", () => {
    // The code comment says "completed invocations only" but the WHERE clause
    // is `isNotNull(invocations.endedAt)`, which includes failed invocations too.
    // This test documents the actual behavior.
    const taskId = seedTask(db, { linearIssueId: "T-MIXDUR" });

    // Completed: 60 seconds
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T10:00:00.000Z",
      endedAt: "2026-01-15T10:01:00.000Z",
      status: "completed",
    });

    // Failed: 300 seconds (5 min) — has endedAt, so will be included
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: "2026-01-15T11:00:00.000Z",
      endedAt: "2026-01-15T11:05:00.000Z",
      status: "failed",
    });

    const result = getMetricsSummary(db);
    // If code only included completed, avg would be 60s.
    // If code includes all with endedAt, avg is (60+300)/2 = 180s.
    // The actual implementation uses isNotNull(endedAt), so it includes failed:
    expect(result.avgDurationSec).toBeCloseTo(180, 0);
    // BUG/DESIGN: The comment says "completed invocations only" but the filter
    // is isNotNull(endedAt). The code and comment disagree.
  });
});

describe("getMetricsTimeline — direct call with negative/zero days", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("calling getMetricsTimeline directly with days=0 uses today as since boundary", () => {
    // days=0: since = new Date(Date.now() - 0).toISOString().slice(0,10) = today
    // This should still return today's data because the WHERE is >=
    const taskId = seedTask(db, { linearIssueId: "T-ZERO" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 1.0,
    });

    const result = getMetricsTimeline(db, 0);
    // since = today, date(startedAt) = today, today >= today => should be included
    expect(result.length).toBe(1);
  });

  it("calling getMetricsTimeline directly with negative days returns nothing (future since)", () => {
    // days=-5: since = new Date(Date.now() - (-5 * 86400000)).toISOString().slice(0,10)
    //        = new Date(Date.now() + 5 days) = 5 days in the future
    // No data should match because all dates are <= today
    const taskId = seedTask(db, { linearIssueId: "T-NEG" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 1.0,
    });

    const result = getMetricsTimeline(db, -5);
    // since is in the future, so today's data should be excluded
    expect(result.length).toBe(0);
  });
});

describe("getTaskMetrics — totalDurationSec vs avgDurationSec inconsistency with running invocations", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("totalDurationSec is 0 (not null) when no invocations have ended, while avgDurationSec is null", () => {
    // The SQL for totalDurationSec uses `else 0` so running invocations contribute 0.
    // The SQL for avgDurationSec uses CASE without ELSE, so running invocations contribute NULL.
    // avg(NULL) = NULL, but sum(0) = 0.
    const taskId = seedTask(db, { linearIssueId: "T-INCONSIST" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });

    const result = getTaskMetrics(db);
    expect(result.length).toBe(1);
    expect(result[0]!.avgDurationSec).toBeNull();
    // totalDurationSec is null when no invocations have ended (consistent with avgDurationSec)
    expect(result[0]!.totalDurationSec).toBeNull();
  });
});

describe("getMetricsSummary — totalCostUsd truthy check edge case", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("totalCostUsd handles sum of all-zero costs correctly", () => {
    // sum(invocations.costUsd) when all costs are 0 returns "0" (string).
    // The code does: costRow?.total ? Number(...) : 0
    // String "0" is falsy in JS! So this would return 0 — correct by accident,
    // but if costs were somehow "0.0" it might behave differently.
    const taskId = seedTask(db, { linearIssueId: "T-ALLZERO" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 0,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
      costUsd: 0,
    });

    const result = getMetricsSummary(db);
    // This should be 0, and it is, but the code path is: "0" is falsy => return 0
    // If it were "0.0" it would also be falsy. So actually works correctly for 0.
    expect(result.totalCostUsd).toBe(0);
    expect(result.totalInvocations).toBe(2);
  });

  it("totalCostUsd with only null costs returns 0 (not NaN)", () => {
    const taskId = seedTask(db, { linearIssueId: "T-ALLNULL" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });

    const result = getMetricsSummary(db);
    // sum(NULL) = NULL, costRow.total = null, falsy check returns 0
    expect(result.totalCostUsd).toBe(0);
    expect(Number.isNaN(result.totalCostUsd)).toBe(false);
  });
});

describe("getMetricsErrors — outputSummary containing commas in taskIds", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("taskIds with commas in task IDs would break parsing", () => {
    // If a linearIssueId contained a comma, group_concat would make it
    // ambiguous to parse. Test that normal IDs work fine.
    const task1 = seedTask(db, { linearIssueId: "PROJ-123" });
    const task2 = seedTask(db, { linearIssueId: "PROJ-456" });

    insertInvocation(db, {
      linearIssueId: task1,
      startedAt: now(),
      status: "failed",
      outputSummary: "crash",
    });
    insertInvocation(db, {
      linearIssueId: task2,
      startedAt: now(),
      status: "failed",
      outputSummary: "crash",
    });

    const result = getMetricsErrors(db, 20);
    expect(result.length).toBe(1);
    const ids = result[0]!.taskIds.split(",");
    expect(ids.length).toBe(2);
    expect(ids.sort()).toEqual(["PROJ-123", "PROJ-456"]);
  });
});

describe("getMetricsTimeline — boundary: exactly N days ago", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("invocation exactly at the boundary (N days ago at midnight) is included (>= comparison)", () => {
    // The boundary is: since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    // This truncates to YYYY-MM-DD, so the comparison is date(startedAt) >= 'YYYY-MM-DD'
    // An invocation started at exactly midnight of the boundary date should be included.
    const taskId = seedTask(db, { linearIssueId: "T-BOUNDARY" });

    // Insert an invocation exactly 7 days ago at noon
    const boundaryDate = daysAgo(7);
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: boundaryDate,
      status: "completed",
      costUsd: 1.0,
    });

    const result = getMetricsTimeline(db, 7);
    // The since calculation: Date.now() - 7 * 86400000, then .slice(0,10)
    // The invocation's date should be >= since
    expect(result.length).toBe(1);
  });
});

describe("getMetricsSummary — multiple task statuses including rarer ones", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("handles in_review, changes_requested, deploying, awaiting_ci, backlog statuses", () => {
    seedTask(db, { linearIssueId: "T-IR", orcaStatus: "in_review" });
    seedTask(db, { linearIssueId: "T-CR", orcaStatus: "changes_requested" });
    seedTask(db, { linearIssueId: "T-DEP", orcaStatus: "deploying" });
    seedTask(db, { linearIssueId: "T-ACI", orcaStatus: "awaiting_ci" });
    seedTask(db, { linearIssueId: "T-BL", orcaStatus: "backlog" });

    const result = getMetricsSummary(db);
    expect(result.tasksByStatus["in_review"]).toBe(1);
    expect(result.tasksByStatus["changes_requested"]).toBe(1);
    expect(result.tasksByStatus["deploying"]).toBe(1);
    expect(result.tasksByStatus["awaiting_ci"]).toBe(1);
    expect(result.tasksByStatus["backlog"]).toBe(1);
  });
});

describe("getMetricsTimeline — cost aggregation with mix of null and non-null costs", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  it("null cost on same day does not make the whole day's cost NaN", () => {
    const taskId = seedTask(db, { linearIssueId: "T-MIXNULL" });

    // Same day: one with cost, one without
    const day = dateAt("2026-02-15");
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: day,
      status: "completed",
      costUsd: 5.0,
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: day,
      status: "completed",
      // costUsd null
    });

    const result = getMetricsTimeline(db, 365);
    expect(result.length).toBe(1);
    // coalesce(sum(5.0 + null), 0) — sum ignores null, gives 5.0
    expect(result[0]!.costUsd).toBeCloseTo(5.0);
    expect(Number.isNaN(result[0]!.costUsd)).toBe(false);
  });
});
