import { describe, test, expect } from "vitest";
// @ts-expect-error -- .mjs script has no type declarations
import { formatDuration, defaultState, processCheckResult } from "../scripts/monitor-snapshot-logic.mjs";

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
    const result = processCheckResult(prev, { up: false, port: null, error: "ECONNREFUSED" }, T0);
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
    const result = processCheckResult(prev, { up: false, port: null, error: "ECONNREFUSED" }, T1);
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
    const result = processCheckResult(prev, { up: false, port: null, error: "ETIMEDOUT" }, T1);
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
    const result = processCheckResult(prev, { up: true, port: 4001, error: null }, T2);
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
    const result = processCheckResult(prev, { up: true, port: 4000, error: null }, T0);
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
    const result = processCheckResult(prev, { up: false, port: null, error: "ECONNREFUSED" }, T1);
    expect(result.newState.downtimeStartedAt).toBe(T0);
  });

  test("HTTP_503 treated as DOWN", () => {
    const prev = defaultState();
    const result = processCheckResult(prev, { up: false, port: null, error: "HTTP_503" }, T0);
    expect(result.snapshot.status).toBe("DOWN");
    expect(result.snapshot.error).toBe("HTTP_503");
  });
});
