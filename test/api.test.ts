// ---------------------------------------------------------------------------
// Phase 3 UI Dashboard - API endpoint tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  getTask,
  updateInvocation,
} from "../src/db/queries.js";
import { orcaEvents } from "../src/events.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { WorkflowStateMap } from "../src/linear/client.js";
import type { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as deployModule from "../src/deploy.js";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  getDrainingSeconds: vi.fn().mockReturnValue(null),
  setDraining: vi.fn(),
  clearDraining: vi.fn(),
  initDeployState: vi.fn(),
  getDrainingForSeconds: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function deriveLifecycle(status: string): {
  lifecycleStage: string;
  currentPhase: string | null;
} {
  const map: Record<
    string,
    { lifecycleStage: string; currentPhase: string | null }
  > = {
    backlog: { lifecycleStage: "backlog", currentPhase: null },
    ready: { lifecycleStage: "ready", currentPhase: null },
    running: { lifecycleStage: "active", currentPhase: "implement" },
    in_review: { lifecycleStage: "active", currentPhase: "review" },
    changes_requested: { lifecycleStage: "active", currentPhase: "fix" },
    awaiting_ci: { lifecycleStage: "active", currentPhase: "ci" },
    deploying: { lifecycleStage: "active", currentPhase: "deploy" },
    done: { lifecycleStage: "done", currentPhase: null },
    failed: { lifecycleStage: "failed", currentPhase: null },
    canceled: { lifecycleStage: "canceled", currentPhase: null },
  };
  return map[status] ?? { lifecycleStage: status, currentPhase: null };
}

function makeTask(overrides?: Record<string, unknown>) {
  const orcaStatus = (overrides?.orcaStatus as string) ?? "ready";
  const lifecycle = deriveLifecycle(orcaStatus);
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    orcaStatus: orcaStatus as "ready",
    lifecycleStage: lifecycle.lifecycleStage,
    currentPhase: lifecycle.currentPhase,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GET /api/tasks", () => {
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
      inngest: mockInngest,
    });
  });

  it("returns empty array when no tasks exist", async () => {
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns tasks sorted by priority ASC then createdAt ASC", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "LOW-PRIO",
        priority: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    insertTask(
      db,
      makeTask({
        linearIssueId: "HIGH-PRIO",
        priority: 1,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    insertTask(
      db,
      makeTask({
        linearIssueId: "HIGH-PRIO-EARLIER",
        priority: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(3);
    // Priority 1 first (two of them), then priority 3
    expect(body[0].linearIssueId).toBe("HIGH-PRIO-EARLIER"); // prio 1, earlier date
    expect(body[1].linearIssueId).toBe("HIGH-PRIO"); // prio 1, later date
    expect(body[2].linearIssueId).toBe("LOW-PRIO"); // prio 3
  });

  it("returns all task fields correctly", async () => {
    const task = makeTask({
      linearIssueId: "FULL-TASK",
      agentPrompt: "Implement feature X",
      repoPath: "/home/user/project",
      orcaStatus: "running" as const,
      priority: 1,
      retryCount: 2,
      createdAt: "2026-02-15T10:30:00.000Z",
      updatedAt: "2026-02-15T11:00:00.000Z",
    });
    insertTask(db, task);

    const res = await app.request("/api/tasks");
    const body = await res.json();

    expect(body).toHaveLength(1);
    const returned = body[0];
    expect(returned.linearIssueId).toBe("FULL-TASK");
    expect(returned.agentPrompt).toBe("Implement feature X");
    expect(returned.repoPath).toBe("/home/user/project");
    expect(returned.orcaStatus).toBe("running");
    expect(returned.priority).toBe(1);
    expect(returned.retryCount).toBe(2);
    expect(returned.createdAt).toBe("2026-02-15T10:30:00.000Z");
    expect(returned.updatedAt).toBe("2026-02-15T11:00:00.000Z");
  });
});

describe("GET /api/tasks/:id", () => {
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
      inngest: mockInngest,
    });
  });

  it("returns task with invocations array", async () => {
    insertTask(db, makeTask({ linearIssueId: "TASK-WITH-INV" }));
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-WITH-INV",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      costUsd: 0.25,
      numTurns: 5,
      outputSummary: "All done",
    });

    const res = await app.request("/api/tasks/TASK-WITH-INV");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.linearIssueId).toBe("TASK-WITH-INV");
    expect(body.invocations).toBeInstanceOf(Array);
    expect(body.invocations).toHaveLength(1);
    expect(body.invocations[0].id).toBe(invId);
    expect(body.invocations[0].status).toBe("completed");
    expect(body.invocations[0].costUsd).toBe(0.25);
    expect(body.invocations[0].numTurns).toBe(5);
    expect(body.invocations[0].outputSummary).toBe("All done");
  });

  it("returns 404 for unknown task ID", async () => {
    const res = await app.request("/api/tasks/NONEXISTENT");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("task not found");
  });
});

describe("GET /api/status", () => {
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
      inngest: mockInngest,
    });
  });

  it("returns correct status object with all fields", async () => {
    // Insert a ready task
    insertTask(
      db,
      makeTask({
        linearIssueId: "READY-1",
        orcaStatus: "ready" as const,
      }),
    );
    // Insert a running task with a running invocation
    insertTask(
      db,
      makeTask({
        linearIssueId: "RUNNING-1",
        orcaStatus: "running" as const,
      }),
    );
    insertInvocation(db, {
      linearIssueId: "RUNNING-1",
      startedAt: now(),
      status: "running",
    });
    // Insert a done task (should not appear in queued or active)
    insertTask(
      db,
      makeTask({
        linearIssueId: "DONE-1",
        orcaStatus: "done" as const,
      }),
    );

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.activeSessions).toBe(1);
    expect(body.activeTaskIds).toEqual(["RUNNING-1"]);
    expect(body.queuedTasks).toBe(1);
    expect(body.budgetWindowHours).toBe(4);
  });
});

describe("GET /api/health", () => {
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
      inngest: mockInngest,
    });
  });

  it("returns 200 with healthy status when no issues", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.draining).toBe(false);
    expect(typeof body.activeSessions).toBe("number");
    expect(body.checks.db).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("includes uptime field", async () => {
    const res = await app.request("/api/health");
    const body = await res.json();
    // uptime is null when no startup event exists, or a number
    expect(body.uptime === null || typeof body.uptime === "number").toBe(true);
  });

  it("response shape matches spec", async () => {
    const res = await app.request("/api/health");
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("draining");
    expect(body).toHaveProperty("activeSessions");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("db");
    expect(body.checks).toHaveProperty("inngest");
  });

  it("returns 200 with draining status when draining", async () => {
    vi.mocked(deployModule.isDraining).mockReturnValueOnce(true);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("draining");
    expect(body.draining).toBe(true);
  });

  it("returns 503 with degraded status when DB fails", async () => {
    db.$client.close();
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.db).toBe("error");
  });
});

describe("GET /api/events (SSE)", () => {
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
      inngest: mockInngest,
    });
  });

  it("returns content-type text/event-stream and streams events", async () => {
    const controller = new AbortController();

    const res = await app.request("/api/events", {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/event-stream");

    // Read the stream for events
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Emit a task:updated event after a short delay to give the stream time to set up
    const eventPayload = { linearIssueId: "SSE-TEST", orcaStatus: "running" };
    setTimeout(() => {
      orcaEvents.emit("task:updated", eventPayload);
    }, 50);

    // Read chunks until we find our event or timeout
    let accumulated = "";
    const readWithTimeout = async (): Promise<string> => {
      const timeoutMs = 2000;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>(
          (resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), 500),
        );

        const result = await Promise.race([readPromise, timeoutPromise]);
        if (result.value) {
          accumulated += decoder.decode(result.value, { stream: true });
        }
        if (accumulated.includes("task:updated")) {
          break;
        }
        if (result.done) {
          break;
        }
      }
      return accumulated;
    };

    const output = await readWithTimeout();

    // Clean up: abort the stream and cancel the reader
    controller.abort();
    try {
      reader.cancel();
    } catch {
      // Ignore cancel errors
    }

    // Verify the SSE event was streamed
    expect(output).toContain("event: task:updated");
    expect(output).toContain(JSON.stringify(eventPayload));
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/status  (EMI-93: status update from UI)
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/status", () => {
  let db: OrcaDb;
  let app: Hono;
  let _writeBackStatusMock: ReturnType<typeof vi.fn>;
  let stateMap: WorkflowStateMap;
  let taskUpdatedSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb(":memory:");
    _writeBackStatusMock = vi.fn().mockResolvedValue(undefined);
    stateMap = new Map([
      ["Backlog", { id: "state-backlog", type: "backlog" }],
      ["Todo", { id: "state-todo", type: "unstarted" }],
      ["In Progress", { id: "state-progress", type: "started" }],
      ["Done", { id: "state-done", type: "completed" }],
    ]);

    // Create a mock client that has writeBackStatus mocked
    const mockClient = {
      updateIssueState: vi.fn().mockResolvedValue(true),
      createComment: vi.fn().mockResolvedValue(undefined),
    } as any;

    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: mockClient,
      stateMap,
      projectMeta: [],
      inngest: mockInngest,
    });

    // Spy on task:updated event emissions
    taskUpdatedSpy = vi.fn();
    orcaEvents.on("task:updated", taskUpdatedSpy);
  });

  afterEach(() => {
    orcaEvents.removeListener("task:updated", taskUpdatedSpy);
    vi.restoreAllMocks();
  });

  // --- Helper to POST status ---
  function postStatus(taskId: string, body: unknown) {
    return app.request(`/api/tasks/${taskId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // -----------------------------------------------------------------------
  // Happy path transitions
  // -----------------------------------------------------------------------

  it("backlog -> ready: succeeds and resets counters", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-1",
        orcaStatus: "backlog" as const,
        retryCount: 3,
      }),
    );

    const res = await postStatus("T-1", { status: "ready" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const task = getTask(db, "T-1");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.lifecycleStage).toBe("ready");
    expect(task!.currentPhase).toBeNull();
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("ready -> done: succeeds", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-2",
        orcaStatus: "ready" as const,
      }),
    );

    const res = await postStatus("T-2", { status: "done" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-2");
    expect(task!.orcaStatus).toBe("done");
    expect(task!.lifecycleStage).toBe("done");
    expect(task!.currentPhase).toBeNull();
  });

  it("done -> backlog: succeeds and resets counters", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-3",
        orcaStatus: "done" as const,
        retryCount: 2,
      }),
    );

    const res = await postStatus("T-3", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-3");
    expect(task!.orcaStatus).toBe("backlog");
    expect(task!.lifecycleStage).toBe("backlog");
    expect(task!.currentPhase).toBeNull();
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("failed -> ready: succeeds (re-queue via status endpoint)", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-4",
        orcaStatus: "failed" as const,
        retryCount: 5,
      }),
    );

    const res = await postStatus("T-4", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-4");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.lifecycleStage).toBe("ready");
    expect(task!.retryCount).toBe(0);
  });

  it("failed -> backlog: succeeds", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-5",
        orcaStatus: "failed" as const,
      }),
    );

    const res = await postStatus("T-5", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-5");
    expect(task!.orcaStatus).toBe("backlog");
    expect(task!.lifecycleStage).toBe("backlog");
    expect(task!.currentPhase).toBeNull();
  });

  it("ready -> backlog: succeeds", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-6",
        orcaStatus: "ready" as const,
      }),
    );

    const res = await postStatus("T-6", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-6");
    expect(task!.orcaStatus).toBe("backlog");
  });

  // -----------------------------------------------------------------------
  // Error responses
  // -----------------------------------------------------------------------

  it("returns 400 for invalid status value", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-ERR-1" }));

    const res = await postStatus("T-ERR-1", { status: "running" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("status must be one of");
  });

  it("returns 400 for status=null", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-ERR-2" }));

    const res = await postStatus("T-ERR-2", { status: null });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing status field", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-ERR-3" }));

    const res = await postStatus("T-ERR-3", {});
    expect(res.status).toBe(400);
  });

  it("returns 400 for status as integer", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-ERR-4" }));

    const res = await postStatus("T-ERR-4", { status: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent task", async () => {
    const res = await postStatus("NONEXISTENT", { status: "ready" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("task not found");
  });

  it("returns 409 when setting same status as current", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-SAME",
        orcaStatus: "ready" as const,
      }),
    );

    const res = await postStatus("T-SAME", { status: "ready" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already");
  });

  it("returns 409 when setting done on already-done task", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-DONE-SAME",
        orcaStatus: "done" as const,
      }),
    );

    const res = await postStatus("T-DONE-SAME", { status: "done" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when setting backlog on already-backlog task", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-BL-SAME",
        orcaStatus: "backlog" as const,
      }),
    );

    const res = await postStatus("T-BL-SAME", { status: "backlog" });
    expect(res.status).toBe(409);
  });

  // -----------------------------------------------------------------------
  // Malformed body
  // -----------------------------------------------------------------------

  it("returns error for malformed JSON body (BUG: should be 400, not 500)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-MALFORMED" }));

    const res = await app.request("/api/tasks/T-MALFORMED/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json{{{",
    });

    // The endpoint does not try/catch c.req.json(), so Hono's default
    // error handler catches the SyntaxError. This should ideally be 400
    // (Bad Request) with a descriptive error, not 500.
    // Let's check what actually happens:
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Ideally this should be 400, not 500:
    expect(res.status).toBe(400);
  });

  it("returns error for empty body (BUG: should be 400, not 500)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-EMPTY" }));

    const res = await app.request("/api/tasks/T-EMPTY/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Same issue: no try/catch around c.req.json()
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Ideally this should be 400, not 500:
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Counter resets
  // -----------------------------------------------------------------------

  it("resets retryCount and reviewCycleCount when moving to ready", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-COUNTERS-1",
        orcaStatus: "failed" as const,
        retryCount: 5,
      }),
    );

    // Set reviewCycleCount using updateTaskFields
    const { updateTaskFields } = await import("../src/db/queries.js");
    updateTaskFields(db, "T-COUNTERS-1", { reviewCycleCount: 3 });

    // Verify precondition
    const before = getTask(db, "T-COUNTERS-1");
    expect(before!.retryCount).toBe(5);
    expect(before!.reviewCycleCount).toBe(3);

    const res = await postStatus("T-COUNTERS-1", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-COUNTERS-1");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("resets retryCount and reviewCycleCount when moving to backlog", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-COUNTERS-2",
        orcaStatus: "done" as const,
        retryCount: 2,
      }),
    );

    const { updateTaskFields } = await import("../src/db/queries.js");
    updateTaskFields(db, "T-COUNTERS-2", { reviewCycleCount: 4 });

    const res = await postStatus("T-COUNTERS-2", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-COUNTERS-2");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("does NOT reset counters when moving to done (uses updateTaskStatus)", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-COUNTERS-3",
        orcaStatus: "ready" as const,
        retryCount: 3,
      }),
    );

    const res = await postStatus("T-COUNTERS-3", { status: "done" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-COUNTERS-3");
    // updateTaskStatus does NOT reset retryCount, so it should remain 3
    expect(task!.retryCount).toBe(3);
  });

  it("resets staleSessionRetryCount when moving to ready", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-STALE-1",
        orcaStatus: "failed" as const,
        retryCount: 1,
      }),
    );

    const {
      updateTaskFields: _updateTaskFields,
      incrementStaleSessionRetryCount,
    } = await import("../src/db/queries.js");
    incrementStaleSessionRetryCount(db, "T-STALE-1");
    incrementStaleSessionRetryCount(db, "T-STALE-1");
    incrementStaleSessionRetryCount(db, "T-STALE-1");

    const before = getTask(db, "T-STALE-1");
    expect(before!.staleSessionRetryCount).toBe(3);

    const res = await postStatus("T-STALE-1", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-STALE-1");
    expect(task!.staleSessionRetryCount).toBe(0);
  });

  it("resets staleSessionRetryCount when moving to backlog", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-STALE-2",
        orcaStatus: "failed" as const,
        retryCount: 2,
      }),
    );

    const { incrementStaleSessionRetryCount } =
      await import("../src/db/queries.js");
    incrementStaleSessionRetryCount(db, "T-STALE-2");
    incrementStaleSessionRetryCount(db, "T-STALE-2");

    const before = getTask(db, "T-STALE-2");
    expect(before!.staleSessionRetryCount).toBe(2);

    const res = await postStatus("T-STALE-2", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-STALE-2");
    expect(task!.staleSessionRetryCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // done -> sets doneAt timestamp
  // -----------------------------------------------------------------------

  it("sets doneAt when moving to done", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-DONEAT",
        orcaStatus: "ready" as const,
      }),
    );

    await postStatus("T-DONEAT", { status: "done" });

    const task = getTask(db, "T-DONEAT");
    expect(task!.doneAt).not.toBeNull();
  });

  it("clears doneAt when moving from done to backlog", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-DONEAT-CLEAR",
        orcaStatus: "done" as const,
      }),
    );
    // Set doneAt
    const { updateTaskStatus: uts } = await import("../src/db/queries.js");
    uts(db, "T-DONEAT-CLEAR", "done");

    const before = getTask(db, "T-DONEAT-CLEAR");
    expect(before!.doneAt).not.toBeNull();

    await postStatus("T-DONEAT-CLEAR", { status: "backlog" });

    const after = getTask(db, "T-DONEAT-CLEAR");
    expect(after!.doneAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  it("emits task:updated event after status change", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-EVENT",
        orcaStatus: "backlog" as const,
      }),
    );

    await postStatus("T-EVENT", { status: "ready" });

    // The event should have been emitted with the updated task
    expect(taskUpdatedSpy).toHaveBeenCalledTimes(1);
    const emittedTask = taskUpdatedSpy.mock.calls[0][0];
    expect(emittedTask.linearIssueId).toBe("T-EVENT");
    expect(emittedTask.orcaStatus).toBe("ready");
  });

  it("does NOT emit task:updated on error (404)", async () => {
    await postStatus("NONEXISTENT", { status: "ready" });
    expect(taskUpdatedSpy).not.toHaveBeenCalled();
  });

  it("does NOT emit task:updated on error (409)", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-NO-EVENT",
        orcaStatus: "ready" as const,
      }),
    );

    await postStatus("T-NO-EVENT", { status: "ready" });
    expect(taskUpdatedSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Edge case: moving from active states (running/in_review)
  // -----------------------------------------------------------------------

  it("running -> done: succeeds (kills session logic does not crash without active handles)", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-RUNNING",
        orcaStatus: "running" as const,
      }),
    );
    // Insert a running invocation
    insertInvocation(db, {
      linearIssueId: "T-RUNNING",
      startedAt: now(),
      status: "running",
    });

    const res = await postStatus("T-RUNNING", { status: "done" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-RUNNING");
    expect(task!.orcaStatus).toBe("done");
  });

  it("running -> backlog: succeeds", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-DISPATCHED",
        orcaStatus: "running" as const,
      }),
    );

    const res = await postStatus("T-DISPATCHED", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-DISPATCHED");
    expect(task!.orcaStatus).toBe("backlog");
  });

  it("in_review -> ready: succeeds", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-REVIEW",
        orcaStatus: "in_review" as const,
      }),
    );

    const res = await postStatus("T-REVIEW", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-REVIEW");
    expect(task!.orcaStatus).toBe("ready");
  });

  // -----------------------------------------------------------------------
  // Edge case: extra fields in body should be ignored
  // -----------------------------------------------------------------------

  it("ignores extra fields in request body", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "T-EXTRA",
        orcaStatus: "backlog" as const,
      }),
    );

    const res = await postStatus("T-EXTRA", {
      status: "ready",
      extraField: "should be ignored",
      priority: 999,
    });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-EXTRA");
    expect(task!.orcaStatus).toBe("ready");
    // Priority should NOT have changed
    expect(task!.priority).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Edge case: status values that look close but aren't valid
  // -----------------------------------------------------------------------

  it("rejects status='Ready' (case sensitive)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-CASE" }));

    const res = await postStatus("T-CASE", { status: "Ready" });
    expect(res.status).toBe(400);
  });

  it("rejects status='DONE' (case sensitive)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-CASE-2" }));

    const res = await postStatus("T-CASE-2", { status: "DONE" });
    expect(res.status).toBe(400);
  });

  it("accepts status='failed' (manual override via UI)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-FAILED-TARGET" }));

    const res = await postStatus("T-FAILED-TARGET", { status: "failed" });
    expect(res.status).toBe(200);
    const task = getTask(db, "T-FAILED-TARGET");
    expect(task!.orcaStatus).toBe("failed");
  });

  it("rejects status='running' (not an allowed target)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-RUNNING-TARGET" }));

    const res = await postStatus("T-RUNNING-TARGET", { status: "running" });
    expect(res.status).toBe(400);
  });

  it("rejects status='' (empty string)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-EMPTY-STR" }));

    const res = await postStatus("T-EMPTY-STR", { status: "" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/projects  (EMI-101: in-app ticket creation)
// ---------------------------------------------------------------------------

describe("GET /api/projects", () => {
  it("returns project id and name from projectMeta", async () => {
    const projectMeta = [
      { id: "proj-1", name: "Orca", description: "", teamIds: ["team-1"] },
      { id: "proj-2", name: "Other", description: "", teamIds: ["team-2"] },
    ];
    const app = createApiRoutes({
      db: createDb(":memory:"),
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta,
      inngest: mockInngest,
    });

    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: "proj-1", name: "Orca" },
      { id: "proj-2", name: "Other" },
    ]);
  });

  it("returns empty array when projectMeta is empty", async () => {
    const app = createApiRoutes({
      db: createDb(":memory:"),
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
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
// POST /api/tasks  (EMI-101: in-app ticket creation)
// ---------------------------------------------------------------------------

describe("POST /api/tasks", () => {
  let db: OrcaDb;
  let app: Hono;
  let createIssueMock: ReturnType<typeof vi.fn>;
  let syncTasksMock: ReturnType<typeof vi.fn>;
  let stateMap: WorkflowStateMap;

  beforeEach(() => {
    db = createDb(":memory:");
    createIssueMock = vi
      .fn()
      .mockResolvedValue({ id: "issue-abc", identifier: "PROJ-42" });
    syncTasksMock = vi.fn().mockResolvedValue(0);
    stateMap = new Map([
      ["Backlog", { id: "state-backlog", type: "backlog" }],
      ["Todo", { id: "state-todo", type: "unstarted" }],
    ]);
    const mockClient = { createIssue: createIssueMock } as any;
    const projectMeta = [
      { id: "proj-1", name: "Orca", description: "", teamIds: ["team-1"] },
    ];
    app = createApiRoutes({
      db,
      config: makeConfig({ linearProjectIds: ["proj-1"] }),
      syncTasks: syncTasksMock,
      client: mockClient,
      stateMap,
      projectMeta,
      inngest: mockInngest,
    });
  });

  function post(body: unknown) {
    return app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates an issue and returns identifier", async () => {
    const res = await post({ title: "Fix the thing" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: "issue-abc", identifier: "PROJ-42" });
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix the thing",
        teamId: "team-1",
        stateId: "state-todo",
      }),
    );
  });

  it("uses backlog state when status=backlog", async () => {
    await post({ title: "Someday task", status: "backlog" });
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stateId: "state-backlog",
      }),
    );
  });

  it("passes priority to createIssue", async () => {
    await post({ title: "Urgent bug", priority: 1 });
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 1 }),
    );
  });

  it("ignores out-of-range priority", async () => {
    await post({ title: "Bad prio", priority: 99 });
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ priority: undefined }),
    );
  });

  it("trims whitespace from title", async () => {
    await post({ title: "  spaces  " });
    expect(createIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "spaces" }),
    );
  });

  it("triggers sync after creation", async () => {
    await post({ title: "New ticket" });
    // syncTasks is called fire-and-forget; wait a tick for the promise to enqueue
    await new Promise((r) => setTimeout(r, 0));
    expect(syncTasksMock).toHaveBeenCalled();
  });

  it("returns 400 when title is missing", async () => {
    const res = await post({ description: "no title" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title/i);
  });

  it("returns 400 when title is blank", async () => {
    const res = await post({ title: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid status value", async () => {
    const res = await post({ title: "ok", status: "in_progress" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status/i);
  });

  it("returns 400 when project has no team", async () => {
    const appNoTeam = createApiRoutes({
      db: createDb(":memory:"),
      config: makeConfig({ linearProjectIds: ["proj-empty"] }),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: { createIssue: createIssueMock } as any,
      stateMap,
      projectMeta: [
        { id: "proj-empty", name: "Empty", description: "", teamIds: [] },
      ],
      inngest: mockInngest,
    });
    const res = await appNoTeam.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ok" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/team/i);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 when createIssue throws", async () => {
    createIssueMock.mockRejectedValueOnce(new Error("Linear API down"));
    const res = await post({ title: "Will fail" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Linear API down");
  });

  it("returns 500 (not a hang) when createIssue rejects with timeout error", async () => {
    createIssueMock.mockRejectedValueOnce(
      new Error(
        "LinearClient: network error after 4 attempts: The operation was aborted.",
      ),
    );
    const res = await post({ title: "Timeout test" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// POST /api/invocations/:id/abort  (EMI-84: abort running session)
// ---------------------------------------------------------------------------

describe("POST /api/invocations/:id/abort", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: { updateIssueState: vi.fn().mockResolvedValue(true) } as any,
      stateMap: new Map([["Todo", { id: "state-todo", type: "unstarted" }]]),
      projectMeta: [],
      inngest: mockInngest,
    });
  });

  function postAbort(invocationId: number | string, body: unknown = {}) {
    return app.request(`/api/invocations/${invocationId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 for non-numeric invocation id", async () => {
    const res = await postAbort("not-a-number");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid invocation id/i);
  });

  it("returns 404 when invocation not found", async () => {
    const res = await postAbort(9999);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 409 when invocation is already completed", async () => {
    insertTask(db, makeTask({ linearIssueId: "ABORT-TASK-1" }));
    insertInvocation(db, {
      linearIssueId: "ABORT-TASK-1",
      startedAt: now(),
      status: "completed",
    });
    const { getInvocationsByTask } = await import("../src/db/queries.js");
    const invocations = getInvocationsByTask(db, "ABORT-TASK-1");
    const id = invocations[0].id;

    const res = await postAbort(id);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not running/i);
  });

  it("aborts a running invocation and returns ok", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "ABORT-TASK-2",
        orcaStatus: "running" as const,
      }),
    );
    insertInvocation(db, {
      linearIssueId: "ABORT-TASK-2",
      startedAt: now(),
      status: "running",
    });
    const { getInvocationsByTask, getTask } =
      await import("../src/db/queries.js");
    const invocations = getInvocationsByTask(db, "ABORT-TASK-2");
    const id = invocations[0].id;

    const res = await postAbort(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Invocation should be marked failed
    const { getInvocation } = await import("../src/db/queries.js");
    const inv = getInvocation(db, id);
    expect(inv!.status).toBe("failed");
    expect(inv!.outputSummary).toMatch(/aborted/i);

    // Task should be reset to ready
    const task = getTask(db, "ABORT-TASK-2");
    expect(task!.orcaStatus).toBe("ready");
  });

  it("resets staleSessionRetryCount when aborting", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "ABORT-TASK-3",
        orcaStatus: "running" as const,
      }),
    );
    insertInvocation(db, {
      linearIssueId: "ABORT-TASK-3",
      startedAt: now(),
      status: "running",
    });

    const { getInvocationsByTask, getTask, incrementStaleSessionRetryCount } =
      await import("../src/db/queries.js");
    incrementStaleSessionRetryCount(db, "ABORT-TASK-3");
    incrementStaleSessionRetryCount(db, "ABORT-TASK-3");

    const before = getTask(db, "ABORT-TASK-3");
    expect(before!.staleSessionRetryCount).toBe(2);

    const invocations = getInvocationsByTask(db, "ABORT-TASK-3");
    const id = invocations[0].id;

    const res = await postAbort(id);
    expect(res.status).toBe(200);

    const task = getTask(db, "ABORT-TASK-3");
    expect(task!.staleSessionRetryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/retry
// ---------------------------------------------------------------------------

describe("POST /api/tasks/:id/retry", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {
        updateIssueState: vi.fn().mockResolvedValue(true),
        createComment: vi.fn().mockResolvedValue({}),
      } as any,
      stateMap: new Map([["Todo", { id: "state-todo", type: "unstarted" }]]),
      projectMeta: [],
      inngest: mockInngest,
    });
  });

  function postRetry(taskId: string) {
    return app.request(`/api/tasks/${taskId}/retry`, { method: "POST" });
  }

  it("returns 404 when task not found", async () => {
    const res = await postRetry("NONEXISTENT");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 409 when task is not failed", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "RETRY-TASK-1", orcaStatus: "ready" as const }),
    );
    const res = await postRetry("RETRY-TASK-1");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/not failed/i);
  });

  it("resets counters and moves failed task to ready", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "RETRY-TASK-2",
        orcaStatus: "failed" as const,
        retryCount: 3,
      }),
    );
    const { getTask, updateTaskFields } = await import("../src/db/queries.js");
    updateTaskFields(db, "RETRY-TASK-2", { reviewCycleCount: 2 });

    const res = await postRetry("RETRY-TASK-2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const task = getTask(db, "RETRY-TASK-2");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("resets staleSessionRetryCount when retrying a failed task", async () => {
    insertTask(
      db,
      makeTask({
        linearIssueId: "RETRY-TASK-3",
        orcaStatus: "failed" as const,
      }),
    );

    const { getTask, incrementStaleSessionRetryCount } =
      await import("../src/db/queries.js");
    incrementStaleSessionRetryCount(db, "RETRY-TASK-3");
    incrementStaleSessionRetryCount(db, "RETRY-TASK-3");
    incrementStaleSessionRetryCount(db, "RETRY-TASK-3");

    const before = getTask(db, "RETRY-TASK-3");
    expect(before!.staleSessionRetryCount).toBe(3);

    const res = await postRetry("RETRY-TASK-3");
    expect(res.status).toBe(200);

    const task = getTask(db, "RETRY-TASK-3");
    expect(task!.staleSessionRetryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/invocations/:id/logs — cron_shell log retrieval
// ---------------------------------------------------------------------------

describe("GET /api/invocations/:id/logs — cron_shell", () => {
  let db: OrcaDb;
  let app: Hono;
  let tmpLogDir: string;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
    tmpLogDir = join(tmpdir(), `orca-test-logs-${Date.now()}`);
    mkdirSync(tmpLogDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpLogDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  });

  it("returns 404 when cron_shell log file does not exist", async () => {
    insertTask(db, makeTask({ linearIssueId: "SHELL-LOG-1" }));
    const invId = insertInvocation(db, {
      linearIssueId: "SHELL-LOG-1",
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId, { logPath: join(tmpLogDir, "missing.ndjson") });

    const res = await app.request(`/api/invocations/${invId}/logs`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/log file not found/i);
  });

  it("returns parsed NDJSON lines from cron_shell log file", async () => {
    insertTask(db, makeTask({ linearIssueId: "SHELL-LOG-2" }));
    const invId = insertInvocation(db, {
      linearIssueId: "SHELL-LOG-2",
      startedAt: now(),
      status: "completed",
    });
    const logFile = join(tmpLogDir, `${invId}.ndjson`);
    const entry = {
      type: "shell_output",
      exitCode: 0,
      timedOut: false,
      output: "hello world\n",
      timestamp: now(),
    };
    writeFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    updateInvocation(db, invId, { logPath: logFile });

    const res = await app.request(`/api/invocations/${invId}/logs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({
      type: "shell_output",
      exitCode: 0,
      output: "hello world\n",
    });
  });

  it("returns parsed NDJSON lines for failed cron_shell log", async () => {
    insertTask(db, makeTask({ linearIssueId: "SHELL-LOG-3" }));
    const invId = insertInvocation(db, {
      linearIssueId: "SHELL-LOG-3",
      startedAt: now(),
      status: "failed",
    });
    const logFile = join(tmpLogDir, `${invId}.ndjson`);
    const entry = {
      type: "shell_output",
      exitCode: 1,
      timedOut: false,
      output: "command not found\n",
      timestamp: now(),
    };
    writeFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    updateInvocation(db, invId, { logPath: logFile });

    const res = await app.request(`/api/invocations/${invId}/logs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ type: "shell_output", exitCode: 1 });
  });
});
