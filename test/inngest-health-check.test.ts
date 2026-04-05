// ---------------------------------------------------------------------------
// Tests for Inngest health check retry/backoff/caching logic in GET /api/status
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import { _resetInngestHealthCacheForTesting } from "../src/api/routes.js";
import type { OrcaConfig } from "../src/config/index.js";

vi.mock("../src/session-handles.js", () => ({ activeHandles: new Map() }));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  invocationLogs: new Map(),
}));
vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
  findStateByType: vi
    .fn()
    .mockReturnValue({ id: "state-1", type: "unstarted" }),
}));
vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  getDrainingSeconds: vi.fn().mockReturnValue(null),
  getDrainingForSeconds: vi.fn().mockReturnValue(null),
}));

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    projectRepoMap: new Map(),
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    fixSystemPrompt: "",
    disallowedTools: "",
    model: "sonnet",
    deployStrategy: "none",
    maxDeployPollAttempts: 60,
    maxCiPollAttempts: 240,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

function makeApp() {
  const db = createDb(":memory:");
  return createApiRoutes({
    db,
    config: makeConfig(),
    syncTasks: vi.fn().mockResolvedValue([]),
    client: {
      createIssue: vi.fn(),
      updateIssueState: vi.fn(),
      createComment: vi.fn().mockResolvedValue(undefined),
    } as any,
    stateMap: new Map(),
    projectMeta: [],
    inngest: { send: vi.fn().mockResolvedValue(undefined) } as any,
  });
}

beforeEach(() => {
  _resetInngestHealthCacheForTesting();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _resetInngestHealthCacheForTesting();
});

describe("Inngest health check — retry behavior", () => {
  it("returns true immediately on first successful fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();
    const resPromise = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res = await resPromise;
    const body = await res.json();

    expect(body.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on fetch error and returns true if second attempt succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();
    const resPromise = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res = await resPromise;
    const body = await res.json();

    expect(body.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 response and returns true if next attempt returns 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();
    const resPromise = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res = await resPromise;
    const body = await res.json();

    expect(body.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false only after all 3 attempts fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();
    const resPromise = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res = await resPromise;
    const body = await res.json();

    expect(body.inngestReachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on successful fetch even if it's a non-200 non-5xx status", async () => {
    // Status codes < 500 (e.g. 302, 404) still count as reachable
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();
    const resPromise = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res = await resPromise;
    const body = await res.json();

    expect(body.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Inngest health check — caching behavior", () => {
  it("caches a successful result and does not re-fetch within 10 seconds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();

    // First call
    const p1 = app.request("/api/status");
    await vi.runAllTimersAsync();
    await p1;

    // Second call — should hit cache, no additional fetch
    const p2 = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res2 = await p2;
    const body2 = await res2.json();

    expect(body2.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a failed result and does not re-fetch within 10 seconds", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();

    // First call — 3 attempts
    const p1 = app.request("/api/status");
    await vi.runAllTimersAsync();
    await p1;

    const callsAfterFirst = fetchMock.mock.calls.length;

    // Second call — should hit cache
    const p2 = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res2 = await p2;
    const body2 = await res2.json();

    expect(body2.inngestReachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst); // no new calls
  });

  it("re-fetches after cache expires (> 10 seconds)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const app = makeApp();

    // First call
    const p1 = app.request("/api/status");
    await vi.runAllTimersAsync();
    await p1;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance time past cache TTL (10s)
    vi.advanceTimersByTime(11_000);

    // Second call — cache expired, should re-fetch
    const p2 = app.request("/api/status");
    await vi.runAllTimersAsync();
    const res2 = await p2;
    const body2 = await res2.json();

    expect(body2.inngestReachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
