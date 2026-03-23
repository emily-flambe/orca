// ---------------------------------------------------------------------------
// Agent API route tests -- adversarial coverage
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertAgent,
  getAgent,
  insertAgentMemory,
  getAgentMemoryCount,
  getTasksByAgent,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    projectRepoMap: new Map(),
    concurrencyCap: 3,
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

function makeApp(db: OrcaDb): Hono {
  return createApiRoutes({
    db,
    config: makeConfig(),
    syncTasks: vi.fn().mockResolvedValue(0),
    client: {} as never,
    stateMap: new Map(),
    projectMeta: [],
    inngest: mockInngest,
  });
}

function now(): string {
  return new Date().toISOString();
}

function makeAgentData(overrides?: Record<string, unknown>) {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: null,
    systemPrompt: "You are a test agent",
    model: null,
    maxTurns: null,
    timeoutMin: 45,
    repoPath: null,
    schedule: null,
    maxMemories: 200,
    enabled: 1,
    runCount: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastRunStatus: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/agents -- creation & validation
// ---------------------------------------------------------------------------

describe("POST /api/agents -- validation", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function post(body: unknown) {
    return app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates agent with valid data", async () => {
    const res = await post({
      id: "my-agent",
      name: "My Agent",
      systemPrompt: "You are helpful",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("my-agent");
    expect(body.name).toBe("My Agent");
    expect(body.enabled).toBe(1);
    expect(body.maxMemories).toBe(200);
    expect(body.timeoutMin).toBe(45);
  });

  it("rejects missing id", async () => {
    const res = await post({
      name: "No ID",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/id/i);
  });

  it("rejects missing name", async () => {
    const res = await post({
      id: "no-name",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing systemPrompt", async () => {
    const res = await post({
      id: "no-prompt",
      name: "Agent",
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty id", async () => {
    const res = await post({
      id: "",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty name", async () => {
    const res = await post({
      id: "valid-id",
      name: "",
      systemPrompt: "prompt",
    });
    // The current code checks !body.name which is true for empty string
    expect(res.status).toBe(400);
  });

  it("rejects empty systemPrompt", async () => {
    const res = await post({
      id: "valid-id",
      name: "Agent",
      systemPrompt: "",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate id", async () => {
    await post({
      id: "dupe",
      name: "First",
      systemPrompt: "prompt",
    });
    const res = await post({
      id: "dupe",
      name: "Second",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  // BUG: ID validation regex skips single-character IDs
  // The check is: body.id.length > 1 && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.id)
  // Single-char IDs bypass the regex entirely, so invalid chars are accepted.
  it("BUG: single-char uppercase ID bypasses validation", async () => {
    const res = await post({
      id: "A",
      name: "Bad ID",
      systemPrompt: "prompt",
    });
    // EXPECTED: 400 (uppercase is invalid)
    // ACTUAL: 201 (single-char IDs skip regex check)
    expect(res.status).toBe(400);
  });

  it("BUG: single-char special char ID bypasses validation", async () => {
    const res = await post({
      id: "-",
      name: "Hyphen ID",
      systemPrompt: "prompt",
    });
    // EXPECTED: 400 (lone hyphen is invalid)
    // ACTUAL: 201 (single-char IDs skip regex check)
    expect(res.status).toBe(400);
  });

  it("BUG: single-char exclamation ID bypasses validation", async () => {
    const res = await post({
      id: "!",
      name: "Bang ID",
      systemPrompt: "prompt",
    });
    // EXPECTED: 400 (special chars are invalid)
    // ACTUAL: 201 (single-char IDs skip regex check)
    expect(res.status).toBe(400);
  });

  it("rejects id with uppercase letters (multi-char)", async () => {
    const res = await post({
      id: "Bad-Id",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
  });

  it("rejects id ending with hyphen", async () => {
    const res = await post({
      id: "bad-id-",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
  });

  it("rejects id starting with hyphen", async () => {
    const res = await post({
      id: "-bad-id",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(400);
  });

  it("accepts valid multi-char id", async () => {
    const res = await post({
      id: "my-agent-123",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(201);
  });

  it("accepts two-char id like 'ab'", async () => {
    const res = await post({
      id: "ab",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(201);
  });

  it("rejects invalid cron schedule", async () => {
    const res = await post({
      id: "sched-agent",
      name: "Agent",
      systemPrompt: "prompt",
      schedule: "not a cron",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schedule/i);
  });

  it("computes nextRunAt when schedule is provided", async () => {
    const res = await post({
      id: "sched-agent",
      name: "Scheduled Agent",
      systemPrompt: "prompt",
      schedule: "* * * * *",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schedule).toBe("* * * * *");
    expect(body.nextRunAt).not.toBeNull();
    // nextRunAt should be in the future
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now() - 5000,
    );
  });

  it("nextRunAt is null when no schedule", async () => {
    const res = await post({
      id: "no-sched",
      name: "Agent",
      systemPrompt: "prompt",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nextRunAt).toBeNull();
  });

  it("accepts optional fields", async () => {
    const res = await post({
      id: "full-agent",
      name: "Full Agent",
      systemPrompt: "prompt",
      description: "A test agent",
      model: "sonnet",
      maxTurns: 10,
      timeoutMin: 30,
      repoPath: "/tmp/repo",
      maxMemories: 50,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.description).toBe("A test agent");
    expect(body.model).toBe("sonnet");
    expect(body.maxTurns).toBe(10);
    expect(body.timeoutMin).toBe(30);
    expect(body.repoPath).toBe("/tmp/repo");
    expect(body.maxMemories).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

describe("GET /api/agents", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns empty array when no agents", async () => {
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns all agents", async () => {
    insertAgent(db, makeAgentData({ id: "agent-1", name: "A1" }));
    insertAgent(db, makeAgentData({ id: "agent-2", name: "A2" }));
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/nope");
    expect(res.status).toBe(404);
  });

  it("returns agent with memories and tasks", async () => {
    insertAgent(db, makeAgentData());
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "a memory",
    });

    const res = await app.request("/api/agents/test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("test-agent");
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories).toHaveLength(1);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("limits memories to 50 in detail view", async () => {
    insertAgent(db, makeAgentData());
    for (let i = 0; i < 55; i++) {
      insertAgentMemory(db, {
        agentId: "test-agent",
        type: "episodic",
        content: `memory ${i}`,
      });
    }
    const res = await app.request("/api/agents/test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toHaveLength(50);
  });

  it("sorts tasks by createdAt descending", async () => {
    insertAgent(db, makeAgentData());
    const { insertTask } = await import("../src/db/queries.js");
    insertTask(db, {
      linearIssueId: "agent-test-agent-old",
      agentPrompt: "old task",
      repoPath: "/tmp",
      orcaStatus: "done",
      taskType: "agent",
      agentId: "test-agent",
      createdAt: "2026-01-01T08:00:00.000Z",
      updatedAt: "2026-01-01T08:00:00.000Z",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    insertTask(db, {
      linearIssueId: "agent-test-agent-new",
      agentPrompt: "new task",
      repoPath: "/tmp",
      orcaStatus: "running",
      taskType: "agent",
      agentId: "test-agent",
      createdAt: "2026-01-02T10:00:00.000Z",
      updatedAt: "2026-01-02T10:00:00.000Z",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });

    const res = await app.request("/api/agents/test-agent");
    const body = await res.json();
    expect(body.tasks[0].linearIssueId).toBe("agent-test-agent-new");
    expect(body.tasks[1].linearIssueId).toBe("agent-test-agent-old");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/agents/:id
// ---------------------------------------------------------------------------

describe("PUT /api/agents/:id", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
    insertAgent(db, makeAgentData());
  });

  async function put(id: string, body: unknown) {
    return app.request(`/api/agents/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 404 for non-existent agent", async () => {
    const res = await put("nope", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("updates name", async () => {
    const res = await put("test-agent", { name: "Updated" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated");
  });

  it("rejects invalid schedule on update", async () => {
    const res = await put("test-agent", { schedule: "bad cron" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schedule/i);
  });

  it("recomputes nextRunAt when schedule changes", async () => {
    const res = await put("test-agent", { schedule: "0 9 * * *" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toBe("0 9 * * *");
    expect(body.nextRunAt).not.toBeNull();
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("clears nextRunAt when schedule set to null", async () => {
    // First set a schedule
    await put("test-agent", { schedule: "* * * * *" });
    // Then clear it
    const res = await put("test-agent", { schedule: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toBeNull();
    expect(body.nextRunAt).toBeNull();
  });

  it("preserves unchanged fields", async () => {
    const res = await put("test-agent", { name: "New Name" });
    const body = await res.json();
    expect(body.systemPrompt).toBe("You are a test agent");
    expect(body.maxMemories).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/agents/:id", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("deletes agent", async () => {
    insertAgent(db, makeAgentData());
    const res = await app.request("/api/agents/test-agent", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(getAgent(db, "test-agent")).toBeUndefined();
  });

  it("cascade-deletes memories", async () => {
    insertAgent(db, makeAgentData());
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "gone",
    });
    await app.request("/api/agents/test-agent", { method: "DELETE" });
    expect(getAgentMemoryCount(db, "test-agent")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/toggle
// ---------------------------------------------------------------------------

describe("POST /api/agents/:id/toggle", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
  });

  async function toggle(id: string) {
    return app.request(`/api/agents/${id}/toggle`, { method: "POST" });
  }

  it("returns 404 for non-existent agent", async () => {
    const res = await toggle("nope");
    expect(res.status).toBe(404);
  });

  it("flips enabled from 1 to 0", async () => {
    insertAgent(db, makeAgentData({ enabled: 1 }));
    const res = await toggle("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(0);
  });

  it("flips enabled from 0 to 1", async () => {
    insertAgent(db, makeAgentData({ enabled: 0 }));
    const res = await toggle("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });

  it("double toggle returns to original state", async () => {
    insertAgent(db, makeAgentData({ enabled: 1 }));
    await toggle("test-agent");
    const res = await toggle("test-agent");
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/trigger
// ---------------------------------------------------------------------------

describe("POST /api/agents/:id/trigger", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
    mockInngest.send.mockClear();
  });

  async function trigger(id: string) {
    return app.request(`/api/agents/${id}/trigger`, { method: "POST" });
  }

  it("returns 404 for non-existent agent", async () => {
    const res = await trigger("nope");
    expect(res.status).toBe(404);
  });

  it("creates a task with correct taskType and agentId", async () => {
    insertAgent(db, makeAgentData());
    const res = await trigger("test-agent");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeDefined();
    expect(body.taskId).toMatch(/^agent-test-agent-/);

    const tasks = getTasksByAgent(db, "test-agent");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskType).toBe("agent");
    expect(tasks[0].agentId).toBe("test-agent");
    expect(tasks[0].orcaStatus).toBe("ready");
  });

  it("uses systemPrompt as agentPrompt on task", async () => {
    insertAgent(db, makeAgentData({ systemPrompt: "special prompt" }));
    const res = await trigger("test-agent");
    const _body = await res.json();
    const tasks = getTasksByAgent(db, "test-agent");
    expect(tasks[0].agentPrompt).toBe("special prompt");
  });

  it("falls back to defaultCwd when repoPath is null", async () => {
    insertAgent(db, makeAgentData({ repoPath: null }));
    const res = await trigger("test-agent");
    expect(res.status).toBe(200);
    const tasks = getTasksByAgent(db, "test-agent");
    // Falls back to config.defaultCwd when agent has no repoPath configured
    expect(tasks[0].repoPath).toBe("/tmp");
  });

  it("increments runCount after trigger", async () => {
    insertAgent(db, makeAgentData());
    await trigger("test-agent");
    const agent = getAgent(db, "test-agent");
    expect(agent!.runCount).toBe(1);
  });

  it("emits task/ready event via Inngest", async () => {
    insertAgent(db, makeAgentData());
    await trigger("test-agent");
    expect(mockInngest.send).toHaveBeenCalled();
    const call = mockInngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/ready");
  });

  it("allows triggering a disabled agent", async () => {
    // The trigger endpoint does NOT check if agent is enabled
    insertAgent(db, makeAgentData({ enabled: 0 }));
    const res = await trigger("test-agent");
    // Current behavior: allows triggering disabled agents (manual trigger)
    expect(res.status).toBe(200);
    expect(getTasksByAgent(db, "test-agent")).toHaveLength(1);
  });

  it("concurrent triggers produce unique task IDs", async () => {
    insertAgent(db, makeAgentData());
    const fixedMs = 1741564800000;
    vi.spyOn(Date, "now").mockReturnValue(fixedMs);

    const res1 = await trigger("test-agent");
    const body1 = await res1.json();
    const res2 = await trigger("test-agent");
    const body2 = await res2.json();

    expect(body1.taskId).not.toBe(body2.taskId);

    vi.restoreAllMocks();
  });

  it("updates nextRunAt when agent has schedule", async () => {
    insertAgent(
      db,
      makeAgentData({
        schedule: "* * * * *",
        nextRunAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await trigger("test-agent");
    const agent = getAgent(db, "test-agent");
    expect(agent!.nextRunAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(new Date(agent!.nextRunAt!).getTime()).toBeGreaterThan(
      Date.now() - 5000,
    );
  });

  it("sets nextRunAt to null when agent has no schedule", async () => {
    insertAgent(db, makeAgentData({ schedule: null }));
    await trigger("test-agent");
    const agent = getAgent(db, "test-agent");
    expect(agent!.nextRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id/memories
// ---------------------------------------------------------------------------

describe("GET /api/agents/:id/memories", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
    insertAgent(db, makeAgentData());
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/nope/memories");
    expect(res.status).toBe(404);
  });

  it("returns empty array when no memories", async () => {
    const res = await app.request("/api/agents/test-agent/memories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns all memories", async () => {
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "a",
    });
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "b",
    });
    const res = await app.request("/api/agents/test-agent/memories");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("filters by type query param", async () => {
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "ep",
    });
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "semantic",
      content: "sem",
    });
    const res = await app.request(
      "/api/agents/test-agent/memories?type=episodic",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("episodic");
  });

  it("returns empty array for invalid type filter", async () => {
    insertAgentMemory(db, {
      agentId: "test-agent",
      type: "episodic",
      content: "ep",
    });
    const res = await app.request(
      "/api/agents/test-agent/memories?type=nonexistent",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/memories/:memoryId
// ---------------------------------------------------------------------------

describe("DELETE /api/agents/:id/memories/:memoryId", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApp(db);
    insertAgent(db, makeAgentData({ id: "agent-a" }));
    insertAgent(db, makeAgentData({ id: "agent-b" }));
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await app.request("/api/agents/nope/memories/1", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-numeric memory id", async () => {
    const res = await app.request("/api/agents/agent-a/memories/abc", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("deletes a memory", async () => {
    const memId = insertAgentMemory(db, {
      agentId: "agent-a",
      type: "episodic",
      content: "bye",
    });
    const res = await app.request(`/api/agents/agent-a/memories/${memId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(getAgentMemoryCount(db, "agent-a")).toBe(0);
  });

  it("rejects deleting another agent's memory (ownership check)", async () => {
    const memId = insertAgentMemory(db, {
      agentId: "agent-b",
      type: "episodic",
      content: "agent-b's secret",
    });

    // Deleting agent-b's memory through agent-a's endpoint should fail
    const res = await app.request(`/api/agents/agent-a/memories/${memId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    // agent-b's memory should still exist
    expect(getAgentMemoryCount(db, "agent-b")).toBe(1);
  });

  it("returns 404 for non-existent memory id", async () => {
    const res = await app.request("/api/agents/agent-a/memories/99999", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
