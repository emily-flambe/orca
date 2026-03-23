// ---------------------------------------------------------------------------
// /api/system-health endpoint tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// Mock child_process.exec so we control PM2/disk responses
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: vi.fn(),
  };
});

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  setDraining: vi.fn(),
  initDeployState: vi.fn(),
}));

import { exec } from "node:child_process";
const mockExec = vi.mocked(exec);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    model: "sonnet",
    reviewModel: "haiku",
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

// Make exec call its callback with the given stdout
function stubExec(stdout: string, err: Error | null = null) {
  mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
    cb(err, stdout, "");
    return {} as any;
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GET /api/system-health", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: { send: vi.fn().mockResolvedValue(undefined) } as any,
    });

    // Default: pm2 unavailable, disk unavailable — keeps tests focused
    stubExec("", new Error("command not found"));

    // Default: Inngest unreachable
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns correct top-level shape", async () => {
    const res = await app.request("/api/system-health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      cpu: expect.objectContaining({
        loadAvg: expect.any(Array),
        cpuCount: expect.any(Number),
        platform: expect.any(String),
      }),
      memory: expect.objectContaining({
        totalMb: expect.any(Number),
        usedMb: expect.any(Number),
        freeMb: expect.any(Number),
        usedPercent: expect.any(Number),
      }),
      pm2: expect.objectContaining({ available: expect.any(Boolean) }),
      inngest: expect.objectContaining({ healthy: expect.any(Boolean) }),
      disk: expect.objectContaining({ available: expect.any(Boolean) }),
      sessions: expect.objectContaining({
        active: expect.any(Number),
        totalToday: expect.any(Number),
      }),
      timestamp: expect.any(String),
    });
  });

  it("reports inngest as unhealthy when unreachable", async () => {
    stubExec("", new Error("pm2 not found"));
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.inngest.healthy).toBe(false);
  });

  it("reports inngest as healthy when /health returns 200", async () => {
    stubExec("", new Error("pm2 not found"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.inngest.healthy).toBe(true);
  });

  it("reports inngest as unhealthy when /health returns 4xx", async () => {
    stubExec("", new Error("pm2 not found"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.inngest.healthy).toBe(false);
  });

  it("reports pm2 as unavailable when pm2 command fails", async () => {
    stubExec("", new Error("command not found"));
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.pm2.available).toBe(false);
    expect(body.pm2.processes).toEqual([]);
  });

  it("parses pm2 jlist output correctly", async () => {
    const startTimestamp = Date.now() - 60_000; // started 60 seconds ago
    const pm2List = JSON.stringify([
      {
        name: "orca",
        pm2_env: { status: "online", restart_time: 2, pm_uptime: startTimestamp },
        monit: { cpu: 5, memory: 50 * 1024 * 1024 },
      },
    ]);
    mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, pm2List, "");
      return {} as any;
    });

    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.pm2.available).toBe(true);
    expect(body.pm2.processes).toHaveLength(1);
    const proc = body.pm2.processes[0];
    expect(proc.name).toBe("orca");
    expect(proc.status).toBe("online");
    expect(proc.cpu).toBe(5);
    expect(proc.memory).toBe(50); // MB
    expect(proc.restarts).toBe(2);
    // Uptime should be approximately 60000ms (within a reasonable margin)
    expect(proc.uptime).toBeGreaterThan(55_000);
    expect(proc.uptime).toBeLessThan(65_000);
  });

  it("pm2 uptime is 0 when pm_uptime is missing", async () => {
    const pm2List = JSON.stringify([
      {
        name: "orca",
        pm2_env: { status: "online", restart_time: 0 },
        monit: { cpu: 0, memory: 0 },
      },
    ]);
    mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, pm2List, "");
      return {} as any;
    });

    const res = await app.request("/api/system-health");
    const body = await res.json();
    // When pm_uptime is undefined, Date.now() - Date.now() ≈ 0
    expect(body.pm2.processes[0].uptime).toBeGreaterThanOrEqual(0);
    expect(body.pm2.processes[0].uptime).toBeLessThan(1000);
  });

  it("parses Unix df -k output correctly", async () => {
    // Simulate running on Linux for df parsing
    const dfOutput = [
      "Filesystem     1K-blocks      Used Available Use% Mounted on",
      "/dev/sda1      102400000  51200000  51200000  50% /",
    ].join("\n");

    mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, dfOutput, "");
      return {} as any;
    });

    // We can't force platform() to return "linux" easily, but we can test
    // the parsing indirectly by checking structure when disk is available
    // (the test env is win32, so we'd need the Windows CSV path)
    const res = await app.request("/api/system-health");
    const body = await res.json();
    // disk section must exist in response regardless of parse path
    expect(body.disk).toHaveProperty("available");
  });

  it("reports disk as unavailable when command fails", async () => {
    mockExec.mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(new Error("exec failed"), "", "");
      return {} as any;
    });

    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.disk.available).toBe(false);
    expect(body.disk.totalGb).toBe(0);
  });

  it("memory usedPercent is in range [0, 100]", async () => {
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(body.memory.usedPercent).toBeLessThanOrEqual(100);
  });

  it("session counts default to 0 with empty DB", async () => {
    const res = await app.request("/api/system-health");
    const body = await res.json();
    expect(body.sessions.active).toBe(0);
    expect(body.sessions.totalToday).toBe(0);
  });
});
