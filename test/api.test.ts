// ---------------------------------------------------------------------------
// Phase 3 UI Dashboard - API endpoint tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
  getTask,
} from "../src/db/queries.js";
import { orcaEvents } from "../src/events.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { WorkflowStateMap } from "../src/linear/client.js";
import type { Hono } from "hono";

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
    schedulerIntervalSec: 10,
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
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
  });

  it("returns empty array when no tasks exist", async () => {
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns tasks sorted by priority ASC then createdAt ASC", async () => {
    insertTask(db, makeTask({
      linearIssueId: "LOW-PRIO",
      priority: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    insertTask(db, makeTask({
      linearIssueId: "HIGH-PRIO",
      priority: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    insertTask(db, makeTask({
      linearIssueId: "HIGH-PRIO-EARLIER",
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const res = await app.request("/api/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(3);
    // Priority 1 first (two of them), then priority 3
    expect(body[0].linearIssueId).toBe("HIGH-PRIO-EARLIER"); // prio 1, earlier date
    expect(body[1].linearIssueId).toBe("HIGH-PRIO");          // prio 1, later date
    expect(body[2].linearIssueId).toBe("LOW-PRIO");           // prio 3
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
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
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
      config: makeConfig({ budgetMaxCostUsd: 10.0, budgetWindowHours: 4 }),
      syncTasks: vi.fn().mockResolvedValue(0),
    });
  });

  it("returns correct status object with all fields", async () => {
    // Insert a ready task
    insertTask(db, makeTask({
      linearIssueId: "READY-1",
      orcaStatus: "ready" as const,
    }));
    // Insert a running task with a running invocation
    insertTask(db, makeTask({
      linearIssueId: "RUNNING-1",
      orcaStatus: "running" as const,
    }));
    insertInvocation(db, {
      linearIssueId: "RUNNING-1",
      startedAt: now(),
      status: "running",
    });
    // Insert a done task (should not appear in queued or active)
    insertTask(db, makeTask({
      linearIssueId: "DONE-1",
      orcaStatus: "done" as const,
    }));

    // Insert a budget event in the current window
    const invId = insertInvocation(db, {
      linearIssueId: "DONE-1",
      startedAt: now(),
      status: "completed",
    });
    insertBudgetEvent(db, {
      invocationId: invId,
      costUsd: 2.5,
      recordedAt: now(),
    });

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.activeSessions).toBe(1);
    expect(body.activeTaskIds).toEqual(["RUNNING-1"]);
    expect(body.queuedTasks).toBe(1);
    expect(body.costInWindow).toBeCloseTo(2.5);
    expect(body.budgetLimit).toBe(10.0);
    expect(body.budgetWindowHours).toBe(4);
  });
});

describe("GET /api/events (SSE)", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
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
  let writeBackStatusMock: ReturnType<typeof vi.fn>;
  let stateMap: WorkflowStateMap;
  let taskUpdatedSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb(":memory:");
    writeBackStatusMock = vi.fn().mockResolvedValue(undefined);
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
    insertTask(db, makeTask({
      linearIssueId: "T-1",
      orcaStatus: "backlog" as const,
      retryCount: 3,
    }));

    const res = await postStatus("T-1", { status: "ready" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const task = getTask(db, "T-1");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("ready -> done: succeeds", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-2",
      orcaStatus: "ready" as const,
    }));

    const res = await postStatus("T-2", { status: "done" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-2");
    expect(task!.orcaStatus).toBe("done");
  });

  it("done -> backlog: succeeds and resets counters", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-3",
      orcaStatus: "done" as const,
      retryCount: 2,
    }));

    const res = await postStatus("T-3", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-3");
    expect(task!.orcaStatus).toBe("backlog");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("failed -> ready: succeeds (re-queue via status endpoint)", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-4",
      orcaStatus: "failed" as const,
      retryCount: 5,
    }));

    const res = await postStatus("T-4", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-4");
    expect(task!.orcaStatus).toBe("ready");
    expect(task!.retryCount).toBe(0);
  });

  it("failed -> backlog: succeeds", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-5",
      orcaStatus: "failed" as const,
    }));

    const res = await postStatus("T-5", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-5");
    expect(task!.orcaStatus).toBe("backlog");
  });

  it("ready -> backlog: succeeds", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-6",
      orcaStatus: "ready" as const,
    }));

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
    insertTask(db, makeTask({
      linearIssueId: "T-SAME",
      orcaStatus: "ready" as const,
    }));

    const res = await postStatus("T-SAME", { status: "ready" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already");
  });

  it("returns 409 when setting done on already-done task", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-DONE-SAME",
      orcaStatus: "done" as const,
    }));

    const res = await postStatus("T-DONE-SAME", { status: "done" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when setting backlog on already-backlog task", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-BL-SAME",
      orcaStatus: "backlog" as const,
    }));

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
    insertTask(db, makeTask({
      linearIssueId: "T-COUNTERS-1",
      orcaStatus: "failed" as const,
      retryCount: 5,
    }));

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
    insertTask(db, makeTask({
      linearIssueId: "T-COUNTERS-2",
      orcaStatus: "done" as const,
      retryCount: 2,
    }));

    const { updateTaskFields } = await import("../src/db/queries.js");
    updateTaskFields(db, "T-COUNTERS-2", { reviewCycleCount: 4 });

    const res = await postStatus("T-COUNTERS-2", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-COUNTERS-2");
    expect(task!.retryCount).toBe(0);
    expect(task!.reviewCycleCount).toBe(0);
  });

  it("does NOT reset counters when moving to done (uses updateTaskStatus)", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-COUNTERS-3",
      orcaStatus: "ready" as const,
      retryCount: 3,
    }));

    const res = await postStatus("T-COUNTERS-3", { status: "done" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-COUNTERS-3");
    // updateTaskStatus does NOT reset retryCount, so it should remain 3
    expect(task!.retryCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // done -> sets doneAt timestamp
  // -----------------------------------------------------------------------

  it("sets doneAt when moving to done", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-DONEAT",
      orcaStatus: "ready" as const,
    }));

    await postStatus("T-DONEAT", { status: "done" });

    const task = getTask(db, "T-DONEAT");
    expect(task!.doneAt).not.toBeNull();
  });

  it("clears doneAt when moving from done to backlog", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-DONEAT-CLEAR",
      orcaStatus: "done" as const,
    }));
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
    insertTask(db, makeTask({
      linearIssueId: "T-EVENT",
      orcaStatus: "backlog" as const,
    }));

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
    insertTask(db, makeTask({
      linearIssueId: "T-NO-EVENT",
      orcaStatus: "ready" as const,
    }));

    await postStatus("T-NO-EVENT", { status: "ready" });
    expect(taskUpdatedSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Edge case: moving from active states (running/dispatched/in_review)
  // -----------------------------------------------------------------------

  it("running -> done: succeeds (kills session logic does not crash without active handles)", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-RUNNING",
      orcaStatus: "running" as const,
    }));
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

  it("dispatched -> backlog: succeeds", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-DISPATCHED",
      orcaStatus: "dispatched" as const,
    }));

    const res = await postStatus("T-DISPATCHED", { status: "backlog" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-DISPATCHED");
    expect(task!.orcaStatus).toBe("backlog");
  });

  it("in_review -> ready: succeeds", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-REVIEW",
      orcaStatus: "in_review" as const,
    }));

    const res = await postStatus("T-REVIEW", { status: "ready" });
    expect(res.status).toBe(200);

    const task = getTask(db, "T-REVIEW");
    expect(task!.orcaStatus).toBe("ready");
  });

  // -----------------------------------------------------------------------
  // Edge case: extra fields in body should be ignored
  // -----------------------------------------------------------------------

  it("ignores extra fields in request body", async () => {
    insertTask(db, makeTask({
      linearIssueId: "T-EXTRA",
      orcaStatus: "backlog" as const,
    }));

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

  it("rejects status='failed' (not an allowed target)", async () => {
    insertTask(db, makeTask({ linearIssueId: "T-FAILED-TARGET" }));

    const res = await postStatus("T-FAILED-TARGET", { status: "failed" });
    expect(res.status).toBe(400);
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
// GET /api/logs  (observability — log viewer)
// ---------------------------------------------------------------------------

describe("GET /api/logs", () => {
  let db: OrcaDb;
  let app: Hono;
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(async () => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });

    // Create a temp directory and override process.cwd() to point to it
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-test-"));
    originalCwd = process.cwd();
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Clean up temp dir
    const fs = await import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no log file exists", async () => {
    const res = await app.request("/api/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual([]);
    expect(body.totalLines).toBe(0);
    expect(body.matchedLines).toBe(0);
  });

  it("returns log lines from orca.log", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpDir, "orca.log"), "line 1\nline 2\nline 3\n");

    const res = await app.request("/api/logs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual(["line 1", "line 2", "line 3"]);
    expect(body.totalLines).toBe(3);
  });

  it("search filtering works (case-insensitive)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(
      path.join(tmpDir, "orca.log"),
      "INFO: started task\nERROR: something failed\nINFO: completed task\nERROR: another failure\n",
    );

    const res = await app.request("/api/logs?search=error");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(2);
    expect(body.matchedLines).toBe(2);
    expect(body.lines[0]).toContain("ERROR");
    expect(body.lines[1]).toContain("ERROR");
  });

  it("lines param limits output", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const logLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(path.join(tmpDir, "orca.log"), logLines);

    const res = await app.request("/api/logs?lines=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(5);
    // Should be the last 5 lines
    expect(body.lines[0]).toBe("line 46");
    expect(body.lines[4]).toBe("line 50");
  });

  it("lines param is clamped to valid range", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.writeFileSync(path.join(tmpDir, "orca.log"), "only line\n");

    // lines=0 should be clamped to 1
    const res = await app.request("/api/logs?lines=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/metrics  (observability — invocation metrics)
// ---------------------------------------------------------------------------

describe("GET /api/metrics", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
  });

  it("returns correct summary with zero invocations", async () => {
    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary.total).toBe(0);
    expect(body.summary.completed).toBe(0);
    expect(body.summary.failed).toBe(0);
    expect(body.summary.timedOut).toBe(0);
    expect(body.summary.running).toBe(0);
    expect(body.summary.finished).toBe(0);
    expect(body.summary.totalCost).toBe(0);
    expect(body.summary.avgCost).toBe(0);
    expect(body.summary.avgDurationMs).toBe(0);
    expect(body.summary.avgTurns).toBe(0);
    expect(body.daily).toHaveLength(14);
    expect(body.topTasks).toEqual([]);
  });

  it("aggregates mixed statuses correctly", async () => {
    insertTask(db, makeTask({ linearIssueId: "METRICS-1" }));

    insertInvocation(db, {
      linearIssueId: "METRICS-1",
      startedAt: now(),
      endedAt: now(),
      status: "completed",
      costUsd: 0.50,
      numTurns: 10,
    });
    insertInvocation(db, {
      linearIssueId: "METRICS-1",
      startedAt: now(),
      endedAt: now(),
      status: "completed",
      costUsd: 1.50,
      numTurns: 20,
    });
    insertInvocation(db, {
      linearIssueId: "METRICS-1",
      startedAt: now(),
      status: "failed",
      costUsd: 0.25,
    });
    insertInvocation(db, {
      linearIssueId: "METRICS-1",
      startedAt: now(),
      status: "timed_out",
    });
    insertInvocation(db, {
      linearIssueId: "METRICS-1",
      startedAt: now(),
      status: "running",
    });

    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary.total).toBe(5);
    expect(body.summary.completed).toBe(2);
    expect(body.summary.failed).toBe(1);
    expect(body.summary.timedOut).toBe(1);
    expect(body.summary.running).toBe(1);
    expect(body.summary.finished).toBe(4); // completed + failed + timed_out

    // Cost: 0.50 + 1.50 + 0.25 = 2.25, avg = 2.25 / 3
    expect(body.summary.totalCost).toBeCloseTo(2.25);
    expect(body.summary.avgCost).toBeCloseTo(0.75);

    // Turns: only 2 with numTurns, avg = (10 + 20) / 2 = 15
    expect(body.summary.avgTurns).toBeCloseTo(15);
  });

  it("fills in missing days in 14-day daily breakdown", async () => {
    // No invocations — daily should still have 14 entries with zeroes
    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.daily).toHaveLength(14);
    for (const day of body.daily) {
      expect(day.count).toBe(0);
      expect(day.completed).toBe(0);
      expect(day.failed).toBe(0);
      expect(day.totalCost).toBe(0);
      expect(day.avgDurationMs).toBe(0);
    }
  });

  it("daily breakdown includes today's invocations", async () => {
    insertTask(db, makeTask({ linearIssueId: "DAILY-1" }));
    insertInvocation(db, {
      linearIssueId: "DAILY-1",
      startedAt: new Date().toISOString(),
      status: "completed",
      costUsd: 1.0,
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();

    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = body.daily.find((d: { date: string }) => d.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry.count).toBe(1);
    expect(todayEntry.completed).toBe(1);
    expect(todayEntry.totalCost).toBeCloseTo(1.0);
  });

  it("topTasks shows most expensive tasks ordered by cost", async () => {
    insertTask(db, makeTask({ linearIssueId: "EXPENSIVE-1" }));
    insertTask(db, makeTask({ linearIssueId: "EXPENSIVE-2" }));

    insertInvocation(db, {
      linearIssueId: "EXPENSIVE-1",
      startedAt: now(),
      status: "completed",
      costUsd: 5.0,
    });
    insertInvocation(db, {
      linearIssueId: "EXPENSIVE-2",
      startedAt: now(),
      status: "completed",
      costUsd: 10.0,
    });
    insertInvocation(db, {
      linearIssueId: "EXPENSIVE-1",
      startedAt: now(),
      status: "completed",
      costUsd: 3.0,
    });

    const res = await app.request("/api/metrics");
    const body = await res.json();

    expect(body.topTasks).toHaveLength(2);
    // EXPENSIVE-2 has $10, EXPENSIVE-1 has $8 total
    expect(body.topTasks[0].taskId).toBe("EXPENSIVE-2");
    expect(body.topTasks[0].totalCost).toBeCloseTo(10.0);
    expect(body.topTasks[0].invocationCount).toBe(1);
    expect(body.topTasks[1].taskId).toBe("EXPENSIVE-1");
    expect(body.topTasks[1].totalCost).toBeCloseTo(8.0);
    expect(body.topTasks[1].invocationCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/errors  (observability — error aggregation)
// ---------------------------------------------------------------------------

describe("GET /api/errors", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({ db, config: makeConfig(), syncTasks: vi.fn().mockResolvedValue(0) });
  });

  it("returns empty state when no errors exist", async () => {
    const res = await app.request("/api/errors");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patterns).toEqual([]);
    expect(body.recentErrors).toEqual([]);
  });

  it("groups errors by outputSummary pattern", async () => {
    insertTask(db, makeTask({ linearIssueId: "ERR-TASK-1" }));
    insertTask(db, makeTask({ linearIssueId: "ERR-TASK-2" }));

    insertInvocation(db, {
      linearIssueId: "ERR-TASK-1",
      startedAt: "2026-02-28T10:00:00.000Z",
      status: "failed",
      outputSummary: "timeout exceeded",
    });
    insertInvocation(db, {
      linearIssueId: "ERR-TASK-2",
      startedAt: "2026-02-28T11:00:00.000Z",
      status: "failed",
      outputSummary: "timeout exceeded",
    });
    insertInvocation(db, {
      linearIssueId: "ERR-TASK-1",
      startedAt: "2026-02-28T12:00:00.000Z",
      status: "failed",
      outputSummary: "git clone failed",
    });

    const res = await app.request("/api/errors");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Patterns sorted by count descending
    expect(body.patterns).toHaveLength(2);
    expect(body.patterns[0].pattern).toBe("timeout exceeded");
    expect(body.patterns[0].count).toBe(2);
    expect(body.patterns[0].affectedTasks).toContain("ERR-TASK-1");
    expect(body.patterns[0].affectedTasks).toContain("ERR-TASK-2");
    expect(body.patterns[1].pattern).toBe("git clone failed");
    expect(body.patterns[1].count).toBe(1);

    expect(body.recentErrors).toHaveLength(3);
  });

  it("includes timed_out invocations in error results", async () => {
    insertTask(db, makeTask({ linearIssueId: "TO-TASK" }));
    insertInvocation(db, {
      linearIssueId: "TO-TASK",
      startedAt: now(),
      status: "timed_out",
      outputSummary: "session timed out",
    });

    const res = await app.request("/api/errors");
    const body = await res.json();

    expect(body.recentErrors).toHaveLength(1);
    expect(body.recentErrors[0].status).toBe("timed_out");
    expect(body.patterns[0].pattern).toBe("session timed out");
  });

  it("respects the limit parameter", async () => {
    insertTask(db, makeTask({ linearIssueId: "LIMIT-TASK" }));
    for (let i = 0; i < 10; i++) {
      insertInvocation(db, {
        linearIssueId: "LIMIT-TASK",
        startedAt: `2026-02-28T${String(i).padStart(2, "0")}:00:00.000Z`,
        status: "failed",
        outputSummary: `error ${i}`,
      });
    }

    const res = await app.request("/api/errors?limit=3");
    const body = await res.json();

    expect(body.recentErrors).toHaveLength(3);
  });

  it("does not include completed or running invocations", async () => {
    insertTask(db, makeTask({ linearIssueId: "MIX-TASK" }));
    insertInvocation(db, {
      linearIssueId: "MIX-TASK",
      startedAt: now(),
      status: "completed",
      outputSummary: "all good",
    });
    insertInvocation(db, {
      linearIssueId: "MIX-TASK",
      startedAt: now(),
      status: "running",
    });

    const res = await app.request("/api/errors");
    const body = await res.json();

    expect(body.patterns).toEqual([]);
    expect(body.recentErrors).toEqual([]);
  });
});
