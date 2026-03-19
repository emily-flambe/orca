// ---------------------------------------------------------------------------
// EMI-332: DB query tests for countZeroCostFailuresSince
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertSystemEvent,
  countZeroCostFailuresSince,
  countSystemEventsSince,
} from "../src/db/queries.js";

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function msFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("countZeroCostFailuresSince", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns 0 when no zero_cost_failure events exist", () => {
    const since = msAgo(10 * 60 * 1000);
    expect(countZeroCostFailuresSince(db, since)).toBe(0);
  });

  test("counts zero_cost_failure events within the window", () => {
    const since = msAgo(10 * 60 * 1000);

    // Insert 3 zero_cost_failure events
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "Zero-cost failure 1",
    });
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "Zero-cost failure 2",
    });
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "Zero-cost failure 3",
    });

    expect(countZeroCostFailuresSince(db, since)).toBe(3);
  });

  test("excludes zero_cost_failure events before the window", () => {
    // Insert event with a past timestamp BEFORE the window
    // We can't directly control createdAt via insertSystemEvent (it uses new Date()),
    // but we can use the raw DB to insert with a past timestamp
    const db2 = freshDb();
    db2.run(`
      INSERT INTO system_events (type, message, created_at)
      VALUES ('zero_cost_failure', 'old event', '2020-01-01T00:00:00.000Z')
    `);

    const since = msAgo(10 * 60 * 1000); // 10 minutes ago
    expect(countZeroCostFailuresSince(db2, since)).toBe(0);
  });

  test("does NOT count other event types (error, task_failed, etc)", () => {
    const since = msAgo(10 * 60 * 1000);

    insertSystemEvent(db, { type: "error", message: "some error" });
    insertSystemEvent(db, { type: "task_failed", message: "task failed" });
    insertSystemEvent(db, { type: "self_heal", message: "healed" });

    expect(countZeroCostFailuresSince(db, since)).toBe(0);
  });

  test("mixed events: counts only zero_cost_failure type", () => {
    const since = msAgo(10 * 60 * 1000);

    insertSystemEvent(db, { type: "error", message: "error 1" });
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "zero cost 1",
    });
    insertSystemEvent(db, { type: "task_failed", message: "failure" });
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "zero cost 2",
    });

    expect(countZeroCostFailuresSince(db, since)).toBe(2);
  });

  test("delegates to countSystemEventsSince with zero_cost_failure type", () => {
    // Verify that countZeroCostFailuresSince is equivalent to
    // countSystemEventsSince(db, since, "zero_cost_failure")
    const since = msAgo(10 * 60 * 1000);

    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "test event",
    });

    expect(countZeroCostFailuresSince(db, since)).toBe(
      countSystemEventsSince(db, since, "zero_cost_failure"),
    );
  });

  test("circuit breaker window: counts within 10 min window only", () => {
    // Simulate the actual circuit breaker usage: count events in last 10 min
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    // Recent events (within window) - should be counted
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "recent failure 1",
    });
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "recent failure 2",
    });

    // Old event (outside window) - should NOT be counted
    const db2 = createDb(":memory:");
    db2.run(`
      INSERT INTO system_events (type, message, created_at)
      VALUES ('zero_cost_failure', 'old failure', '2020-01-01T00:00:00.000Z')
    `);
    // Add the same recent failures to db2
    insertSystemEvent(db2, {
      type: "zero_cost_failure",
      message: "recent failure 1",
    });
    insertSystemEvent(db2, {
      type: "zero_cost_failure",
      message: "recent failure 2",
    });

    expect(countZeroCostFailuresSince(db, tenMinutesAgo)).toBe(2);
    expect(countZeroCostFailuresSince(db2, tenMinutesAgo)).toBe(2); // not 3
  });

  test("future since timestamp returns 0 (no future events)", () => {
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "some failure",
    });

    const future = msFromNow(60 * 1000);
    expect(countZeroCostFailuresSince(db, future)).toBe(0);
  });

  test("zero_cost_failure type is valid in schema (can be inserted)", () => {
    // Verify the schema accepts zero_cost_failure - would throw if not
    expect(() => {
      insertSystemEvent(db, {
        type: "zero_cost_failure",
        message: "test",
        metadata: { taskId: "TEST-1", invocationId: 1, exitCode: 1 },
      });
    }).not.toThrow();
  });

  test("metadata is stored as JSON string and accessible", () => {
    insertSystemEvent(db, {
      type: "zero_cost_failure",
      message: "test with metadata",
      metadata: { taskId: "TEST-1", invocationId: 42, exitCode: 1 },
    });

    const since = msAgo(60 * 1000);
    expect(countZeroCostFailuresSince(db, since)).toBe(1);

    // Verify metadata is properly JSON-stringified
    const row = db.get<{ metadata: string }>(
      `SELECT metadata FROM system_events WHERE type = 'zero_cost_failure' LIMIT 1`,
    );
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.metadata);
    expect(parsed).toEqual({ taskId: "TEST-1", invocationId: 42, exitCode: 1 });
  });
});
