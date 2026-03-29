// ---------------------------------------------------------------------------
// drain-timeout.test.ts — drain state tracking and auto-clear logic (EMI-348)
// ---------------------------------------------------------------------------
//
// Tests for:
//   1. getDrainingSeconds() — returns null when not draining, seconds when draining
//   2. tickDrainZeroSessions() / resetDrainZeroSessions() — consecutive counter
//   3. Alert threshold logic (sendAlertThrottled at consecutiveCount >= 2)
//   4. Auto-clear logic (clearDraining when timeout exceeded)
//   5. Monitor snapshot includes drainingForSeconds metadata line
//
// Adversarial additions (Part 4+):
//   6. getDrainingForSeconds() — distinct from getDrainingSeconds() (no floor)
//   7. setDraining() idempotency — duplicate call must NOT reset drainingStartedAt
//   8. tickDrainZeroSessions() when not draining — counter increments without guard
//   9. writeMonitorSnapshot with drainingForSeconds=0 — zero is a valid value
//  10. writeMonitorSnapshot with drainingForSeconds=null — must NOT add meta line
//  11. writeMonitorSnapshot with drainingForSeconds=undefined — must NOT add meta line
//  12. trackDrainState() — full behavioral coverage (file-based persistent tracking)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Part 1: deploy.ts state tracking
// Uses resetModules() so each test gets a fresh module instance.
// ---------------------------------------------------------------------------

describe("deploy drain state tracking", () => {
  type DeployModule = typeof import("../src/deploy.js");
  let deploy: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));
    deploy = await import("../src/deploy.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("getDrainingSeconds returns null when not draining", () => {
    expect(deploy.isDraining()).toBe(false);
    expect(deploy.getDrainingSeconds()).toBeNull();
  });

  test("getDrainingSeconds returns a non-negative number after setDraining", () => {
    deploy.setDraining();
    const secs = deploy.getDrainingSeconds();
    expect(secs).not.toBeNull();
    expect(secs).toBeGreaterThanOrEqual(0);
  });

  test("getDrainingSeconds returns null after clearDraining", () => {
    deploy.setDraining();
    expect(deploy.getDrainingSeconds()).not.toBeNull();
    deploy.clearDraining();
    expect(deploy.getDrainingSeconds()).toBeNull();
  });

  test("getDrainingSeconds increases over time with fake timers", () => {
    vi.useFakeTimers();
    deploy.setDraining();
    vi.advanceTimersByTime(65_000); // 65 seconds
    const secs = deploy.getDrainingSeconds();
    expect(secs).toBeGreaterThanOrEqual(65);
  });

  test("tickDrainZeroSessions increments each call", () => {
    deploy.setDraining();
    expect(deploy.tickDrainZeroSessions()).toBe(1);
    expect(deploy.tickDrainZeroSessions()).toBe(2);
    expect(deploy.tickDrainZeroSessions()).toBe(3);
  });

  test("resetDrainZeroSessions resets the counter to 0", () => {
    deploy.setDraining();
    deploy.tickDrainZeroSessions();
    deploy.tickDrainZeroSessions();
    deploy.resetDrainZeroSessions();
    expect(deploy.tickDrainZeroSessions()).toBe(1);
  });

  test("setDraining resets the consecutive counter", () => {
    deploy.setDraining();
    deploy.tickDrainZeroSessions();
    deploy.tickDrainZeroSessions();
    deploy.clearDraining();
    deploy.setDraining();
    expect(deploy.tickDrainZeroSessions()).toBe(1);
  });

  test("clearDraining resets the consecutive counter", () => {
    deploy.setDraining();
    deploy.tickDrainZeroSessions();
    deploy.tickDrainZeroSessions();
    deploy.clearDraining();
    deploy.setDraining();
    expect(deploy.tickDrainZeroSessions()).toBe(1);
  });

  test("second setDraining call after clearDraining starts fresh", () => {
    deploy.setDraining();
    deploy.clearDraining();
    deploy.setDraining(); // second deploy cycle
    expect(deploy.isDraining()).toBe(true);
    expect(deploy.getDrainingSeconds()).not.toBeNull();
    expect(deploy.getDrainingSeconds()!).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Part 2: monitor-snapshot.ts — drainingForSeconds metadata line
// Uses a real fs.writeFile mock to verify snapshot output.
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { writeMonitorSnapshot } from "../src/scheduler/monitor-snapshot.js";
import * as fsPromises from "node:fs/promises";

describe("writeMonitorSnapshot drainingForSeconds metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("no metadata line when meta is undefined", async () => {
    await writeMonitorSnapshot([], "/tmp/test.ndjson");
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    expect(content).toBe("\n");
  });

  test("no metadata line when meta has no drainingForSeconds", async () => {
    await writeMonitorSnapshot([], "/tmp/test.ndjson", {});
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    expect(content).toBe("\n");
  });

  test("metadata line prepended when drainingForSeconds provided", async () => {
    await writeMonitorSnapshot([], "/tmp/test.ndjson", {
      drainingForSeconds: 123,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const meta = JSON.parse(lines[0]!);
    expect(meta._type).toBe("meta");
    expect(meta.drainingForSeconds).toBe(123);
    expect(typeof meta.timestamp).toBe("string");
  });

  test("metadata line comes before task lines", async () => {
    const tasks = [
      {
        linearIssueId: "TEST-1",
        orcaStatus: "ready",
        lifecycleStage: "ready",
        currentPhase: null,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    ];
    await writeMonitorSnapshot(tasks as never, "/tmp/test.ndjson", {
      drainingForSeconds: 45,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    const content = writeFile.mock.calls[0]![1] as string;
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const firstLine = JSON.parse(lines[0]!);
    expect(firstLine._type).toBe("meta");
    expect(firstLine.drainingForSeconds).toBe(45);
    const secondLine = JSON.parse(lines[1]!);
    expect(secondLine.id).toBe("TEST-1");
  });
});

// ---------------------------------------------------------------------------
// Part 3: drain alert threshold + auto-clear contract tests
// Tests the logical conditions (not the full reconciler step) to ensure
// the alert and auto-clear branch conditions are correct.
// ---------------------------------------------------------------------------

import {
  isDraining,
  setDraining,
  clearDraining,
  getDrainingSeconds,
  tickDrainZeroSessions,
  resetDrainZeroSessions,
} from "../src/deploy.js";

// Utility to reset drain state between tests that share the module-level singleton
function resetDrain() {
  if (isDraining()) clearDraining();
  resetDrainZeroSessions();
}

describe("drain auto-clear timeout contract", () => {
  afterEach(() => {
    resetDrain();
    vi.useRealTimers();
  });

  test("drain timeout condition: draining >= timeout seconds auto-clears", () => {
    vi.useFakeTimers();
    setDraining();

    const drainTimeoutMin = 10;
    vi.advanceTimersByTime((drainTimeoutMin * 60 + 5) * 1000); // 10m 5s

    const secs = getDrainingSeconds()!;
    expect(secs).toBeGreaterThanOrEqual(drainTimeoutMin * 60);

    // Simulate auto-clear logic
    if (secs >= drainTimeoutMin * 60) {
      clearDraining();
    }

    expect(isDraining()).toBe(false);
    expect(getDrainingSeconds()).toBeNull();
  });

  test("drain timeout condition: before timeout, drain flag stays set", () => {
    vi.useFakeTimers();
    setDraining();

    const drainTimeoutMin = 10;
    vi.advanceTimersByTime((drainTimeoutMin * 60 - 10) * 1000); // 9m 50s

    const secs = getDrainingSeconds()!;
    expect(secs).toBeLessThan(drainTimeoutMin * 60);

    // Simulate check — should NOT auto-clear
    if (secs >= drainTimeoutMin * 60) {
      clearDraining();
    }

    expect(isDraining()).toBe(true);
  });
});

describe("drain consecutive tick alert threshold", () => {
  afterEach(() => {
    resetDrain();
  });

  test("first tick (consecutiveCount=1): below alert threshold of 2", () => {
    setDraining();
    const count = tickDrainZeroSessions();
    expect(count).toBe(1);
    // Alert should NOT fire at count < 2
    expect(count >= 2).toBe(false);
  });

  test("second tick (consecutiveCount=2): meets alert threshold", () => {
    setDraining();
    tickDrainZeroSessions(); // count=1
    const count = tickDrainZeroSessions(); // count=2
    expect(count).toBe(2);
    // Alert should fire at count >= 2
    expect(count >= 2).toBe(true);
  });

  test("third tick (consecutiveCount=3): still meets alert threshold", () => {
    setDraining();
    tickDrainZeroSessions();
    tickDrainZeroSessions();
    const count = tickDrainZeroSessions(); // count=3
    expect(count).toBe(3);
    expect(count >= 2).toBe(true);
  });

  test("counter resets when drain not active", () => {
    setDraining();
    tickDrainZeroSessions();
    tickDrainZeroSessions();
    // Sessions become active — reset counter
    resetDrainZeroSessions();
    // Drain continues
    const count = tickDrainZeroSessions(); // starts from 1 again
    expect(count).toBe(1);
    expect(count >= 2).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4 (adversarial): getDrainingForSeconds() — float vs floored integer
// ---------------------------------------------------------------------------
// The implementation exports TWO functions:
//   getDrainingForSeconds() — returns raw float (no floor)
//   getDrainingSeconds()    — returns Math.floor'd integer
// The existing tests only cover getDrainingSeconds(). The new OrcaStatus field
// uses getDrainingForSeconds(), so it needs its own coverage.
// ---------------------------------------------------------------------------

describe("getDrainingForSeconds (float, not floored)", () => {
  type DeployModule = typeof import("../src/deploy.js");
  let deploy: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));
    deploy = await import("../src/deploy.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns null when not draining", () => {
    expect(deploy.getDrainingForSeconds()).toBeNull();
  });

  test("returns null after clearDraining", () => {
    deploy.setDraining();
    deploy.clearDraining();
    expect(deploy.getDrainingForSeconds()).toBeNull();
  });

  test("returns a positive number immediately after setDraining", () => {
    deploy.setDraining();
    const val = deploy.getDrainingForSeconds();
    expect(val).not.toBeNull();
    expect(val).toBeGreaterThanOrEqual(0);
  });

  test("returns float (not necessarily integer) after fractional time", () => {
    vi.useFakeTimers();
    deploy.setDraining();
    // Advance by 1500ms — getDrainingForSeconds should return ~1.5, getDrainingSeconds returns 1
    vi.advanceTimersByTime(1500);
    const floatVal = deploy.getDrainingForSeconds()!;
    const flooredVal = deploy.getDrainingSeconds()!;
    expect(floatVal).toBeGreaterThanOrEqual(1.5);
    // getDrainingForSeconds should give a LARGER or equal value than getDrainingSeconds
    expect(floatVal).toBeGreaterThanOrEqual(flooredVal);
  });

  test("getDrainingForSeconds and getDrainingSeconds both advance with time", () => {
    vi.useFakeTimers();
    deploy.setDraining();
    vi.advanceTimersByTime(90_000); // 90 seconds
    expect(deploy.getDrainingForSeconds()!).toBeGreaterThanOrEqual(90);
    expect(deploy.getDrainingSeconds()!).toBeGreaterThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// Part 5 (adversarial): setDraining() idempotency — duplicate call safety
// ---------------------------------------------------------------------------
// A duplicate setDraining() call should be silently ignored.
// CRITICAL: drainingStartedAt must NOT be updated on the duplicate call.
// If it were reset, the drain duration timer would be wrong.
// ---------------------------------------------------------------------------

describe("setDraining idempotency", () => {
  type DeployModule = typeof import("../src/deploy.js");
  let deploy: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));
    deploy = await import("../src/deploy.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("second setDraining() does not reset drainingStartedAt", () => {
    vi.useFakeTimers();
    deploy.setDraining();
    const startedAt1 = deploy.getDrainingStartedAt();

    // Advance time — simulate drain in progress
    vi.advanceTimersByTime(30_000);

    // Second call — should be ignored
    deploy.setDraining();
    const startedAt2 = deploy.getDrainingStartedAt();

    // drainingStartedAt must be unchanged
    expect(startedAt2).toBe(startedAt1);
  });

  test("second setDraining() does not reset the consecutive counter", () => {
    deploy.setDraining();
    deploy.tickDrainZeroSessions();
    deploy.tickDrainZeroSessions(); // count=2

    // Duplicate — must not reset counter to 0
    deploy.setDraining();

    // Counter continues from where it was (still 2, not reset to 0)
    // If setDraining reset the counter, tick would return 1 instead of 3
    const count = deploy.tickDrainZeroSessions();
    expect(count).toBe(3);
  });

  test("isDraining stays true after duplicate setDraining", () => {
    deploy.setDraining();
    deploy.setDraining();
    expect(deploy.isDraining()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 6 (adversarial): tickDrainZeroSessions() without drain active
// ---------------------------------------------------------------------------
// The counter can be incremented even when NOT draining. This is a logic gap:
// stale counter state could cause a false alert if drain starts after ticks.
// ---------------------------------------------------------------------------

describe("tickDrainZeroSessions when not draining", () => {
  type DeployModule = typeof import("../src/deploy.js");
  let deploy: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));
    deploy = await import("../src/deploy.js");
  });

  test("tickDrainZeroSessions increments even when not draining", () => {
    // Not draining — but the counter still works
    expect(deploy.isDraining()).toBe(false);
    const count = deploy.tickDrainZeroSessions();
    // Implementation does NOT guard against this
    expect(count).toBe(1);
  });

  test("counter carries stale state into a new drain cycle if not reset", () => {
    // Tick without draining
    deploy.tickDrainZeroSessions();
    deploy.tickDrainZeroSessions(); // count=2

    // Now start draining — setDraining() DOES reset the counter
    deploy.setDraining();

    // After setDraining, the counter should be 0 (reset in setDraining)
    // First tick should return 1, not 3
    const count = deploy.tickDrainZeroSessions();
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Part 7 (adversarial): writeMonitorSnapshot edge cases
// ---------------------------------------------------------------------------
// The existing tests miss: drainingForSeconds=0, drainingForSeconds=null,
// and drainingForSeconds=undefined. All three are distinct.
// ---------------------------------------------------------------------------

describe("writeMonitorSnapshot edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("drainingForSeconds=0 DOES include meta line (zero is a valid value, not null)", async () => {
    // 0 seconds = just started draining. The condition is `!= null` which is true for 0.
    await writeMonitorSnapshot([], "/tmp/test-zero.ndjson", {
      drainingForSeconds: 0,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const meta = JSON.parse(lines[0]!);
    expect(meta._type).toBe("meta");
    expect(meta.drainingForSeconds).toBe(0);
  });

  test("drainingForSeconds=null does NOT include meta line", async () => {
    // Passing null explicitly should be treated same as not draining
    await writeMonitorSnapshot([], "/tmp/test-null.ndjson", {
      drainingForSeconds: null,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    // Empty task list with no meta: just a newline
    expect(content).toBe("\n");
  });

  test("drainingForSeconds=undefined does NOT include meta line", async () => {
    await writeMonitorSnapshot([], "/tmp/test-undef.ndjson", {
      drainingForSeconds: undefined,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    expect(writeFile).toHaveBeenCalledOnce();
    const content = writeFile.mock.calls[0]![1] as string;
    expect(content).toBe("\n");
  });

  test("meta line has a valid ISO timestamp", async () => {
    await writeMonitorSnapshot([], "/tmp/test-ts.ndjson", {
      drainingForSeconds: 42,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    const content = writeFile.mock.calls[0]![1] as string;
    const meta = JSON.parse(content.trim());
    expect(() => new Date(meta.timestamp)).not.toThrow();
    expect(new Date(meta.timestamp).getTime()).toBeGreaterThan(0);
  });

  test("meta line drainingForSeconds is a number, not a string", async () => {
    await writeMonitorSnapshot([], "/tmp/test-num.ndjson", {
      drainingForSeconds: 99.7,
    });
    const writeFile = vi.mocked(fsPromises.writeFile);
    const content = writeFile.mock.calls[0]![1] as string;
    const meta = JSON.parse(content.trim());
    expect(typeof meta.drainingForSeconds).toBe("number");
    expect(meta.drainingForSeconds).toBe(99.7);
  });
});

// NOTE: trackDrainState() tests are in test/drain-state-tracker.test.ts.
// They are intentionally in a separate file because the top-level
// vi.mock("node:fs/promises") in this file interferes with the real
// filesystem operations trackDrainState() needs.
