// ---------------------------------------------------------------------------
// Phase 3 UI Dashboard - API endpoint tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertTask,
  insertInvocation,
  insertBudgetEvent,
} from "../src/db/queries.js";
import { orcaEvents } from "../src/events.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
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
    appendSystemPrompt: "",
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
