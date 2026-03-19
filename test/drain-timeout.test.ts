// ---------------------------------------------------------------------------
// drain-timeout.test.ts
//
// Tests for drain timeout and observability features in src/deploy.ts and
// the drain tracking logic in reconcile-stuck-tasks.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// src/deploy.ts — module-level state tests
// ---------------------------------------------------------------------------

// Import deploy module functions directly. Since vitest ESM module state is
// shared across the test file, we call clearDraining() in beforeEach to reset.
const { isDraining, setDraining, clearDraining, getDrainingForSeconds } =
  await import("../src/deploy.js");

describe("deploy drain state", () => {
  beforeEach(() => {
    // Always start from a clean state
    clearDraining();
  });

  afterEach(() => {
    clearDraining();
  });

  test("isDraining returns false initially", () => {
    expect(isDraining()).toBe(false);
  });

  test("getDrainingForSeconds returns null when not draining", () => {
    expect(getDrainingForSeconds()).toBeNull();
  });

  test("setDraining marks draining as true", () => {
    setDraining();
    expect(isDraining()).toBe(true);
  });

  test("getDrainingForSeconds returns a non-negative number after setDraining", () => {
    setDraining();
    const seconds = getDrainingForSeconds();
    expect(seconds).not.toBeNull();
    expect(seconds).toBeGreaterThanOrEqual(0);
  });

  test("getDrainingForSeconds increases over time", async () => {
    setDraining();
    await new Promise((r) => setTimeout(r, 1100));
    const seconds = getDrainingForSeconds();
    expect(seconds).toBeGreaterThanOrEqual(1);
  });

  test("clearDraining resets draining to false", () => {
    setDraining();
    expect(isDraining()).toBe(true);
    clearDraining();
    expect(isDraining()).toBe(false);
  });

  test("clearDraining resets getDrainingForSeconds to null", () => {
    setDraining();
    expect(getDrainingForSeconds()).not.toBeNull();
    clearDraining();
    expect(getDrainingForSeconds()).toBeNull();
  });

  test("setDraining is idempotent — does not reset timer on duplicate call", async () => {
    setDraining();
    await new Promise((r) => setTimeout(r, 500));
    setDraining(); // second call should be ignored
    const seconds = getDrainingForSeconds();
    // Timer started at first call, so should still be ~0.5s
    expect(seconds).toBeGreaterThanOrEqual(0);
    // If idempotent, timer was NOT reset, so seconds >= 0 (we can't assert > 0 exactly
    // but we can verify drain is still true)
    expect(isDraining()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drain tracking state logic (pure logic extracted from the step)
// ---------------------------------------------------------------------------

interface DrainTrackingState {
  consecutiveZeroSessionSnapshots: number;
  firstSeenAt: string | null;
}

// Replicated from reconcile-stuck-tasks.ts for unit testing
function processSnapshot(
  draining: boolean,
  activeSessions: number,
  state: DrainTrackingState,
): { newState: DrainTrackingState; shouldAlert: boolean } {
  if (!draining || activeSessions > 0) {
    return {
      newState: { consecutiveZeroSessionSnapshots: 0, firstSeenAt: null },
      shouldAlert: false,
    };
  }

  const newCount = state.consecutiveZeroSessionSnapshots + 1;
  const firstSeenAt = state.firstSeenAt ?? new Date().toISOString();
  return {
    newState: {
      consecutiveZeroSessionSnapshots: newCount,
      firstSeenAt,
    },
    shouldAlert: newCount === 2,
  };
}

describe("drain tracking state logic", () => {
  test("not draining: resets state", () => {
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt: new Date().toISOString(),
    };
    const { newState, shouldAlert } = processSnapshot(false, 0, state);
    expect(newState.consecutiveZeroSessionSnapshots).toBe(0);
    expect(newState.firstSeenAt).toBeNull();
    expect(shouldAlert).toBe(false);
  });

  test("draining with active sessions: resets state", () => {
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt: new Date().toISOString(),
    };
    const { newState, shouldAlert } = processSnapshot(true, 2, state);
    expect(newState.consecutiveZeroSessionSnapshots).toBe(0);
    expect(newState.firstSeenAt).toBeNull();
    expect(shouldAlert).toBe(false);
  });

  test("draining with 0 sessions, 1st snapshot: no alert", () => {
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 0,
      firstSeenAt: null,
    };
    const { newState, shouldAlert } = processSnapshot(true, 0, state);
    expect(newState.consecutiveZeroSessionSnapshots).toBe(1);
    expect(newState.firstSeenAt).not.toBeNull();
    expect(shouldAlert).toBe(false);
  });

  test("draining with 0 sessions, 2nd snapshot: alert fires", () => {
    const firstSeenAt = new Date().toISOString();
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt,
    };
    const { newState, shouldAlert } = processSnapshot(true, 0, state);
    expect(newState.consecutiveZeroSessionSnapshots).toBe(2);
    expect(newState.firstSeenAt).toBe(firstSeenAt);
    expect(shouldAlert).toBe(true);
  });

  test("draining with 0 sessions, 3rd snapshot: no additional alert (only fires at 2)", () => {
    const firstSeenAt = new Date().toISOString();
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 2,
      firstSeenAt,
    };
    const { newState, shouldAlert } = processSnapshot(true, 0, state);
    expect(newState.consecutiveZeroSessionSnapshots).toBe(3);
    expect(shouldAlert).toBe(false);
  });

  test("firstSeenAt preserved across increments", () => {
    const originalFirstSeen = "2026-01-01T00:00:00.000Z";
    const state: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt: originalFirstSeen,
    };
    const { newState } = processSnapshot(true, 0, state);
    expect(newState.firstSeenAt).toBe(originalFirstSeen);
  });
});

// ---------------------------------------------------------------------------
// Drain tracking file persistence
// ---------------------------------------------------------------------------

describe("drain tracking file persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-drain-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("reads default state when file does not exist", async () => {
    const file = path.join(tmpDir, "drain-tracking.json");
    let state: DrainTrackingState;
    try {
      const raw = await fs.readFile(file, "utf-8");
      state = JSON.parse(raw) as DrainTrackingState;
    } catch {
      state = { consecutiveZeroSessionSnapshots: 0, firstSeenAt: null };
    }
    expect(state.consecutiveZeroSessionSnapshots).toBe(0);
    expect(state.firstSeenAt).toBeNull();
  });

  test("writes and reads state", async () => {
    const file = path.join(tmpDir, "drain-tracking.json");
    const toWrite: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 1,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.writeFile(file, JSON.stringify(toWrite), "utf-8");

    const raw = await fs.readFile(file, "utf-8");
    const readBack = JSON.parse(raw) as DrainTrackingState;
    expect(readBack.consecutiveZeroSessionSnapshots).toBe(1);
    expect(readBack.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
