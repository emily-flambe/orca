import { readFileSync, existsSync, statSync } from "node:fs";
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
  getAllInvocations,
  getAllBudgetEvents,
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
      concurrencyCap: config.concurrencyCap,
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/config
  // -----------------------------------------------------------------------
  app.post("/api/config", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if ("concurrencyCap" in body) {
      const val = body.concurrencyCap;
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
        return c.json({ error: "concurrencyCap must be a positive integer" }, 400);
      }
      config.concurrencyCap = val;
    }

    return c.json({ ok: true, concurrencyCap: config.concurrencyCap });
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

  // -----------------------------------------------------------------------
  // GET /api/logs/system
  // -----------------------------------------------------------------------
  app.get("/api/logs/system", (c) => {
    const linesParam = c.req.query("lines");
    const search = c.req.query("search");
    const level = c.req.query("level");

    const maxLines = linesParam ? parseInt(linesParam, 10) : 200;
    if (Number.isNaN(maxLines) || maxLines < 1) {
      return c.json({ error: "lines must be a positive integer" }, 400);
    }

    const logPath = join(process.cwd(), "orca.log");
    if (!existsSync(logPath)) {
      return c.json({ lines: [], totalLines: 0 });
    }

    const raw = readFileSync(logPath, "utf-8");
    const allLines = raw.split("\n").filter((l) => l.length > 0);

    let filtered = allLines;

    if (level) {
      const tag = `[orca/${level}]`;
      filtered = filtered.filter((l) => l.includes(tag));
    }

    if (search) {
      filtered = filtered.filter((l) => l.includes(search));
    }

    const totalLines = filtered.length;
    const sliced = filtered.slice(-maxLines);

    return c.json({ lines: sliced, totalLines });
  });

  // -----------------------------------------------------------------------
  // GET /api/metrics
  // -----------------------------------------------------------------------
  app.get("/api/metrics", (c) => {
    const allTasks = getAllTasks(db);
    const allInvocs = getAllInvocations(db);
    const allBudget = getAllBudgetEvents(db);

    // tasksByStatus: count tasks grouped by orcaStatus
    const tasksByStatus: Record<string, number> = {};
    for (const t of allTasks) {
      tasksByStatus[t.orcaStatus] = (tasksByStatus[t.orcaStatus] ?? 0) + 1;
    }

    // Invocation counts
    const totalInvocations = allInvocs.length;
    const completedInvocations = allInvocs.filter((i) => i.status === "completed").length;
    const failedInvocations = allInvocs.filter((i) => i.status === "failed").length;
    const timedOutInvocations = allInvocs.filter((i) => i.status === "timed_out").length;

    // Average session duration (completed invocations with both timestamps)
    const completedWithTimes = allInvocs.filter(
      (i) => i.status === "completed" && i.startedAt && i.endedAt,
    );
    let avgSessionDurationSec = 0;
    if (completedWithTimes.length > 0) {
      const totalSec = completedWithTimes.reduce((acc, i) => {
        const start = new Date(i.startedAt).getTime();
        const end = new Date(i.endedAt!).getTime();
        return acc + (end - start) / 1000;
      }, 0);
      avgSessionDurationSec = totalSec / completedWithTimes.length;
    }

    // Cost metrics from budget events
    const totalCost = allBudget.reduce((acc, e) => acc + e.costUsd, 0);

    // Average cost per session (invocations that have a cost)
    const invocationsWithCost = allInvocs.filter((i) => i.costUsd != null && i.costUsd > 0);
    const avgCostPerSession =
      invocationsWithCost.length > 0
        ? invocationsWithCost.reduce((acc, i) => acc + (i.costUsd ?? 0), 0) /
          invocationsWithCost.length
        : 0;

    // costTimeSeries: daily cost aggregation from budget_events
    const costByDate: Record<string, number> = {};
    for (const e of allBudget) {
      const date = e.recordedAt.slice(0, 10); // YYYY-MM-DD
      costByDate[date] = (costByDate[date] ?? 0) + e.costUsd;
    }
    const costTimeSeries = Object.entries(costByDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cost]) => ({ date, cost }));

    // recentErrors: group failed/timed_out invocations by outputSummary
    const errorInvocs = allInvocs.filter(
      (i) => (i.status === "failed" || i.status === "timed_out") && i.outputSummary,
    );
    const errorMap: Record<
      string,
      { taskId: string; summary: string; count: number; lastSeen: string }
    > = {};
    for (const inv of errorInvocs) {
      const key = inv.outputSummary!;
      if (!errorMap[key]) {
        errorMap[key] = {
          taskId: inv.linearIssueId,
          summary: key,
          count: 0,
          lastSeen: inv.endedAt ?? inv.startedAt,
        };
      }
      errorMap[key].count += 1;
      const ts = inv.endedAt ?? inv.startedAt;
      if (ts > errorMap[key].lastSeen) {
        errorMap[key].lastSeen = ts;
      }
    }
    const recentErrors = Object.values(errorMap).sort((a, b) =>
      b.lastSeen.localeCompare(a.lastSeen),
    );

    // throughput: daily completion counts from invocations by endedAt
    const throughputMap: Record<string, { completed: number; failed: number }> = {};
    for (const inv of allInvocs) {
      if (!inv.endedAt) continue;
      const date = inv.endedAt.slice(0, 10);
      if (!throughputMap[date]) {
        throughputMap[date] = { completed: 0, failed: 0 };
      }
      if (inv.status === "completed") {
        throughputMap[date].completed += 1;
      } else if (inv.status === "failed" || inv.status === "timed_out") {
        throughputMap[date].failed += 1;
      }
    }
    const throughput = Object.entries(throughputMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }));

    return c.json({
      tasksByStatus,
      totalInvocations,
      completedInvocations,
      failedInvocations,
      timedOutInvocations,
      avgSessionDurationSec,
      avgCostPerSession,
      totalCost,
      costTimeSeries,
      recentErrors,
      throughput,
    });
  });

  return app;
}
