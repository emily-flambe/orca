import { describe, test, expect } from "vitest";
// @ts-expect-error -- .mjs script has no type declarations
import {
  formatDuration,
  defaultState,
  processCheckResult,
} from "../scripts/monitor-snapshot-logic.mjs";

const T0 = "2026-03-10T04:16:12Z";
const T1 = "2026-03-10T04:31:12Z"; // 15m after T0
const T2 = "2026-03-10T04:32:21Z"; // 16m 9s after T0

describe("formatDuration", () => {
  test("seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  test("minutes and seconds", () => {
    expect(formatDuration(969)).toBe("16m 9s");
  });

  test("exact minute", () => {
    expect(formatDuration(60)).toBe("1m 0s");
  });

  test("hours, minutes, seconds", () => {
    expect(formatDuration(3930)).toBe("1h 5m 30s");
  });

  test("exact hour", () => {
    expect(formatDuration(3600)).toBe("1h 0m 0s");
  });

  test("zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("processCheckResult", () => {
  test("first DOWN: count=1, no alert", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T0,
    );
    expect(result.snapshot.status).toBe("DOWN");
    expect(result.snapshot.consecutiveDownCount).toBe(1);
    expect(result.snapshot.error).toBe("ECONNREFUSED");
    expect(result.newState.consecutiveDownCount).toBe(1);
    expect(result.newState.lastStatus).toBe("DOWN");
    expect(result.newState.downtimeStartedAt).toBe(T0);
    expect(result.alert).toBeNull();
  });

  test("second DOWN: count=2, alert fires", () => {
    const prev = {
      lastKnownPort: 4000,
      consecutiveDownCount: 1,
      downtimeStartedAt: T0,
      lastStatus: "DOWN",
    };
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T1,
    );
    expect(result.snapshot.consecutiveDownCount).toBe(2);
    expect(result.alert).not.toBeNull();
    expect(result.alert.type).toBe("downtime_alert");
    expect(result.alert.consecutiveDownCount).toBe(2);
    expect(result.alert.downtimeStartedAt).toBe(T0);
  });

  test("third DOWN: count=3, alert fires again", () => {
    const prev = {
      lastKnownPort: 4001,
      consecutiveDownCount: 2,
      downtimeStartedAt: T0,
      lastStatus: "DOWN",
    };
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ETIMEDOUT" },
      T1,
    );
    expect(result.snapshot.consecutiveDownCount).toBe(3);
    expect(result.alert).not.toBeNull();
    expect(result.alert.type).toBe("downtime_alert");
    expect(result.alert.consecutiveDownCount).toBe(3);
  });

  test("UP after DOWN: recovery alert with correct duration", () => {
    const prev = {
      lastKnownPort: 4001,
      consecutiveDownCount: 2,
      downtimeStartedAt: T0,
      lastStatus: "DOWN",
    };
    const result = processCheckResult(
      prev,
      { up: true, port: 4001, error: null },
      T2,
    );
    expect(result.snapshot.status).toBe("UP");
    expect(result.snapshot.recoveredFromDowntime).toBe(true);
    expect(result.snapshot.downtimeDuration).toBe("16m 9s");
    expect(result.snapshot.downtimeStartedAt).toBe(T0);
    expect(result.newState.consecutiveDownCount).toBe(0);
    expect(result.newState.lastStatus).toBe("UP");
    expect(result.alert).not.toBeNull();
    expect(result.alert.type).toBe("recovery");
    expect(result.alert.downtimeDuration).toBe("16m 9s");
  });

  test("UP after UP: no alert, normal snapshot", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T0,
    );
    expect(result.snapshot.status).toBe("UP");
    expect(result.snapshot.recoveredFromDowntime).toBeUndefined();
    expect(result.alert).toBeNull();
    expect(result.newState.consecutiveDownCount).toBe(0);
    expect(result.newState.lastStatus).toBe("UP");
  });

  test("DOWN preserves original downtimeStartedAt", () => {
    const prev = {
      lastKnownPort: 4000,
      consecutiveDownCount: 3,
      downtimeStartedAt: T0,
      lastStatus: "DOWN",
    };
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T1,
    );
    expect(result.newState.downtimeStartedAt).toBe(T0);
  });

  test("HTTP_503 treated as DOWN", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "HTTP_503" },
      T0,
    );
    expect(result.snapshot.status).toBe("DOWN");
    expect(result.snapshot.error).toBe("HTTP_503");
  });
});

// ─── Budget / burn-rate tests ────────────────────────────────────────────────

// Helpers
const T_BASE = "2026-03-10T10:00:00Z";
const T_PLUS_1H = "2026-03-10T11:00:00Z"; // exactly 1 hour later
const T_PLUS_2H = "2026-03-10T12:00:00Z"; // exactly 2 hours later

function stateWithBudget(
  prevBudgetUsed: number,
  prevSnapshotTs: string,
): ReturnType<typeof defaultState> & {
  prevBudgetUsed: number;
  prevSnapshotTs: string;
} {
  return {
    ...defaultState(),
    lastStatus: "UP",
    prevBudgetUsed,
    prevSnapshotTs,
  };
}

describe("processCheckResult — budget burn rate", () => {
  // ── always present ──────────────────────────────────────────────────────────

  test("budgetAlerts always present in UP path (no budgetData)", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_BASE,
    );
    expect(result).toHaveProperty("budgetAlerts");
    expect(Array.isArray(result.budgetAlerts)).toBe(true);
  });

  test("budgetAlerts always present in DOWN path", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T_BASE,
    );
    expect(result).toHaveProperty("budgetAlerts");
    expect(Array.isArray(result.budgetAlerts)).toBe(true);
  });

  // ── first snapshot (no prev data) ───────────────────────────────────────────

  test("first snapshot with budgetData: no burn rate computable, no burn-rate alert", () => {
    // prevBudgetUsed is null → can't compute delta
    const prev = defaultState(); // prevBudgetUsed: null
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_BASE,
      { used: 10, limit: 100 },
    );
    expect(result.snapshot.budget.burnRatePerHour).toBeNull();
    expect(
      result.budgetAlerts.filter(
        (a: { type: string }) => a.type === "budget_burn_rate_high",
      ),
    ).toHaveLength(0);
    // State must be seeded for next call
    expect(result.newState.prevBudgetUsed).toBe(10);
    expect(result.newState.prevSnapshotTs).toBe(T_BASE);
  });

  // ── burn rate math ───────────────────────────────────────────────────────────

  test("burn rate: $10 over 1 hour = $10/hr", () => {
    const prev = stateWithBudget(10, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 20, limit: 100 },
    );
    expect(result.snapshot.budget.burnRatePerHour).toBeCloseTo(10, 6);
  });

  test("burn rate: $5 over 2 hours = $2.50/hr", () => {
    const prev = stateWithBudget(15, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_2H,
      { used: 20, limit: 100 },
    );
    expect(result.snapshot.budget.burnRatePerHour).toBeCloseTo(2.5, 6);
  });

  test("burn rate zero: no spend since last snapshot → burnRatePerHour is 0 not null", () => {
    const prev = stateWithBudget(20, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 20, limit: 100 },
    );
    // When there is no spend, burn rate is 0 — not null
    expect(result.snapshot.budget.burnRatePerHour).toBe(0);
  });

  // ── projectedCapHitAt ────────────────────────────────────────────────────────

  test("projectedCapHitAt is in the future when limit not yet reached", () => {
    // $10/hr burn rate, $80 remaining → 8 hours from T_PLUS_1H
    const prev = stateWithBudget(10, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 20, limit: 100 },
    );
    const projected = new Date(
      result.snapshot.budget.projectedCapHitAt,
    ).getTime();
    const now = new Date(T_PLUS_1H).getTime();
    expect(projected).toBeGreaterThan(now);
  });

  test("projectedCapHitAt when budget already exceeded is NOT a past timestamp", () => {
    // BUG: used (110) > limit (100) → (limit - used) is negative → past timestamp
    // The implementation currently returns a past timestamp, which is misleading.
    // A correct implementation should indicate the cap is already exceeded (e.g. null or a
    // sentinel), not return a timestamp in the past.
    const prev = stateWithBudget(90, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 110, limit: 100 },
    );
    const projected = result.snapshot.budget.projectedCapHitAt;
    const now = new Date(T_PLUS_1H).getTime();
    // projectedCapHitAt should be null or in the future — not a past timestamp
    if (projected !== null) {
      expect(new Date(projected).getTime()).toBeGreaterThanOrEqual(now);
    }
  });

  test("projectedCapHitAt when limit=0 is null (not a past timestamp)", () => {
    // BUG: limit=0, used=5 → (0 - 5) / burnRate * 3600000 → large negative → past timestamp
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 5, limit: 0 },
    );
    // With limit=0, projectedCapHitAt cannot be meaningful — should be null
    expect(result.snapshot.budget.projectedCapHitAt).toBeNull();
  });

  // ── burn-rate alert thresholds ───────────────────────────────────────────────

  test("burn-rate alert fires when rate exceeds default threshold of $20/hr", () => {
    // $25 in 1 hour = $25/hr > $20 threshold
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 25, limit: 100 },
    );
    const burnAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_burn_rate_high",
    );
    expect(burnAlerts).toHaveLength(1);
    expect(burnAlerts[0].burnRatePerHour).toBeCloseTo(25, 6);
  });

  test("burn-rate alert does NOT fire when rate is below threshold", () => {
    // $15 in 1 hour = $15/hr < $20 threshold
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 15, limit: 100 },
    );
    const burnAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_burn_rate_high",
    );
    expect(burnAlerts).toHaveLength(0);
  });

  test("burn-rate alert does NOT fire at exactly the threshold (strictly greater)", () => {
    // $20 in 1 hour = $20/hr == $20 threshold → should NOT alert (strictly >)
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 20, limit: 100 },
    );
    const burnAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_burn_rate_high",
    );
    expect(burnAlerts).toHaveLength(0);
  });

  test("burn-rate alert respects custom threshold", () => {
    // $15/hr with threshold=10 → should alert
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 15, limit: 100 },
      { burnRateAlertThreshold: 10 },
    );
    const burnAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_burn_rate_high",
    );
    expect(burnAlerts).toHaveLength(1);
  });

  // ── 70% consumed alert ───────────────────────────────────────────────────────

  test("70% alert fires when used > 70% of limit", () => {
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 75, limit: 100 },
    );
    const windowAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_window_high",
    );
    expect(windowAlerts).toHaveLength(1);
    expect(windowAlerts[0].pct).toBe(75);
  });

  test("70% alert does NOT fire when used is below 70%", () => {
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 69, limit: 100 },
    );
    const windowAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_window_high",
    );
    expect(windowAlerts).toHaveLength(0);
  });

  test("70% alert does NOT fire at exactly 70% consumed (threshold is strictly >70%)", () => {
    // The spec says ">70% consumed" — exactly 70% does NOT trigger the alert
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 70, limit: 100 },
    );
    const windowAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_window_high",
    );
    expect(windowAlerts).toHaveLength(0);
  });

  test("70% alert does NOT fire when limit is 0 (no division by zero)", () => {
    const prev = stateWithBudget(0, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 10, limit: 0 },
    );
    const windowAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_window_high",
    );
    expect(windowAlerts).toHaveLength(0);
  });

  // ── window reset (used drops) ────────────────────────────────────────────────

  test("window reset: used drops below prevBudgetUsed → no burn rate, no alert, state updated", () => {
    // Simulates budget window rolling over: previous used=80, now used=5
    const prev = stateWithBudget(80, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      { used: 5, limit: 100 },
    );
    expect(result.snapshot.budget.burnRatePerHour).toBeNull();
    expect(result.snapshot.budget.projectedCapHitAt).toBeNull();
    // New base must be set to current used so next interval computes correctly
    expect(result.newState.prevBudgetUsed).toBe(5);
    expect(result.newState.prevSnapshotTs).toBe(T_PLUS_1H);
  });

  // ── DOWN path budget state preservation ─────────────────────────────────────

  test("DOWN preserves prevBudgetUsed and prevSnapshotTs from previous state", () => {
    const prev = stateWithBudget(42, T_BASE);
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T_PLUS_1H,
    );
    expect(result.newState.prevBudgetUsed).toBe(42);
    expect(result.newState.prevSnapshotTs).toBe(T_BASE);
  });

  test("DOWN path returns empty budgetAlerts (not undefined)", () => {
    const prev = stateWithBudget(90, T_BASE);
    const result = processCheckResult(
      prev,
      { up: false, port: null, error: "ECONNREFUSED" },
      T_PLUS_1H,
    );
    expect(result.budgetAlerts).toEqual([]);
  });

  // ── stale prevSnapshotTs after UP-without-budgetData ────────────────────────

  test("UP without budgetData does NOT update prevSnapshotTs, causing inflated burn rate next call", () => {
    // After 1 hour without budget data, prevSnapshotTs stays at T_BASE.
    // Next call 2h after T_BASE with $20 spent appears as $10/hr instead of $20/hr.
    // This tests that the time base is NOT silently advanced to create a misleading low burn rate.
    const prev = stateWithBudget(0, T_BASE);

    // Simulate UP without budget data (e.g. health endpoint temporarily unavailable)
    const midResult = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_PLUS_1H,
      null, // no budget data
    );
    // prevSnapshotTs must NOT advance — we have no new budget data point
    expect(midResult.newState.prevSnapshotTs).toBe(T_BASE);
    expect(midResult.newState.prevBudgetUsed).toBe(0);

    // Now T_PLUS_2H call with $20 used: delta is vs T_BASE (2hr) → $10/hr
    const finalResult = processCheckResult(
      midResult.newState,
      { up: true, port: 4000, error: null },
      T_PLUS_2H,
      { used: 20, limit: 100 },
    );
    // Burn rate should be 20/2 = $10/hr, NOT 20/1 = $20/hr
    expect(finalResult.snapshot.budget.burnRatePerHour).toBeCloseTo(10, 6);
  });

  // ── zero time delta ──────────────────────────────────────────────────────────

  test("zero time delta (same timestamp as prevSnapshotTs) produces null burn rate", () => {
    // timeDeltaHours = 0 → the condition timeDeltaHours > 0 prevents division by zero
    const prev = stateWithBudget(10, T_BASE);
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_BASE, // same timestamp
      { used: 15, limit: 100 },
    );
    expect(result.snapshot.budget.burnRatePerHour).toBeNull();
    expect(result.snapshot.budget.projectedCapHitAt).toBeNull();
  });

  // ── alert message format ─────────────────────────────────────────────────────

  test("window alert message contains used and limit", () => {
    const prev = defaultState();
    const result = processCheckResult(
      prev,
      { up: true, port: 4000, error: null },
      T_BASE,
      { used: 80.5, limit: 100 },
    );
    const windowAlerts = result.budgetAlerts.filter(
      (a: { type: string }) => a.type === "budget_window_high",
    );
    expect(windowAlerts).toHaveLength(1);
    expect(windowAlerts[0].message).toContain("$80.50");
    expect(windowAlerts[0].message).toContain("$100.00");
  });
});
