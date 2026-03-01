import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import {
  getAllTasks,
  getTask,
  getInvocation,
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
  syncTasks: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveLogPath(logPath: string | null, invocationId: number): string {
  if (logPath) {
    return isAbsolute(logPath) ? logPath : join(process.cwd(), logPath);
  }
  return join(process.cwd(), "logs", `${invocationId}.ndjson`);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createApiRoutes(deps: ApiDeps): Hono {
  const { db, config, syncTasks } = deps;
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
  // GET /api/invocations/:id/logs
  // For running invocations: SSE stream, tailing the file for new lines.
  // For completed/failed: return full file as JSON array.
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
    const logFile = resolveLogPath(invocation.logPath, id);

    if (!existsSync(logFile)) {
      return c.json({ error: "log file not found" }, 404);
    }

    // For completed invocations, return full file as JSON
    if (invocation.status !== "running") {
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
    }

    // For running invocations, stream via SSE
    return streamSSE(c, async (stream) => {
      let offset = 0;
      let aborted = false;

      // Send new lines from the file starting at byte offset
      const sendNewLines = () => {
        if (aborted) return;
        let buf: Buffer;
        try {
          buf = readFileSync(logFile);
        } catch {
          return; // file may have been removed
        }
        if (buf.length <= offset) return;

        const chunk = buf.subarray(offset).toString("utf-8");
        offset = buf.length;

        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line); // validate JSON
            stream.writeSSE({ event: "log", data: line });
          } catch {
            // skip non-JSON lines
          }
        }
      };

      // Initial send of existing content
      sendNewLines();

      // Poll for new lines every 500ms
      const poll = setInterval(() => {
        if (aborted) {
          clearInterval(poll);
          return;
        }

        // Check if invocation is still running
        const current = getInvocation(db, id);
        if (!current || current.status !== "running") {
          // Send any final lines
          sendNewLines();
          try {
            stream.writeSSE({ event: "done", data: "{}" });
          } catch { /* connection closed */ }
          clearInterval(poll);
          return;
        }

        sendNewLines();
      }, 500);

      // Keep-alive ping every 15s
      const keepAlive = setInterval(() => {
        if (aborted) {
          clearInterval(keepAlive);
          return;
        }
        try {
          stream.writeSSE({ event: "ping", data: "" });
        } catch { /* connection closed */ }
      }, 15_000);

      stream.onAbort(() => {
        aborted = true;
        clearInterval(poll);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
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
