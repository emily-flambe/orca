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
import { createReadStream, readFileSync, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
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
  // GET /api/invocations/:id/logs
  // -----------------------------------------------------------------------
  app.get("/api/invocations/:id/logs", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid invocation id" }, 400);
    }

    const inv = getInvocation(db, id);
    if (!inv) {
      return c.json({ error: "invocation not found" }, 404);
    }

    if (!inv.logPath || !existsSync(inv.logPath)) {
      return c.json({ error: "log file not found" }, 404);
    }
    const logPath: string = inv.logPath;

    // For completed/failed/timed_out invocations, return the full log as JSON array.
    if (inv.status !== "running") {
      const lines: unknown[] = [];
      const rl = createInterface({ input: createReadStream(logPath) });
      for await (const line of rl) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          // skip non-JSON lines
        }
      }
      return c.json({ lines });
    }

    // For running invocations, stream via SSE with file tailing.
    return streamSSE(c, async (stream) => {
      let bytesRead = 0;
      let aborted = false;
      // Buffer for incomplete last line from previous poll.
      let partialLine = "";

      function cleanup() {
        aborted = true;
        clearInterval(poll);
        clearInterval(keepAlive);
      }

      /** Read raw bytes from bytesRead, split on newlines, emit complete lines,
       *  and carry any trailing partial line to the next poll. */
      function readNewLines(): string[] {
        const stat = statSync(logPath);
        if (stat.size <= bytesRead) return [];

        const buf = readFileSync(logPath).subarray(bytesRead);
        const raw = partialLine + buf.toString("utf8");
        const segments = raw.split("\n");

        // Last segment is either empty (if data ends with \n) or a partial line.
        partialLine = segments.pop() ?? "";
        bytesRead = stat.size - Buffer.byteLength(partialLine, "utf8");

        return segments.filter((s) => s.length > 0);
      }

      // Read existing content first.
      const initialRl = createInterface({ input: createReadStream(logPath) });
      for await (const line of initialRl) {
        if (aborted) return;
        try {
          JSON.parse(line); // validate JSON
          await stream.writeSSE({ event: "log", data: line });
        } catch {
          // skip non-JSON lines
        }
      }
      bytesRead = statSync(logPath).size;

      // Poll for new content and check invocation status.
      const poll = setInterval(async () => {
        if (aborted) return;

        try {
          const newLines = readNewLines();
          for (const line of newLines) {
            if (aborted) return;
            try {
              JSON.parse(line); // validate JSON
              await stream.writeSSE({ event: "log", data: line });
            } catch {
              // skip non-JSON lines
            }
          }

          // Check if the invocation is still running.
          const current = getInvocation(db, id);
          if (!current || current.status !== "running") {
            await stream.writeSSE({ event: "done", data: "{}" });
            cleanup();
          }
        } catch {
          // File may have been deleted or become inaccessible; stop.
          cleanup();
        }
      }, 500);

      // Keep-alive ping every 15s.
      const keepAlive = setInterval(() => {
        if (aborted) return;
        try {
          stream.writeSSE({ event: "ping", data: "" });
        } catch {
          cleanup();
        }
      }, 15_000);

      stream.onAbort(() => {
        cleanup();
      });

      // Block until aborted.
      await new Promise(() => {});
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
