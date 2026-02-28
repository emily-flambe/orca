import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import {
  getAllTasks,
  getTask,
  getInvocationsByTask,
  getRunningInvocations,
  countActiveSessions,
  sumCostInWindow,
} from "../db/queries.js";
import { orcaEvents } from "../events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiDeps {
  db: OrcaDb;
  config: OrcaConfig;
  dispatchTask: (taskId: string) => Promise<number>;
  syncTasks: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createApiRoutes(deps: ApiDeps): Hono {
  const { db, config, dispatchTask, syncTasks } = deps;
  const app = new Hono();

  // -----------------------------------------------------------------------
  // GET /api/tasks
  // -----------------------------------------------------------------------
  app.get("/api/tasks", (c) => {
    const tasks = getAllTasks(db);
    // Sort by priority ASC then createdAt ASC
    tasks.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
    return c.json(tasks);
  });

  // -----------------------------------------------------------------------
  // GET /api/tasks/:id
  // -----------------------------------------------------------------------
  app.get("/api/tasks/:id", (c) => {
    const taskId = c.req.param("id");
    const task = getTask(db, taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    const invocations = getInvocationsByTask(db, taskId);
    return c.json({ ...task, invocations });
  });

  // -----------------------------------------------------------------------
  // POST /api/tasks/:id/dispatch
  // -----------------------------------------------------------------------
  app.post("/api/tasks/:id/dispatch", async (c) => {
    const taskId = c.req.param("id");
    const task = getTask(db, taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }
    if (task.orcaStatus === "running" || task.orcaStatus === "dispatched") {
      return c.json({ error: "task is already running" }, 400);
    }

    try {
      const invocationId = await dispatchTask(taskId);
      return c.json({ invocationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/sync
  // -----------------------------------------------------------------------
  app.post("/api/sync", async (c) => {
    try {
      const synced = await syncTasks();
      return c.json({ synced });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/status
  // -----------------------------------------------------------------------
  app.get("/api/status", (c) => {
    const activeSessions = countActiveSessions(db);
    const running = getRunningInvocations(db);
    const activeTaskIds = running.map((inv) => inv.linearIssueId);
    const allTasks = getAllTasks(db);
    const queuedTasks = allTasks.filter((t) => t.orcaStatus === "ready").length;

    const windowStart = new Date(
      Date.now() - config.budgetWindowHours * 60 * 60 * 1000,
    ).toISOString();
    const costInWindow = sumCostInWindow(db, windowStart);

    return c.json({
      activeSessions,
      activeTaskIds,
      queuedTasks,
      costInWindow,
      budgetLimit: config.budgetMaxCostUsd,
      budgetWindowHours: config.budgetWindowHours,
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/events (SSE)
  // -----------------------------------------------------------------------
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const onTaskUpdated = (data: unknown) => {
        try {
          stream.writeSSE({ event: "task:updated", data: JSON.stringify(data) });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onInvocationStarted = (data: unknown) => {
        try {
          stream.writeSSE({ event: "invocation:started", data: JSON.stringify(data) });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onInvocationCompleted = (data: unknown) => {
        try {
          stream.writeSSE({ event: "invocation:completed", data: JSON.stringify(data) });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onStatusUpdated = (data: unknown) => {
        try {
          stream.writeSSE({ event: "status:updated", data: JSON.stringify(data) });
        } catch {
          // Connection likely closed; ignore
        }
      };

      orcaEvents.on("task:updated", onTaskUpdated);
      orcaEvents.on("invocation:started", onInvocationStarted);
      orcaEvents.on("invocation:completed", onInvocationCompleted);
      orcaEvents.on("status:updated", onStatusUpdated);

      // Keep-alive ping every 30s
      const keepAlive = setInterval(() => {
        try {
          stream.writeSSE({ event: "ping", data: "" });
        } catch {
          // Connection likely closed; ignore
        }
      }, 30_000);

      // Clean up on abort
      stream.onAbort(() => {
        clearInterval(keepAlive);
        orcaEvents.off("task:updated", onTaskUpdated);
        orcaEvents.off("invocation:started", onInvocationStarted);
        orcaEvents.off("invocation:completed", onInvocationCompleted);
        orcaEvents.off("status:updated", onStatusUpdated);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  return app;
}
