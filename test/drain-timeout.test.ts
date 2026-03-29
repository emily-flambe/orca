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
