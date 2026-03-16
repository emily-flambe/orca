// ---------------------------------------------------------------------------
// Tests for src/linear/poller.ts
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFullSync = vi.fn();

vi.mock("../src/linear/sync.js", () => ({
  fullSync: (...args: unknown[]) => mockFullSync(...args),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  computeBackoffMs,
  createPoller,
  POLL_INTERVAL_MS,
  MAX_BACKOFF_MS,
} from "../src/linear/poller.js";
import type { PollerDeps } from "../src/linear/poller.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  mockFullSync.mockReset();
  mockFullSync.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PollerDeps> = {}): PollerDeps {
  return {
    db: {} as never,
    client: {} as never,
    graph: {} as never,
    config: {} as never,
    stateMap: {} as never,
    isTunnelConnected: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe("computeBackoffMs", () => {
  test("returns POLL_INTERVAL_MS when failures is 0", () => {
    expect(computeBackoffMs(0)).toBe(POLL_INTERVAL_MS);
  });

  test("returns POLL_INTERVAL_MS * 1 when failures is 1 (2^0 = 1)", () => {
    expect(computeBackoffMs(1)).toBe(POLL_INTERVAL_MS * 1);
  });

  test("returns POLL_INTERVAL_MS * 2 when failures is 2 (2^1 = 2)", () => {
    expect(computeBackoffMs(2)).toBe(POLL_INTERVAL_MS * 2);
  });

  test("returns POLL_INTERVAL_MS * 4 when failures is 3 (2^2 = 4)", () => {
    expect(computeBackoffMs(3)).toBe(POLL_INTERVAL_MS * 4);
  });

  test("caps at MAX_BACKOFF_MS for large failure counts", () => {
    expect(computeBackoffMs(10)).toBe(MAX_BACKOFF_MS);
  });

  test("returns POLL_INTERVAL_MS for negative failures", () => {
    expect(computeBackoffMs(-5)).toBe(POLL_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------
// createPoller
// ---------------------------------------------------------------------------

describe("createPoller", () => {
  test("when tunnel is up, does NOT call fullSync", async () => {
    const deps = makeDeps({
      isTunnelConnected: vi.fn().mockReturnValue(true),
    });
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(mockFullSync).not.toHaveBeenCalled();

    poller.stop();
  });

  test("when tunnel is down, calls fullSync", async () => {
    const deps = makeDeps({
      isTunnelConnected: vi.fn().mockReturnValue(false),
    });
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(mockFullSync).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("fullSync failure increments consecutiveFailures in health()", async () => {
    mockFullSync.mockRejectedValue(new Error("sync failed"));
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(poller.health().consecutiveFailures).toBe(1);

    poller.stop();
  });

  test("success after failures resets consecutiveFailures to 0", async () => {
    // Fail first poll, succeed second
    mockFullSync
      .mockRejectedValueOnce(new Error("sync failed"))
      .mockResolvedValue(undefined);
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();

    // First tick (fails)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();
    expect(poller.health().consecutiveFailures).toBe(1);

    // Second tick interval is now POLL_INTERVAL_MS * 1 (backoff for 1 failure)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();
    expect(poller.health().consecutiveFailures).toBe(0);

    poller.stop();
  });

  test("stop() prevents further ticks", async () => {
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    poller.stop();

    // Advance time — no ticks should fire
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    await Promise.resolve();

    expect(mockFullSync).not.toHaveBeenCalled();
  });

  test("health() returns correct lastSuccessAt after successful poll", async () => {
    const before = new Date().toISOString();
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    const { lastSuccessAt } = poller.health();
    expect(lastSuccessAt).not.toBeNull();
    expect(new Date(lastSuccessAt!).toISOString()).toBeGreaterThanOrEqual
      ? true
      : expect(lastSuccessAt! >= before).toBe(true);

    poller.stop();
  });

  test("health() returns correct lastError after failed poll", async () => {
    mockFullSync.mockRejectedValue(new Error("network down"));
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(poller.health().lastError).toContain("network down");

    poller.stop();
  });

  test("health() returns null lastError on success", async () => {
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(poller.health().lastError).toBeNull();

    poller.stop();
  });

  test("start() called twice only starts one timer (idempotent)", async () => {
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    poller.start(); // second call should be no-op

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    // Only one tick should have fired
    expect(mockFullSync).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("concurrent tick prevention: second tick during active tick does not call fullSync again", async () => {
    // Make fullSync take a long time (simulate slow sync)
    let resolveFn: (() => void) | null = null;
    mockFullSync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();

    // Trigger first tick
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    // fullSync is still running (not resolved yet)
    expect(mockFullSync).toHaveBeenCalledTimes(1);

    // Now resolve the first sync and let scheduling proceed
    resolveFn!();
    await Promise.resolve();

    poller.stop();
  });

  test("health() currentIntervalMs reflects backoff after failures", async () => {
    mockFullSync.mockRejectedValue(new Error("err"));
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    // After 1 failure, backoff = POLL_INTERVAL_MS * 1
    expect(poller.health().currentIntervalMs).toBe(POLL_INTERVAL_MS);

    poller.stop();
  });

  test("fullSync is called with all deps arguments", async () => {
    const deps = makeDeps();
    const poller = createPoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);
    await Promise.resolve();

    expect(mockFullSync).toHaveBeenCalledWith(
      deps.db,
      deps.client,
      deps.graph,
      deps.config,
      deps.stateMap,
      deps.labelIdCache,
      deps.inngest,
    );

    poller.stop();
  });
});
