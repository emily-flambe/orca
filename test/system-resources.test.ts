// ---------------------------------------------------------------------------
// Unit tests for src/system-resources.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:os so we can control freemem(), loadavg(), and cpus()
vi.mock("node:os", () => ({
  freemem: vi.fn(),
  loadavg: vi.fn(),
  cpus: vi.fn(),
}));

import * as os from "node:os";
import {
  getResourceSnapshot,
  checkResourceConstraints,
} from "../src/system-resources.js";

const mockFreemem = vi.mocked(os.freemem);
const mockLoadavg = vi.mocked(os.loadavg);
const mockCpus = vi.mocked(os.cpus);

const GB = 1024 ** 3;

beforeEach(() => {
  vi.resetAllMocks();
  // Defaults: 4 GB free, 0.5 load average, 4 CPUs
  mockFreemem.mockReturnValue(4 * GB);
  mockLoadavg.mockReturnValue([0.5, 0.4, 0.3]);
  mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
});

// ---------------------------------------------------------------------------
// getResourceSnapshot
// ---------------------------------------------------------------------------

describe("getResourceSnapshot", () => {
  test("converts freemem bytes to GB", () => {
    mockFreemem.mockReturnValue(2 * GB);
    const snapshot = getResourceSnapshot();
    expect(snapshot.availableMemoryGb).toBeCloseTo(2, 5);
  });

  test("1 GB free is correctly converted", () => {
    mockFreemem.mockReturnValue(1 * GB);
    const snapshot = getResourceSnapshot();
    expect(snapshot.availableMemoryGb).toBeCloseTo(1, 5);
  });

  test("on non-Windows platform, cpuLoadPercent is calculated from loadavg and cpu count", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });

    mockLoadavg.mockReturnValue([2.0, 1.8, 1.6]);
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);

    const snapshot = getResourceSnapshot();
    // (2.0 / 4) * 100 = 50%
    expect(snapshot.cpuLoadPercent).toBeCloseTo(50, 5);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("on macOS platform, cpuLoadPercent is calculated", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
    });

    mockLoadavg.mockReturnValue([1.0, 0.8, 0.6]);
    mockCpus.mockReturnValue(new Array(2).fill({ model: "test" }) as never);

    const snapshot = getResourceSnapshot();
    // (1.0 / 2) * 100 = 50%
    expect(snapshot.cpuLoadPercent).toBeCloseTo(50, 5);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("on Windows platform, cpuLoadPercent is null (loadavg returns [0,0,0])", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
    });

    // os.loadavg() returns [0,0,0] on Windows but we skip the check entirely
    mockLoadavg.mockReturnValue([0, 0, 0]);

    const snapshot = getResourceSnapshot();
    expect(snapshot.cpuLoadPercent).toBeNull();

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("cpuLoadPercent is null when cpu count is 0 (edge case)", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });

    mockLoadavg.mockReturnValue([1.0, 0.8, 0.6]);
    mockCpus.mockReturnValue([] as never);

    const snapshot = getResourceSnapshot();
    expect(snapshot.cpuLoadPercent).toBeNull();

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("high load average with many CPUs results in low percent", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });

    mockLoadavg.mockReturnValue([8.0, 7.0, 6.0]);
    mockCpus.mockReturnValue(new Array(16).fill({ model: "test" }) as never);

    const snapshot = getResourceSnapshot();
    // (8.0 / 16) * 100 = 50%
    expect(snapshot.cpuLoadPercent).toBeCloseTo(50, 5);

    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// checkResourceConstraints — memory checks
// ---------------------------------------------------------------------------

describe("checkResourceConstraints — memory", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    // Use Windows platform to avoid CPU check interference in memory tests
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("ok=true when memory exceeds minimum", () => {
    mockFreemem.mockReturnValue(4 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("ok=false when memory is below minimum", () => {
    mockFreemem.mockReturnValue(1 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/insufficient memory/);
    expect(result.reason).toMatch(/1\.00GB available/);
    expect(result.reason).toMatch(/minimum: 2GB/);
  });

  test("ok=false exactly at threshold (strict less-than enforced)", () => {
    // 1.99 GB < 2 GB minimum → fail
    mockFreemem.mockReturnValue(1.99 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
  });

  test("ok=true when memory is exactly at threshold", () => {
    // 2.0 GB >= 2 GB minimum → pass
    mockFreemem.mockReturnValue(2.0 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(true);
  });

  test("snapshot is always included in result", () => {
    mockFreemem.mockReturnValue(0.5 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.availableMemoryGb).toBeCloseTo(0.5, 2);
  });

  test("zero memory fails", () => {
    mockFreemem.mockReturnValue(0);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/insufficient memory/);
  });
});

// ---------------------------------------------------------------------------
// checkResourceConstraints — CPU checks (non-Windows only)
// ---------------------------------------------------------------------------

describe("checkResourceConstraints — CPU", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
    });
    // Enough memory so memory check always passes
    mockFreemem.mockReturnValue(8 * GB);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
  });

  test("ok=true when CPU load is below maximum", () => {
    mockLoadavg.mockReturnValue([1.6, 1.4, 1.2]); // 40% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(true);
  });

  test("ok=false when CPU load exceeds maximum", () => {
    mockLoadavg.mockReturnValue([3.6, 3.2, 3.0]); // 90% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/CPU load too high/);
    expect(result.reason).toMatch(/90\.0%/);
    expect(result.reason).toMatch(/maximum: 80%/);
  });

  test("ok=false exactly above threshold", () => {
    // 80.1% > 80% → fail
    mockLoadavg.mockReturnValue([3.204, 3.0, 2.8]); // ≈ 80.1% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
  });

  test("ok=true when CPU load is exactly at threshold", () => {
    // 80% load average on 4 CPUs = 80% — not exceeding threshold
    mockLoadavg.mockReturnValue([3.2, 3.0, 2.8]); // exactly 80% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(true);
  });

  test("CPU check is skipped on Windows (cpuLoadPercent null never blocks dispatch)", () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      writable: true,
    });
    // Even with "high" loadavg values, Windows skips the check
    mockLoadavg.mockReturnValue([100, 100, 100]);
    mockFreemem.mockReturnValue(8 * GB);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot.cpuLoadPercent).toBeNull();
  });

  test("snapshot includes correct cpuLoadPercent on linux", () => {
    mockLoadavg.mockReturnValue([2.0, 1.8, 1.6]); // 50% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.snapshot.cpuLoadPercent).toBeCloseTo(50, 2);
  });

  test("memory check takes priority over CPU check (fails fast on memory)", () => {
    // Low memory AND high CPU — should report memory failure
    mockFreemem.mockReturnValue(0.5 * GB);
    mockLoadavg.mockReturnValue([4.0, 3.8, 3.6]); // 100% on 4 CPUs
    mockCpus.mockReturnValue(new Array(4).fill({ model: "test" }) as never);
    const result = checkResourceConstraints({
      minMemoryGb: 2,
      maxCpuPercent: 80,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/insufficient memory/);
  });
});
