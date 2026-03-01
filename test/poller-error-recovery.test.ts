// ---------------------------------------------------------------------------
// Poller error recovery tests (EMI-18)
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
    claudePath: "claude",
    defaultMaxTurns: 20,
    appendSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

// ===========================================================================
// Unit tests for pure functions
// ===========================================================================

describe("classifyError", () => {
  let classifyError: typeof import("../src/linear/poller.js").classifyError;

  beforeEach(async () => {
    const mod = await import("../src/linear/poller.js");
    classifyError = mod.classifyError;
  });

  test("auth failure is permanent", () => {
    const err = new Error(
      "LinearClient: authentication failed (HTTP 401). Check that ORCA_LINEAR_API_KEY is valid.",
    );
    expect(classifyError(err)).toBe("permanent");
  });

  test("403 auth failure is permanent", () => {
    const err = new Error(
      "LinearClient: authentication failed (HTTP 403). Check that ORCA_LINEAR_API_KEY is valid.",
    );
    expect(classifyError(err)).toBe("permanent");
  });

  test("network error is transient", () => {
    const err = new Error("LinearClient: network error after 4 attempts: ECONNREFUSED");
    expect(classifyError(err)).toBe("transient");
  });

  test("HTTP 500 is transient", () => {
    const err = new Error("LinearClient: HTTP 500 after 4 attempts");
    expect(classifyError(err)).toBe("transient");
  });

  test("generic error is transient", () => {
    expect(classifyError(new Error("something went wrong"))).toBe("transient");
  });

  test("string error is transient", () => {
    expect(classifyError("timeout")).toBe("transient");
  });
});

describe("addJitter", () => {
  let addJitter: typeof import("../src/linear/poller.js").addJitter;

  beforeEach(async () => {
    const mod = await import("../src/linear/poller.js");
    addJitter = mod.addJitter;
  });

  test("rand=0 gives 0.8x factor (lower bound)", () => {
    expect(addJitter(1000, 0)).toBe(800);
  });

  test("rand=1 gives 1.2x factor (upper bound)", () => {
    expect(addJitter(1000, 1)).toBe(1200);
  });

  test("rand=0.5 gives 1.0x factor (no change)", () => {
    expect(addJitter(1000, 0.5)).toBe(1000);
  });

  test("result is always rounded", () => {
    const result = addJitter(333, 0.33);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ===========================================================================
// Poller integration tests — error recovery
// ===========================================================================

vi.mock("../src/linear/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/linear/sync.js")>();
  return {
    ...actual,
    fullSync: vi.fn().mockResolvedValue({ total: 5, upsertFailures: 0 }),
    processWebhookEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

describe("Poller — permanent error halts polling", () => {
  let createPoller: typeof import("../src/linear/poller.js").createPoller;
  let fullSyncMock: Mock;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Pin jitter to factor=1.0 so timer intervals are deterministic
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const pollerMod = await import("../src/linear/poller.js");
    createPoller = pollerMod.createPoller;

    const syncMod = await import("../src/linear/sync.js");
    fullSyncMock = syncMod.fullSync as unknown as Mock;
    fullSyncMock.mockClear();

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("auth error halts polling immediately", async () => {
    fullSyncMock.mockRejectedValue(
      new Error("LinearClient: authentication failed (HTTP 401). Check that ORCA_LINEAR_API_KEY is valid."),
    );

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // First tick triggers auth error
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    const health = poller.health();
    expect(health.halted).toBe(true);
    expect(health.lastErrorKind).toBe("permanent");
    expect(health.consecutiveFailures).toBe(1);

    // Critical log should have been emitted
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("CRITICAL: permanent error, polling halted"),
    );

    // Advance far into the future — no more polls
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("start() after halt resets halted state", async () => {
    fullSyncMock.mockRejectedValueOnce(
      new Error("LinearClient: authentication failed (HTTP 401). Check that ORCA_LINEAR_API_KEY is valid."),
    );

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poller.health().halted).toBe(true);

    // Fix the error and restart
    fullSyncMock.mockResolvedValue({ total: 5, upsertFailures: 0 });
    poller.stop();
    poller.start();
    expect(poller.health().halted).toBe(false);

    poller.stop();
  });
});

describe("Poller — circuit breaker", () => {
  let createPoller: typeof import("../src/linear/poller.js").createPoller;
  let CIRCUIT_OPEN_THRESHOLD: number;
  let fullSyncMock: Mock;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Pin jitter to factor=1.0 so timer intervals are deterministic
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const pollerMod = await import("../src/linear/poller.js");
    createPoller = pollerMod.createPoller;
    CIRCUIT_OPEN_THRESHOLD = pollerMod.CIRCUIT_OPEN_THRESHOLD;

    const syncMod = await import("../src/linear/sync.js");
    fullSyncMock = syncMod.fullSync as unknown as Mock;
    fullSyncMock.mockClear();
    fullSyncMock.mockRejectedValue(new Error("API down"));

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("circuit opens after threshold consecutive failures", async () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // Advance through failures up to threshold
    // Each failure doubles the interval: 30s, 30s, 60s, 120s, 240s (capped at 300s)...
    // We'll just advance a lot to ensure all timers fire
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      await vi.advanceTimersByTimeAsync(300_000); // max backoff
    }

    expect(fullSyncMock.mock.calls.length).toBeGreaterThanOrEqual(
      CIRCUIT_OPEN_THRESHOLD,
    );
    expect(poller.health().circuitOpen).toBe(true);

    // Critical log should have been emitted exactly once at the threshold
    const criticalLogs = consoleSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("CRITICAL") &&
        call[0].includes("circuit open"),
    );
    expect(criticalLogs).toHaveLength(1);

    poller.stop();
  });

  test("circuit closes after recovery", async () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // Push past threshold
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      await vi.advanceTimersByTimeAsync(300_000);
    }
    expect(poller.health().circuitOpen).toBe(true);

    // Recover
    fullSyncMock.mockResolvedValue({ total: 5, upsertFailures: 0 });
    await vi.advanceTimersByTimeAsync(300_000);

    expect(poller.health().circuitOpen).toBe(false);
    expect(poller.health().consecutiveFailures).toBe(0);

    poller.stop();
  });
});

describe("Poller — health reporting", () => {
  let createPoller: typeof import("../src/linear/poller.js").createPoller;
  let fullSyncMock: Mock;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Pin jitter to factor=1.0 so timer intervals are deterministic
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const pollerMod = await import("../src/linear/poller.js");
    createPoller = pollerMod.createPoller;

    const syncMod = await import("../src/linear/sync.js");
    fullSyncMock = syncMod.fullSync as unknown as Mock;
    fullSyncMock.mockClear();

    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("initial health has null error fields and no circuit/halt", () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    const h = poller.health();
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastError).toBeNull();
    expect(h.lastErrorKind).toBeNull();
    expect(h.lastSuccessAt).toBeNull();
    expect(h.circuitOpen).toBe(false);
    expect(h.halted).toBe(false);
  });

  test("transient error populates lastErrorKind", async () => {
    fullSyncMock.mockRejectedValue(new Error("network timeout"));

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const h = poller.health();
    expect(h.lastErrorKind).toBe("transient");
    expect(h.halted).toBe(false);

    poller.stop();
  });

  test("success clears errorKind", async () => {
    fullSyncMock
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue({ total: 3, upsertFailures: 0 });

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(30_000); // fail
    expect(poller.health().lastErrorKind).toBe("transient");

    await vi.advanceTimersByTimeAsync(30_000); // succeed
    expect(poller.health().lastErrorKind).toBeNull();
    expect(poller.health().lastError).toBeNull();

    poller.stop();
  });
});
