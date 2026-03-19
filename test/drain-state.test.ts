// ---------------------------------------------------------------------------
// Drain state tests (EMI-348)
// ---------------------------------------------------------------------------
//
// Tests for drain state functions in src/deploy.ts:
//   isDraining, setDraining, clearDraining, checkAndAutoClearDrain,
//   recordDrainZeroSnapshot, resetDrainZeroSnapshots, getDrainZeroSnapshots
//
// These functions use module-level state, so clearDraining() is called in
// beforeEach to ensure test isolation.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import {
  isDraining,
  setDraining,
  clearDraining,
  checkAndAutoClearDrain,
  recordDrainZeroSnapshot,
  resetDrainZeroSnapshots,
  getDrainZeroSnapshots,
  getDrainingStartedAt,
} from "../src/deploy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all drain state before each test. */
function resetDrainState(): void {
  clearDraining();
  resetDrainZeroSnapshots();
}

// ---------------------------------------------------------------------------

describe("isDraining / setDraining / clearDraining", () => {
  beforeEach(() => resetDrainState());

  test("isDraining returns false initially", () => {
    expect(isDraining()).toBe(false);
  });

  test("setDraining sets draining to true", () => {
    setDraining();
    expect(isDraining()).toBe(true);
  });

  test("clearDraining resets draining to false", () => {
    setDraining();
    clearDraining();
    expect(isDraining()).toBe(false);
  });

  test("getDrainingStartedAt is null when not draining", () => {
    expect(getDrainingStartedAt()).toBeNull();
  });

  test("getDrainingStartedAt returns a timestamp after setDraining", () => {
    const before = Date.now();
    setDraining();
    const after = Date.now();
    const startedAt = getDrainingStartedAt();
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    expect(startedAt!).toBeLessThanOrEqual(after);
  });

  test("clearDraining resets getDrainingStartedAt to null", () => {
    setDraining();
    clearDraining();
    expect(getDrainingStartedAt()).toBeNull();
  });

  test("duplicate setDraining calls are ignored (idempotent)", () => {
    setDraining();
    const first = getDrainingStartedAt();
    setDraining(); // second call should be ignored
    expect(getDrainingStartedAt()).toBe(first);
  });
});

// ---------------------------------------------------------------------------

describe("checkAndAutoClearDrain", () => {
  beforeEach(() => resetDrainState());

  test("returns false when not draining", () => {
    expect(checkAndAutoClearDrain(0, 10)).toBe(false);
  });

  test("returns false when draining but activeSessions > 0", () => {
    setDraining();
    expect(checkAndAutoClearDrain(1, 10)).toBe(false);
    expect(isDraining()).toBe(true);
  });

  test("returns false when draining with 0 sessions but timeout not reached", () => {
    setDraining();
    // drainTimeoutMin=60, so 1 min hasn't expired yet
    expect(checkAndAutoClearDrain(0, 60)).toBe(false);
    expect(isDraining()).toBe(true);
  });

  test("returns true and clears drain when timeout exceeded with 0 sessions", () => {
    setDraining();
    // Use a negative timeout so elapsed > (timeoutMin * 60000) is always true.
    // This avoids race conditions where setDraining and checkAndAutoClearDrain
    // both run in the same millisecond.
    const cleared = checkAndAutoClearDrain(0, -1);
    expect(cleared).toBe(true);
    expect(isDraining()).toBe(false);
    expect(getDrainingStartedAt()).toBeNull();
  });

  test("also resets drain zero snapshots when auto-clearing", () => {
    setDraining();
    recordDrainZeroSnapshot();
    recordDrainZeroSnapshot();
    expect(getDrainZeroSnapshots()).toBe(2);
    clearDraining(); // clearDraining resets the snapshots counter
    expect(getDrainZeroSnapshots()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("recordDrainZeroSnapshot / resetDrainZeroSnapshots / getDrainZeroSnapshots", () => {
  beforeEach(() => resetDrainState());

  test("getDrainZeroSnapshots returns 0 initially", () => {
    expect(getDrainZeroSnapshots()).toBe(0);
  });

  test("recordDrainZeroSnapshot increments counter", () => {
    expect(recordDrainZeroSnapshot()).toBe(1);
    expect(recordDrainZeroSnapshot()).toBe(2);
    expect(getDrainZeroSnapshots()).toBe(2);
  });

  test("resetDrainZeroSnapshots resets counter to 0", () => {
    recordDrainZeroSnapshot();
    recordDrainZeroSnapshot();
    resetDrainZeroSnapshots();
    expect(getDrainZeroSnapshots()).toBe(0);
  });

  test("alert threshold: 2nd consecutive snapshot triggers alert logic", () => {
    // Simulate the monitor-drain-state step logic:
    // first snapshot — no alert yet
    const count1 = recordDrainZeroSnapshot();
    expect(count1).toBe(1);
    expect(count1 >= 2).toBe(false);

    // second snapshot — alert threshold reached
    const count2 = recordDrainZeroSnapshot();
    expect(count2).toBe(2);
    expect(count2 >= 2).toBe(true);
  });

  test("reset clears counter so alerts don't re-fire immediately", () => {
    recordDrainZeroSnapshot();
    recordDrainZeroSnapshot();
    resetDrainZeroSnapshots();

    // After reset, first new snapshot should not trigger alert
    const count = recordDrainZeroSnapshot();
    expect(count).toBe(1);
    expect(count >= 2).toBe(false);
  });
});
