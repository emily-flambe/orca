// ---------------------------------------------------------------------------
// Unit tests for resource-check module
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, afterEach } from "vitest";

vi.mock("node:os");

import os from "node:os";
import {
  getResourceSnapshot,
  isResourceConstrained,
} from "../src/inngest/resource-check.js";

const mockOs = vi.mocked(os);

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getResourceSnapshot
// ---------------------------------------------------------------------------

describe("getResourceSnapshot", () => {
  test("returns memory in MB from os.freemem()", () => {
    mockOs.freemem.mockReturnValue(4 * 1024 * 1024 * 1024); // 4 GB
    mockOs.loadavg.mockReturnValue([0, 0, 0]);
    mockOs.cpus.mockReturnValue([{} as never, {} as never, {} as never, {} as never]);

    const snap = getResourceSnapshot();
    expect(snap.memAvailableMb).toBeCloseTo(4096, 0);
  });

  test("computes cpuLoadPercent from loadavg on Unix (loadavg > 0)", () => {
    vi.stubEnv("", ""); // ensure process is in a clean state
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux" as NodeJS.Platform);
    mockOs.freemem.mockReturnValue(8 * 1024 * 1024 * 1024);
    // 4-core machine, load average of 2.0 → 50%
    mockOs.loadavg.mockReturnValue([2.0, 1.8, 1.5]);
    mockOs.cpus.mockReturnValue(new Array(4).fill({}) as never);

    const snap = getResourceSnapshot();
    platformSpy.mockRestore();
    expect(snap.cpuLoadPercent).toBeCloseTo(50, 1);
  });

  test("returns cpuLoadPercent 0 on Windows", () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32" as NodeJS.Platform);
    mockOs.freemem.mockReturnValue(8 * 1024 * 1024 * 1024);
    mockOs.loadavg.mockReturnValue([5.0, 5.0, 5.0]);
    mockOs.cpus.mockReturnValue(new Array(8).fill({}) as never);

    const snap = getResourceSnapshot();
    platformSpy.mockRestore();
    expect(snap.cpuLoadPercent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isResourceConstrained
// ---------------------------------------------------------------------------

describe("isResourceConstrained", () => {
  test("returns false when both resources are fine", () => {
    const snap = { memAvailableMb: 8192, cpuLoadPercent: 20 };
    expect(isResourceConstrained(snap)).toBe(false);
  });

  test("returns true when memory is below 2GB threshold", () => {
    const snap = { memAvailableMb: 1024, cpuLoadPercent: 10 };
    expect(isResourceConstrained(snap)).toBe(true);
  });

  test("returns true when memory is exactly at threshold boundary (< 2048)", () => {
    const snap = { memAvailableMb: 2047, cpuLoadPercent: 10 };
    expect(isResourceConstrained(snap)).toBe(true);
  });

  test("returns false when memory is exactly at threshold (2048 MB)", () => {
    const snap = { memAvailableMb: 2048, cpuLoadPercent: 10 };
    expect(isResourceConstrained(snap)).toBe(false);
  });

  test("returns true when CPU load exceeds 80%", () => {
    const snap = { memAvailableMb: 8192, cpuLoadPercent: 90 };
    expect(isResourceConstrained(snap)).toBe(true);
  });

  test("returns false when CPU load is exactly at threshold (80%)", () => {
    const snap = { memAvailableMb: 8192, cpuLoadPercent: 80 };
    expect(isResourceConstrained(snap)).toBe(false);
  });

  test("returns true when CPU load is just above 80%", () => {
    const snap = { memAvailableMb: 8192, cpuLoadPercent: 80.1 };
    expect(isResourceConstrained(snap)).toBe(true);
  });

  test("returns false when CPU load is 0 (Windows fallback)", () => {
    const snap = { memAvailableMb: 8192, cpuLoadPercent: 0 };
    expect(isResourceConstrained(snap)).toBe(false);
  });

  test("returns true when both memory and CPU are constrained (memory checked first)", () => {
    const snap = { memAvailableMb: 512, cpuLoadPercent: 95 };
    expect(isResourceConstrained(snap)).toBe(true);
  });
});
