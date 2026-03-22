// ---------------------------------------------------------------------------
// API Contract Tests
// Verifies response shapes (status codes + required fields) for every route.
// Business logic is tested in api.test.ts — this file focuses on the contract.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import { insertTask, insertInvocation } from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/session-handles.js", () => ({ activeHandles: new Map() }));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue(undefined),
  invocationLogs: new Map(),
}));
vi.mock("../src/linear/sync.js", () => ({
  writeBackStatus: vi.fn().mockResolvedValue(undefined),
  findStateByType: vi
    .fn()
    .mockReturnValue({ id: "state-123", type: "unstarted" }),
}));
vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    logPath: "./orca.log",
    ...overrides,
  };
}

function makeTask(overrides?: Record<string, unknown>) {
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: "ready" as const,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const mockClient = {
  createIssue: vi
    .fn()
    .mockResolvedValue({ identifier: "TEST-1", id: "issue-id-1" }),
  updateIssueState: vi.fn().mockResolvedValue(true),
  createComment: vi.fn().mockResolvedValue(undefined),
} as any;

const projectMeta = [
  { id: "test-project", name: "Test Project", teamIds: ["team-1"] },
];

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeApp(db: OrcaDb, configOverrides?: Partial<OrcaConfig>): Hono {
  return createApiRoutes({
    db,
    config: makeConfig(configOverrides),
    syncTasks: vi.fn().mockResolvedValue([]),
    client: mockClient,
    stateMap: new Map(),
    projectMeta,
    inngest: mockInngest,
  });
}

// ---------------------------------------------------------------------------
// GET /api/tasks
// ---------------------------------------------------------------------------

describe("GET /api/tasks — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: returns an array", async () => {
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("200: each item has Task fields + invocationCount as a number", async () => {
    insertTask(db, makeTask());
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    const item = body[0];
    expect(typeof item.linearIssueId).toBe("string");
    expect(typeof item.agentPrompt).toBe("string");
    expect(typeof item.repoPath).toBe("string");
    expect(typeof item.orcaStatus).toBe("string");
    expect(typeof item.priority).toBe("number");
    expect(typeof item.retryCount).toBe("number");
    expect(typeof item.invocationCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/:id
// ---------------------------------------------------------------------------

describe("GET /api/tasks/:id — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: task exists — returns Task with invocations array", async () => {
    insertTask(db, makeTask({ linearIssueId: "TASK-A" }));
    const res = await app.request("/api/tasks/TASK-A");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.linearIssueId).toBe("string");
    expect(Array.isArray(body.invocations)).toBe(true);
  });

  it("404: unknown task — returns { error: string }", async () => {
    const res = await app.request("/api/tasks/NONEXISTENT");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GET /api/invocations/running
// ---------------------------------------------------------------------------

describe("GET /api/invocations/running — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: returns an array", async () => {
    const res = await app.request("/api/invocations/running");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("200: running invocation has agentPrompt field", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "RUN-1", orcaStatus: "running" as const }),
    );
    insertInvocation(db, {
      linearIssueId: "RUN-1",
      startedAt: new Date().toISOString(),
      status: "running",
    });
    const res = await app.request("/api/invocations/running");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect("agentPrompt" in body[0]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/invocations/:id/logs
// ---------------------------------------------------------------------------

describe("GET /api/invocations/:id/logs — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("400: non-numeric id — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/abc/logs");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("404: numeric id but no invocation — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/9999/logs");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("404: invocation exists but log file missing — returns { error: string }", async () => {
    insertTask(db, makeTask({ linearIssueId: "LOG-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "LOG-1",
      startedAt: new Date().toISOString(),
      status: "completed",
      logPath: join(tmpdir(), `orca-nonexistent-${Date.now()}.ndjson`),
    });
    const res = await app.request(`/api/invocations/${invId}/logs`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("200: log file exists — returns { lines: any[] }", async () => {
    const logFile = join(tmpdir(), `orca-test-log-${Date.now()}.ndjson`);
    writeFileSync(
      logFile,
      '{"type":"text","content":"hello"}\n{"type":"text","content":"world"}\n',
    );
    try {
      insertTask(db, makeTask({ linearIssueId: "LOG-OK" }));
      const invId = insertInvocation(db, {
        linearIssueId: "LOG-OK",
        startedAt: new Date().toISOString(),
        status: "completed",
        logPath: logFile,
      });
      const res = await app.request(`/api/invocations/${invId}/logs`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.lines)).toBe(true);
      expect(body.lines).toHaveLength(2);
    } finally {
      unlinkSync(logFile);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/invocations/:id/abort
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/abort — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("400: non-numeric id — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/abc/abort", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("404: invocation not found — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/9999/abort", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("409: invocation not running — returns { error: string }", async () => {
    insertTask(db, makeTask({ linearIssueId: "ABORT-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "ABORT-1",
      startedAt: new Date().toISOString(),
      status: "completed",
    });
    const res = await app.request(`/api/invocations/${invId}/abort`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("200: running invocation — returns { ok: true }", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "ABORT-RUN-1",
        orcaStatus: "running" as const,
      }),
    );
    const invId = insertInvocation(db, {
      linearIssueId: "ABORT-RUN-1",
      startedAt: new Date().toISOString(),
      status: "running",
    });
    const res = await app.request(`/api/invocations/${invId}/abort`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/status
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/status — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: valid status change — returns { ok: true }", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "STATUS-1", orcaStatus: "ready" as const }),
    );
    const res = await app.request("/api/tasks/STATUS-1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "backlog" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("400: invalid status value — returns { error: string }", async () => {
    const res = await app.request("/api/tasks/STATUS-1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid-status" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("404: task not found — returns { error: string }", async () => {
    const res = await app.request("/api/tasks/NONEXISTENT/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("409: task already has the requested status — returns { error: string }", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "STATUS-SAME", orcaStatus: "ready" as const }),
    );
    const res = await app.request("/api/tasks/STATUS-SAME/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/retry
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/retry — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: failed task — returns { ok: true }", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "RETRY-1", orcaStatus: "failed" as const }),
    );
    const res = await app.request("/api/tasks/RETRY-1/retry", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("404: task not found — returns { error: string }", async () => {
    const res = await app.request("/api/tasks/NONEXISTENT/retry", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("409: task not failed — returns { error: string }", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "RETRY-READY", orcaStatus: "ready" as const }),
    );
    const res = await app.request("/api/tasks/RETRY-READY/retry", {
      method: "POST",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

describe("POST /api/sync — contract", () => {
  it("200: returns { synced: number }", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const res = await app.request("/api/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.synced).toBe("number");
  });

  it("500: syncTasks throws — returns { error: string }", async () => {
    const db = createDb(":memory:");
    const app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockRejectedValue(new Error("sync failed")),
      client: mockClient,
      stateMap: new Map(),
      projectMeta,
      inngest: mockInngest,
    });
    const res = await app.request("/api/sync", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

describe("GET /api/status — contract", () => {
  it("200: returns all required fields with correct types", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.activeSessions).toBe("number");
    expect(Array.isArray(body.activeTaskIds)).toBe(true);
    expect(typeof body.queuedTasks).toBe("number");
    expect(typeof body.costInWindow).toBe("number");
    expect(typeof body.budgetLimit).toBe("number");
    expect(typeof body.budgetWindowHours).toBe("number");
    expect(typeof body.concurrencyCap).toBe("number");
    expect(typeof body.implementModel).toBe("string");
    expect(typeof body.reviewModel).toBe("string");
    expect(typeof body.fixModel).toBe("string");
    expect(typeof body.draining).toBe("boolean");
    expect(typeof body.drainSessionCount).toBe("number");
    expect(typeof body.inngestReachable).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// POST /api/config
// ---------------------------------------------------------------------------

describe("POST /api/config — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("200: valid update — returns { ok: true, concurrencyCap, implementModel, reviewModel, fixModel }", async () => {
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrencyCap: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.concurrencyCap).toBe("number");
    expect(typeof body.implementModel).toBe("string");
    expect(typeof body.reviewModel).toBe("string");
    expect(typeof body.fixModel).toBe("string");
  });

  it("400: invalid concurrencyCap — returns { error: string }", async () => {
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrencyCap: -1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("400: invalid model value — returns { error: string }", async () => {
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ implementModel: "gpt-4" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("400: invalid JSON body — returns { error: string }", async () => {
    const res = await app.request("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GET /api/metrics
// ---------------------------------------------------------------------------

describe("GET /api/metrics — contract", () => {
  it("200: returns all required fields", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.uptime).toBe("object");
    expect(typeof body.uptime.restartsToday).toBe("number");
    expect(typeof body.throughput).toBe("object");
    expect(typeof body.throughput.last24h.completed).toBe("number");
    expect(typeof body.throughput.last24h.failed).toBe("number");
    expect(typeof body.throughput.last7d.completed).toBe("number");
    expect(typeof body.throughput.last7d.failed).toBe("number");
    expect(typeof body.errors).toBe("object");
    expect(typeof body.errors.lastHour).toBe("number");
    expect(typeof body.errors.last24h).toBe("number");
    expect(typeof body.queue).toBe("object");
    expect(typeof body.queue.ready).toBe("number");
    expect(typeof body.queue.running).toBe("number");
    expect(typeof body.queue.inReview).toBe("number");
    expect(typeof body.budget).toBe("object");
    expect(typeof body.budget.costInWindow).toBe("number");
    expect(typeof body.budget.limit).toBe("number");
    expect(typeof body.budget.windowHours).toBe("number");
    expect(Array.isArray(body.recentEvents)).toBe(true);
    // Legacy fields (backward-compat with dashboard)
    expect(typeof body.tasksByStatus).toBe("object");
    expect(typeof body.invocationStats).toBe("object");
    expect(Array.isArray(body.recentErrors)).toBe(true);
    expect(typeof body.costLast24h).toBe("number");
    expect(typeof body.costLast7d).toBe("number");
    expect(typeof body.costPrev24h).toBe("number");
    expect(Array.isArray(body.dailyStats)).toBe(true);
    expect(Array.isArray(body.recentActivity)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/logs
// ---------------------------------------------------------------------------

describe("GET /api/logs — contract", () => {
  it("200: log file missing — returns { lines: [], total: 0, sizeBytes: 0 }", async () => {
    const db = createDb(":memory:");
    // Use a logPath that definitely doesn't exist
    const app = makeApp(db, {
      logPath: "/tmp/nonexistent-orca-log-contract-test.log",
    });
    const res = await app.request("/api/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.sizeBytes).toBe(0);
  });

  it("200: returns correct shape with lines, total, sizeBytes fields", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db, {
      logPath: "/tmp/nonexistent-orca-log-contract-test-2.log",
    });
    const res = await app.request("/api/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.lines)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.sizeBytes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe("GET /api/projects — contract", () => {
  it("200: returns array of { id, name } objects", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(typeof body[0].id).toBe("string");
    expect(typeof body[0].name).toBe("string");
  });

  it("200: empty projectMeta returns empty array", async () => {
    const db = createDb(":memory:");
    const app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue([]),
      client: mockClient,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks
// ---------------------------------------------------------------------------

describe("POST /api/tasks — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
    mockClient.createIssue.mockResolvedValue({
      identifier: "TEST-1",
      id: "issue-id-1",
    });
  });

  it("200: valid request — returns { identifier: string, id: string }", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New task", projectId: "test-project" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.identifier).toBe("string");
    expect(typeof body.id).toBe("string");
  });

  it("400: missing title — returns { error: string }", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test-project" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("400: invalid JSON — returns { error: string }", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("400: invalid status value — returns { error: string }", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New task", status: "running" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("500: createIssue throws — returns { error: string }", async () => {
    mockClient.createIssue.mockRejectedValueOnce(new Error("Linear API down"));
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New task", projectId: "test-project" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// GET /api/invocations/:id/logs/stream (SSE)
// ---------------------------------------------------------------------------

describe("GET /api/invocations/:id/logs/stream — contract", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("400: non-numeric id — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/abc/logs/stream");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("404: invocation not found — returns { error: string }", async () => {
    const res = await app.request("/api/invocations/9999/logs/stream");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("200: invocation exists, no in-memory log state — SSE connection established", async () => {
    insertTask(db, makeTask({ linearIssueId: "STREAM-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "STREAM-1",
      startedAt: new Date().toISOString(),
      status: "completed",
    });
    // invocationLogs is an empty Map (mocked), so no log state — handler falls back to done
    const res = await app.request(`/api/invocations/${invId}/logs/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// GET /api/events (SSE)
// ---------------------------------------------------------------------------

describe("GET /api/events — contract", () => {
  it("200: establishes SSE stream with correct content-type", async () => {
    const db = createDb(":memory:");
    const app = makeApp(db);
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});
