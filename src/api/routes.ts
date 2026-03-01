import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient } from "../linear/client.js";
import type { WorkflowStateMap } from "../linear/client.js";
import {
  getAllTasks,
  getTask,
  getInvocation,
  getInvocationsByTask,
  getRunningInvocations,
  countActiveSessions,
  sumCostInWindow,
  updateInvocation,
  updateTaskStatus,
  updateTaskFields,
} from "../db/queries.js";
import { orcaEvents, emitTaskUpdated, emitInvocationCompleted } from "../events.js";
import { activeHandles } from "../scheduler/index.js";
import { killSession } from "../runner/index.js";
import { writeBackStatus } from "../linear/sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiDeps {
  db: OrcaDb;
  config: OrcaConfig;
  syncTasks: () => Promise<number>;
  client: LinearClient;
  stateMap: WorkflowStateMap;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createApiRoutes(deps: ApiDeps): Hono {
  const { db, config, syncTasks, client, stateMap } = deps;
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
    // Attach invocation count so the frontend can filter out done tasks with no history
    const withCounts = tasks.map((t) => ({
      ...t,
      invocationCount: getInvocationsByTask(db, t.linearIssueId).length,
    }));
    return c.json(withCounts);
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
  // GET /api/invocations/:id/logs
  // -----------------------------------------------------------------------
  app.get("/api/invocations/:id/logs", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid invocation id" }, 400);
    }

    const invocation = getInvocation(db, id);
    if (!invocation) {
      return c.json({ error: "invocation not found" }, 404);
    }

    // Resolve log file path: stored as "logs/123.ndjson" (relative) or absolute
    let logFile: string;
    if (invocation.logPath) {
      logFile = isAbsolute(invocation.logPath)
        ? invocation.logPath
        : join(process.cwd(), invocation.logPath);
    } else {
      // Fallback: derive from invocation id
      logFile = join(process.cwd(), "logs", `${id}.ndjson`);
    }

    if (!existsSync(logFile)) {
      return c.json({ error: "log file not found" }, 404);
    }

    const raw = readFileSync(logFile, "utf-8");
    const lines: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // skip non-JSON lines
      }
    }

    return c.json({ lines });
  });

  // -----------------------------------------------------------------------
  // POST /api/invocations/:id/abort
  // -----------------------------------------------------------------------
  app.post("/api/invocations/:id/abort", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid invocation id" }, 400);
    }

    const invocation = getInvocation(db, id);
    if (!invocation) {
      return c.json({ error: "invocation not found" }, 404);
    }

    if (invocation.status !== "running") {
      return c.json({ error: `invocation is "${invocation.status}", not running` }, 409);
    }

    // Kill the Claude session if a handle exists
    const handle = activeHandles.get(id);
    if (handle) {
      try {
        await killSession(handle);
      } catch {
        // Process may already be dead — that's fine
      }
      activeHandles.delete(id);
    }

    const now = new Date().toISOString();

    // Mark invocation as failed
    updateInvocation(db, id, {
      status: "failed",
      endedAt: now,
      outputSummary: "aborted by user",
    });

    // Reset task to ready with zeroed counters
    const taskId = invocation.linearIssueId;
    updateTaskStatus(db, taskId, "ready");
    updateTaskFields(db, taskId, { retryCount: 0, reviewCycleCount: 0 });

    emitTaskUpdated(getTask(db, taskId)!);
    emitInvocationCompleted({
      taskId,
      invocationId: id,
      status: "failed",
      costUsd: 0,
    });

    // Write back Linear state to "Todo"
    writeBackStatus(client, taskId, "retry", stateMap).catch(() => {
      // Best-effort — don't fail the abort if Linear write-back fails
    });

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/tasks/:id/status
  // -----------------------------------------------------------------------
  app.post("/api/tasks/:id/status", async (c) => {
    const taskId = c.req.param("id");
    let body: { status?: string };
    try {
      body = await c.req.json<{ status?: string }>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const newStatus = body.status;

    if (newStatus !== "backlog" && newStatus !== "ready" && newStatus !== "done") {
      return c.json({ error: "status must be one of: backlog, ready, done" }, 400);
    }

    const task = getTask(db, taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }

    if (task.orcaStatus === newStatus) {
      return c.json({ error: `task is already "${newStatus}"` }, 409);
    }

    // Kill running session if task is active
    if (task.orcaStatus === "running" || task.orcaStatus === "dispatched" || task.orcaStatus === "in_review") {
      const runningInvocations = getRunningInvocations(db);
      for (const [invId, handle] of activeHandles) {
        const matchingInv = runningInvocations.find(
          (inv) => inv.linearIssueId === taskId && inv.id === invId,
        );
        if (matchingInv) {
          try {
            await killSession(handle);
          } catch {
            // Process may already be dead
          }
          updateInvocation(db, invId, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: `aborted by status change to ${newStatus}`,
          });
          activeHandles.delete(invId);
          emitInvocationCompleted({
            taskId,
            invocationId: invId,
            status: "failed",
            costUsd: 0,
          });
          break;
        }
      }
    }

    // Update DB
    if (newStatus === "done") {
      updateTaskStatus(db, taskId, "done");
    } else {
      updateTaskFields(db, taskId, {
        orcaStatus: newStatus,
        retryCount: 0,
        reviewCycleCount: 0,
      });
    }

    emitTaskUpdated(getTask(db, taskId)!);

    // Write back to Linear
    const linearTransition = newStatus === "ready" ? "retry" : newStatus;
    writeBackStatus(client, taskId, linearTransition, stateMap).catch(() => {});

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/tasks/:id/retry
  // -----------------------------------------------------------------------
  app.post("/api/tasks/:id/retry", (c) => {
    const taskId = c.req.param("id");
    const task = getTask(db, taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }

    if (task.orcaStatus !== "failed") {
      return c.json({ error: `task is "${task.orcaStatus}", not failed` }, 409);
    }

    // Reset to ready with fresh retry/review counters
    updateTaskStatus(db, taskId, "ready");
    updateTaskFields(db, taskId, { retryCount: 0, reviewCycleCount: 0 });

    emitTaskUpdated(getTask(db, taskId)!);

    // Write back "Todo" to Linear
    writeBackStatus(client, taskId, "retry", stateMap).catch(() => {});

    // Post comment to Linear
    client.createComment(taskId, "Manually retried from Orca dashboard").catch(() => {});

    return c.json({ ok: true });
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
