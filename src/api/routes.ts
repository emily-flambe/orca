import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type {
  LinearClient,
  LinearIssue,
  WorkflowStateMap,
  ProjectMetadata,
} from "../linear/client.js";
import {
  type Task,
  getAllTasks,
  getTask,
  getInvocation,
  getInvocationsByTask,
  getInvocationCountsByTask,
  getRunningInvocations,
  countActiveSessions,
  sumCostInWindow,
  sumTokensInWindow,
  sumTokensSplitInWindow,
  getEarliestEventInWindow,
  sumTokensInWindowRange,
  budgetWindowStart,
  updateInvocation,
  updateTaskStatus,
  updateTaskFields,
  getInvocationStats,
  getRecentErrors,
  getDailyStats,
  getRecentActivity,
  sumCostInWindowRange,
  getSuccessRate12h,
  getRecentSystemEvents,
  countSystemEventsSince,
  getLastStartup,
  getAllCronSchedules,
  getCronSchedule,
  insertCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  incrementCronRunCount,
  getTasksByCronSchedule,
  getCronRunsForSchedule,
  insertTask,
  deleteTask,
  insertSystemEvent,
} from "../db/queries.js";
import { validateCronExpression, computeNextRunAt } from "../cron/index.js";
import {
  orcaEvents,
  emitTaskUpdated,
  emitInvocationCompleted,
  type InvocationStartedPayload,
  type InvocationCompletedPayload,
  type StatusPayload,
} from "../events.js";
import { activeHandles } from "../session-handles.js";
import { killSession, invocationLogs } from "../runner/index.js";
import { writeBackStatus, findStateByType } from "../linear/sync.js";
import { isDraining, setDraining } from "../deploy.js";

import type { InngestClient } from "../inngest/client.js";
import type { TaskStatus } from "../shared/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("api");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiDeps {
  db: OrcaDb;
  config: OrcaConfig;
  syncTasks: () => Promise<LinearIssue[]>;
  client: LinearClient;
  stateMap: WorkflowStateMap;
  projectMeta: ProjectMetadata[];
  inngest: InngestClient;
}

// ---------------------------------------------------------------------------
// Inngest helpers (fire-and-forget)
// ---------------------------------------------------------------------------

function emitTaskReady(inngest: InngestClient, task: Task): void {
  inngest
    .send({
      name: "task/ready",
      data: {
        linearIssueId: task.linearIssueId,
        repoPath: task.repoPath,
        priority: task.priority,
        projectName: task.projectName ?? null,
        taskType: task.taskType ?? "standard",
        createdAt: task.createdAt,
      },
    })
    .catch((err: unknown) =>
      logger.warn("Inngest task/ready send failed:", err),
    );
}

// ---------------------------------------------------------------------------
// Version — read once at startup, never re-read per request
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const ORCA_VERSION = readPackageVersion();

// ---------------------------------------------------------------------------
// Inngest health check with retry + caching
// ---------------------------------------------------------------------------

let _inngestHealthCache: { value: boolean; expiresAt: number } | null = null;

async function checkInngestHealth(): Promise<boolean> {
  const now = Date.now();
  if (_inngestHealthCache && now < _inngestHealthCache.expiresAt) {
    return _inngestHealthCache.value;
  }

  const inngestBaseUrl =
    process.env["INNGEST_BASE_URL"] ?? "http://localhost:8288";
  const maxAttempts = 3;
  const delayMs = 500;
  const timeoutMs = 1500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(inngestBaseUrl, { signal: controller.signal });
      clearTimeout(timerId);
      if (res.status < 500) {
        _inngestHealthCache = { value: true, expiresAt: now + 10_000 };
        return true;
      }
    } catch {
      // Retry after delay unless this is the last attempt
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  _inngestHealthCache = { value: false, expiresAt: now + 10_000 };
  return false;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createApiRoutes(deps: ApiDeps): Hono {
  const { db, config, syncTasks, client, stateMap, projectMeta, inngest } =
    deps;
  const app = new Hono();

  // -----------------------------------------------------------------------
  // Request logging middleware
  // -----------------------------------------------------------------------
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    logger.debug(`${c.req.method} ${c.req.path} -> ${c.res.status} (${ms}ms)`);
  });

  // -----------------------------------------------------------------------
  // GET /api/version
  // -----------------------------------------------------------------------
  app.get("/api/version", (c) => {
    return c.json({ version: ORCA_VERSION });
  });

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
    const invocationCounts = getInvocationCountsByTask(db);
    const withCounts = tasks.map((t) => ({
      ...t,
      invocationCount: invocationCounts.get(t.linearIssueId) ?? 0,
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
  // GET /api/invocations/running
  // -----------------------------------------------------------------------
  app.get("/api/invocations/running", (c) => {
    const running = getRunningInvocations(db);
    const enriched = running.map((inv) => {
      const task = getTask(db, inv.linearIssueId);
      return { ...inv, agentPrompt: task?.agentPrompt ?? null };
    });
    return c.json(enriched);
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
  // GET /api/invocations/:id/logs/stream (SSE)
  // -----------------------------------------------------------------------
  app.get("/api/invocations/:id/logs/stream", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id))
      return c.json({ error: "invalid invocation id" }, 400);

    const invocation = getInvocation(db, id);
    if (!invocation) return c.json({ error: "invocation not found" }, 404);

    return streamSSE(c, async (stream) => {
      const logState = invocationLogs.get(id);

      if (!logState) {
        // No in-memory state: invocation finished before we connected (or never ran via runner)
        // Signal client to fall back to polling endpoint
        stream.writeSSE({ event: "done", data: "" }).catch(() => {});
        return;
      }

      // Subscribe to live events BEFORE replaying the buffer to eliminate the
      // TOCTOU window where "done" fires between buffer replay and subscription.
      await new Promise<void>((resolve) => {
        let doneSent = false;
        let streamClosed = false;

        const sendDone = () => {
          if (doneSent || streamClosed) return;
          doneSent = true;
          stream.writeSSE({ event: "done", data: "" }).catch(() => {});
        };

        const onLine = (line: string) => {
          if (streamClosed || doneSent) return;
          stream.writeSSE({ event: "log", data: line }).catch(() => {
            streamClosed = true;
            cleanup();
            resolve();
          });
        };

        const onDone = () => {
          sendDone();
          cleanup();
          resolve();
        };

        const cleanup = () => {
          logState.emitter.off("line", onLine);
          logState.emitter.off("done", onDone);
        };

        // Subscribe first — no events can be missed after this point.
        logState.emitter.on("line", onLine);
        logState.emitter.on("done", onDone);

        stream.onAbort(() => {
          streamClosed = true;
          cleanup();
          resolve();
        });

        // Replay buffered lines (snapshot taken after subscription so any new
        // lines arriving during replay go through onLine above).
        const snapshot = [...logState.buffer];
        (async () => {
          for (const line of snapshot) {
            if (streamClosed || doneSent) break;
            try {
              await stream.writeSSE({ event: "log", data: line });
            } catch {
              streamClosed = true;
              cleanup();
              resolve();
              return;
            }
          }
          // If done was set before we subscribed, onDone was never called.
          if (logState.done && !doneSent && !streamClosed) {
            onDone();
          }
        })();
      });
    });
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
      return c.json(
        { error: `invocation is "${invocation.status}", not running` },
        409,
      );
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
    const taskId = invocation.linearIssueId;
    const oldStatus = (getTask(db, taskId)?.orcaStatus ??
      "running") as TaskStatus;

    // Mark invocation as failed
    updateInvocation(db, id, {
      status: "failed",
      endedAt: now,
      outputSummary: "aborted by user",
    });

    // Reset task to ready with zeroed counters
    updateTaskStatus(db, taskId, "ready");
    updateTaskFields(db, taskId, {
      retryCount: 0,
      reviewCycleCount: 0,
      staleSessionRetryCount: 0,
    });

    emitTaskUpdated(getTask(db, taskId)!);
    emitInvocationCompleted({
      taskId,
      invocationId: id,
      status: "failed",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });

    // Cancel the old Inngest workflow so per-task concurrency unblocks
    inngest
      .send({
        name: "task/cancelled",
        data: {
          linearIssueId: taskId,
          reason: "Aborted by user via invocation abort",
          retryCount: 0,
          previousStatus: oldStatus,
        },
      })
      .catch((err: unknown) =>
        logger.warn("Inngest task/cancelled send failed:", err),
      );

    // Write back Linear state to "Todo"
    writeBackStatus(client, taskId, "retry", stateMap).catch((err) =>
      logger.warn("Linear write-back failed:", err),
    );

    logger.info(`audit: abort invocation=${id} task=${taskId}`);

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/invocations/:id/prompt
  // -----------------------------------------------------------------------
  app.post("/api/invocations/:id/prompt", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid invocation id" }, 400);
    }

    const invocation = getInvocation(db, id);
    if (!invocation) {
      return c.json({ error: "invocation not found" }, 404);
    }

    let body: { prompt?: string };
    try {
      body = await c.req.json<{ prompt?: string }>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
      return c.json({ error: "prompt must be a non-empty string" }, 400);
    }

    updateTaskFields(db, invocation.linearIssueId, {
      agentPrompt: body.prompt.trim(),
    });

    // Audit: log invocation ID only — do NOT log prompt content
    logger.info(`audit: prompt updated invocation=${id}`);

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

    if (
      newStatus !== "backlog" &&
      newStatus !== "ready" &&
      newStatus !== "done" &&
      newStatus !== "failed" &&
      newStatus !== "canceled"
    ) {
      return c.json(
        {
          error:
            "status must be one of: backlog, ready, done, failed, canceled",
        },
        400,
      );
    }

    const task = getTask(db, taskId);
    if (!task) {
      return c.json({ error: "task not found" }, 404);
    }

    if (task.orcaStatus === newStatus) {
      return c.json({ error: `task is already "${newStatus}"` }, 409);
    }

    const oldStatus = task.orcaStatus;

    // Kill running session if task is active
    let sessionKilled = false;
    if (
      task.orcaStatus === "running" ||
      task.orcaStatus === "dispatched" ||
      task.orcaStatus === "in_review"
    ) {
      const runningInvocations = getRunningInvocations(db);
      for (const [invId, handle] of activeHandles) {
        const matchingInv = runningInvocations.find(
          (inv) => inv.linearIssueId === taskId && inv.id === invId,
        );
        if (matchingInv) {
          try {
            await killSession(handle);
            sessionKilled = true;
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
            inputTokens: 0,
            outputTokens: 0,
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
        staleSessionRetryCount: 0,
      });
    }

    emitTaskUpdated(getTask(db, taskId)!);

    // Write back to Linear
    const linearTransition =
      newStatus === "ready"
        ? "retry"
        : newStatus === "failed" || newStatus === "canceled"
          ? "failed_permanent"
          : newStatus;
    writeBackStatus(client, taskId, linearTransition, stateMap).catch((err) =>
      logger.warn("Linear write-back failed:", err),
    );

    // Emit Inngest events
    const updatedTask = getTask(db, taskId);
    if (updatedTask) {
      if (newStatus === "ready") {
        emitTaskReady(inngest, updatedTask);
      } else if (sessionKilled) {
        inngest
          .send({
            name: "task/cancelled",
            data: {
              linearIssueId: taskId,
              reason: `Status changed to ${newStatus} via API`,
              retryCount: updatedTask.retryCount,
              previousStatus: oldStatus as TaskStatus,
            },
          })
          .catch((err: unknown) =>
            logger.warn("Inngest task/cancelled send failed:", err),
          );
      }
    }

    logger.info(
      `audit: status change task=${taskId} ${oldStatus} -> ${newStatus} sessionKilled=${sessionKilled}`,
    );

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
    updateTaskFields(db, taskId, {
      retryCount: 0,
      reviewCycleCount: 0,
      staleSessionRetryCount: 0,
    });

    emitTaskUpdated(getTask(db, taskId)!);

    // Write back "Todo" to Linear
    writeBackStatus(client, taskId, "retry", stateMap).catch((err) =>
      logger.warn("Linear write-back failed:", err),
    );

    // Post comment to Linear
    client
      .createComment(taskId, "Manually retried from Orca dashboard")
      .catch((err) => logger.warn("Linear comment failed:", err));

    // Emit Inngest event
    const retriedTask = getTask(db, taskId);
    if (retriedTask) {
      emitTaskReady(inngest, retriedTask);
    }

    logger.info(`audit: retry task=${taskId}`);

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/sync
  // -----------------------------------------------------------------------
  app.post("/api/sync", async (c) => {
    try {
      const syncedIssues = await syncTasks();
      return c.json({ synced: syncedIssues.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/status
  // -----------------------------------------------------------------------
  app.get("/api/status", async (c) => {
    const activeSessions = countActiveSessions(db);
    const running = getRunningInvocations(db);
    const activeTaskIds = running.map((inv) => inv.linearIssueId);
    const allTasks = getAllTasks(db);
    const queuedTasks = allTasks.filter(
      (t) =>
        t.orcaStatus === "ready" ||
        t.orcaStatus === "in_review" ||
        t.orcaStatus === "changes_requested",
    ).length;
    const windowStart = budgetWindowStart(config.budgetWindowHours);
    const costInWindow = sumCostInWindow(db, windowStart);
    const tokensInWindow = sumTokensInWindow(db, windowStart);
    const tokensSplit = sumTokensSplitInWindow(db, windowStart);
    const earliestEvent = getEarliestEventInWindow(db, windowStart);

    // Compute burn rate ($/hr) and tokens per minute
    let burnRatePerHour: number | null = null;
    let tokensPerMinute: number | null = null;
    if (earliestEvent && costInWindow > 0) {
      const earliestMs = new Date(earliestEvent).getTime();
      const nowMs = Date.now();
      const elapsedHours = (nowMs - earliestMs) / (1000 * 60 * 60);
      if (elapsedHours > 0) {
        burnRatePerHour = costInWindow / elapsedHours;
        const elapsedMinutes = elapsedHours * 60;
        tokensPerMinute = tokensInWindow / elapsedMinutes;
      }
    }

    // Check Inngest connectivity with retry/backoff and caching.
    const inngestReachable = await checkInngestHealth();

    const draining = isDraining();
    return c.json({
      activeSessions,
      activeTaskIds,
      queuedTasks,
      costInWindow,
      budgetLimit: config.budgetMaxCostUsd,
      budgetPctUsed:
        config.budgetMaxCostUsd > 0
          ? (costInWindow / config.budgetMaxCostUsd) * 100
          : 0,
      budgetWindowHours: config.budgetWindowHours,
      tokensInWindow,
      tokenBudgetLimit: config.budgetMaxTokens,
      concurrencyCap: config.concurrencyCap,
      implementModel: config.implementModel,
      reviewModel: config.reviewModel,
      fixModel: config.fixModel,
      draining,
      drainSessionCount: draining ? activeSessions : 0,
      burnRatePerHour,
      tokensPerMinute,
      inputTokensInWindow: tokensSplit.input,
      outputTokensInWindow: tokensSplit.output,
      inngestReachable,
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/health
  // -----------------------------------------------------------------------
  app.get("/api/health", async (c) => {
    // DB check: lightweight SELECT 1, then read dependent fields
    let dbOk = true;
    let lastStartup: ReturnType<typeof getLastStartup> = undefined;
    let costInWindow = 0;
    let activeSessions = 0;
    try {
      db.$client.prepare("SELECT 1").get();
      lastStartup = getLastStartup(db);
      const windowStart = budgetWindowStart(config.budgetWindowHours);
      costInWindow = sumCostInWindow(db, windowStart);
      activeSessions = countActiveSessions(db);
    } catch {
      dbOk = false;
    }

    // Uptime
    const now = Date.now();
    const uptimeSeconds = lastStartup
      ? Math.floor((now - new Date(lastStartup.createdAt).getTime()) / 1000)
      : null;

    // Budget check
    const budgetExhausted = costInWindow >= config.budgetMaxCostUsd;

    // Draining
    const draining = isDraining();

    // Inngest check
    const inngestOk = await checkInngestHealth();

    // Determine overall status
    let status: "healthy" | "degraded" | "draining";
    if (!dbOk || budgetExhausted) {
      status = "degraded";
    } else if (draining) {
      status = "draining";
    } else {
      status = "healthy";
    }

    const body = {
      status,
      version: ORCA_VERSION,
      uptime: uptimeSeconds,
      draining,
      activeSessions,
      budgetExhausted,
      checks: {
        db: dbOk ? "ok" : "error",
        inngest: inngestOk ? "ok" : "unreachable",
      },
    };

    // 503 when budget exhausted or DB unreachable
    const httpStatus = !dbOk || budgetExhausted ? 503 : 200;
    return c.json(body, httpStatus);
  });

  // -----------------------------------------------------------------------
  // GET /api/metrics
  // -----------------------------------------------------------------------
  app.get("/api/metrics", (c) => {
    const now = new Date();
    const oneDayAgo = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const sevenDaysAgo = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    // Uptime
    const lastStartup = getLastStartup(db);
    const uptimeSeconds = lastStartup
      ? Math.floor(
          (now.getTime() - new Date(lastStartup.createdAt).getTime()) / 1000,
        )
      : null;

    // Task throughput
    const completedToday = countSystemEventsSince(
      db,
      oneDayAgo,
      "task_completed",
    );
    const failedToday = countSystemEventsSince(db, oneDayAgo, "task_failed");
    const completed7d = countSystemEventsSince(
      db,
      sevenDaysAgo,
      "task_completed",
    );
    const failed7d = countSystemEventsSince(db, sevenDaysAgo, "task_failed");

    // Error rate
    const errorsToday = countSystemEventsSince(db, oneDayAgo, "error");
    const errorsLastHour = countSystemEventsSince(db, oneHourAgo, "error");

    // Restart count (startups in last 24h — first one is normal, extras are restarts)
    const startupsToday = countSystemEventsSince(db, oneDayAgo, "startup");
    const restartsToday = Math.max(0, startupsToday - 1);

    // Current queue state
    const allTasksForMetrics = getAllTasks(db);
    const queueDepth = allTasksForMetrics.filter(
      (t) => t.orcaStatus === "ready",
    ).length;
    const runningCount = allTasksForMetrics.filter(
      (t) => t.orcaStatus === "running",
    ).length;
    const inReviewCount = allTasksForMetrics.filter(
      (t) => t.orcaStatus === "in_review",
    ).length;

    // Budget
    const metricsWindowStart = budgetWindowStart(config.budgetWindowHours);
    const costInWindowMetrics = sumCostInWindow(db, metricsWindowStart);

    // Recent events for timeline
    const recentEvents = getRecentSystemEvents(db, 50);

    // Legacy fields (backward-compat with dashboard)
    const tasksByStatus: Record<string, number> = {};
    for (const task of allTasksForMetrics) {
      tasksByStatus[task.orcaStatus] =
        (tasksByStatus[task.orcaStatus] ?? 0) + 1;
    }
    const invocationStats = getInvocationStats(db);
    const recentErrors = getRecentErrors(db, 20);
    const costLast24h = sumCostInWindow(db, budgetWindowStart(24));
    const costLast7d = sumCostInWindow(db, budgetWindowStart(7 * 24));
    const prev24hStart = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    ).toISOString();
    const prev24hEnd = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    ).toISOString();
    const costPrev24h = sumCostInWindowRange(db, prev24hStart, prev24hEnd);
    const tokensLast24h = sumTokensInWindow(db, budgetWindowStart(24));
    const tokensLast7d = sumTokensInWindow(db, budgetWindowStart(7 * 24));
    const tokensPrev24h = sumTokensInWindowRange(db, prev24hStart, prev24hEnd);
    const dailyStats = getDailyStats(db, 14);
    const recentActivity = getRecentActivity(db, 20);
    const successRate12h = getSuccessRate12h(db);

    return c.json({
      uptime: {
        seconds: uptimeSeconds,
        since: lastStartup?.createdAt ?? null,
        restartsToday,
      },
      throughput: {
        last24h: { completed: completedToday, failed: failedToday },
        last7d: { completed: completed7d, failed: failed7d },
      },
      errors: {
        lastHour: errorsLastHour,
        last24h: errorsToday,
      },
      queue: {
        ready: queueDepth,
        running: runningCount,
        inReview: inReviewCount,
      },
      budget: {
        costInWindow: costInWindowMetrics,
        limit: config.budgetMaxCostUsd,
        windowHours: config.budgetWindowHours,
      },
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        type: e.type,
        message: e.message,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        createdAt: e.createdAt,
      })),
      // Legacy fields (backward-compat with dashboard)
      tasksByStatus,
      invocationStats,
      recentErrors,
      costLast24h,
      costLast7d,
      costPrev24h,
      tokensLast24h,
      tokensLast7d,
      tokensPrev24h,
      dailyStats,
      recentActivity,
      successRate12h,
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

    const configChanges: string[] = [];

    if ("concurrencyCap" in body) {
      const val = body.concurrencyCap;
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
        return c.json(
          { error: "concurrencyCap must be a positive integer" },
          400,
        );
      }
      const oldVal = config.concurrencyCap;
      config.concurrencyCap = val;
      configChanges.push(`concurrencyCap: ${oldVal} -> ${val}`);
    }

    const MODEL_SHORTCUTS = new Set(["opus", "sonnet", "haiku"]);
    for (const field of [
      "implementModel",
      "reviewModel",
      "fixModel",
    ] as const) {
      if (field in body) {
        const val = body[field];
        if (typeof val !== "string" || val.length === 0) {
          return c.json({ error: `${field} must be a non-empty string` }, 400);
        }
        if (!MODEL_SHORTCUTS.has(val) && !val.startsWith("claude-")) {
          return c.json(
            {
              error: `${field} must be one of opus/sonnet/haiku or a full model ID (claude-...)`,
            },
            400,
          );
        }
        const oldVal = config[field];
        config[field] = val;
        configChanges.push(`${field}: ${oldVal} -> ${val}`);
      }
    }

    if ("tokenBudgetLimit" in body) {
      const val = body.tokenBudgetLimit;
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
        return c.json(
          { error: "tokenBudgetLimit must be a positive integer" },
          400,
        );
      }
      const oldVal = config.budgetMaxTokens;
      config.budgetMaxTokens = val;
      configChanges.push(`tokenBudgetLimit: ${oldVal} -> ${val}`);
    }

    if (configChanges.length > 0) {
      logger.info(`audit: config update ${configChanges.join(", ")}`);
    }

    return c.json({
      ok: true,
      concurrencyCap: config.concurrencyCap,
      tokenBudgetLimit: config.budgetMaxTokens,
      implementModel: config.implementModel,
      reviewModel: config.reviewModel,
      fixModel: config.fixModel,
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/logs
  // -----------------------------------------------------------------------
  app.get("/api/logs", (c) => {
    const tailParam = c.req.query("tail");
    const filterParam = c.req.query("filter");
    const tail = tailParam
      ? Math.min(Math.max(parseInt(tailParam, 10) || 200, 1), 5000)
      : 200;

    const logFile = isAbsolute(config.logPath)
      ? config.logPath
      : join(process.cwd(), config.logPath);

    if (!existsSync(logFile)) {
      return c.json({ lines: [], total: 0, sizeBytes: 0 });
    }

    const sizeBytes = statSync(logFile).size;
    const raw = readFileSync(logFile, "utf-8");
    let lines = raw.split("\n").filter((l) => l.length > 0);

    if (filterParam) {
      const lower = filterParam.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(lower));
    }

    const total = lines.length;
    const sliced = lines.slice(-tail);

    return c.json({ lines: sliced, total, sizeBytes });
  });

  // -----------------------------------------------------------------------
  // GET /api/projects
  // -----------------------------------------------------------------------
  app.get("/api/projects", (c) => {
    return c.json(projectMeta.map((p) => ({ id: p.id, name: p.name })));
  });

  // -----------------------------------------------------------------------
  // POST /api/tasks
  // -----------------------------------------------------------------------
  app.post("/api/tasks", async (c) => {
    let body: {
      title?: string;
      description?: string;
      projectId?: string;
      priority?: number;
      status?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (
      !body.title ||
      typeof body.title !== "string" ||
      body.title.trim() === ""
    ) {
      return c.json({ error: "title is required" }, 400);
    }

    if (
      body.status !== undefined &&
      body.status !== "todo" &&
      body.status !== "backlog"
    ) {
      return c.json({ error: "status must be 'todo' or 'backlog'" }, 400);
    }

    // Find team for the given project (or first configured project)
    const targetProjectId = body.projectId ?? config.linearProjectIds[0];
    const project = projectMeta.find((p) => p.id === targetProjectId);
    if (!project || project.teamIds.length === 0) {
      return c.json({ error: "project not found or has no team" }, 400);
    }
    const teamId = project.teamIds[0]!;

    // Resolve state ID from stateMap by type
    let stateId: string | undefined;
    if (body.status === "backlog") {
      stateId = findStateByType(stateMap, "backlog")?.id;
    } else {
      // Default to first "unstarted" state
      stateId = findStateByType(stateMap, "unstarted")?.id;
    }

    // Priority: 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low; validate
    let priority: number | undefined;
    if (body.priority !== undefined) {
      const p = Number(body.priority);
      if (Number.isInteger(p) && p >= 0 && p <= 4) {
        priority = p;
      }
    }

    try {
      const issue = await client.createIssue({
        title: body.title.trim(),
        teamId,
        description: body.description || undefined,
        priority,
        stateId,
        projectId: targetProjectId,
      });

      // Trigger sync so the new ticket appears immediately
      syncTasks().catch((err) =>
        logger.warn("syncTasks failed after task creation:", err),
      );

      logger.info(
        `audit: task created identifier=${issue.identifier} title="${body.title.trim()}"`,
      );

      return c.json({ identifier: issue.identifier, id: issue.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/events (SSE)
  // -----------------------------------------------------------------------
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const onTaskUpdated = (data: Task) => {
        try {
          stream.writeSSE({
            event: "task:updated",
            data: JSON.stringify(data),
          });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onInvocationStarted = (data: InvocationStartedPayload) => {
        try {
          stream.writeSSE({
            event: "invocation:started",
            data: JSON.stringify(data),
          });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onInvocationCompleted = (data: InvocationCompletedPayload) => {
        try {
          stream.writeSSE({
            event: "invocation:completed",
            data: JSON.stringify(data),
          });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onStatusUpdated = (data: StatusPayload) => {
        try {
          stream.writeSSE({
            event: "status:updated",
            data: JSON.stringify(data),
          });
        } catch {
          // Connection likely closed; ignore
        }
      };

      const onTasksRefreshed = () => {
        try {
          stream.writeSSE({ event: "tasks:refreshed", data: "" });
        } catch {
          // Connection likely closed; ignore
        }
      };

      orcaEvents.on("task:updated", onTaskUpdated);
      orcaEvents.on("invocation:started", onInvocationStarted);
      orcaEvents.on("invocation:completed", onInvocationCompleted);
      orcaEvents.on("status:updated", onStatusUpdated);
      orcaEvents.on("tasks:refreshed", onTasksRefreshed);

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
        orcaEvents.off("tasks:refreshed", onTasksRefreshed);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/cron
  // -----------------------------------------------------------------------
  app.get("/api/cron", (c) => {
    const schedules = getAllCronSchedules(db);
    return c.json(schedules);
  });

  // -----------------------------------------------------------------------
  // GET /api/cron/:id
  // -----------------------------------------------------------------------
  app.get("/api/cron/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const schedule = getCronSchedule(db, id);
    if (!schedule) {
      return c.json({ error: "not found" }, 404);
    }
    const allTasks = getTasksByCronSchedule(db, id);
    const recentTasks = allTasks
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 20);
    return c.json({ ...schedule, recentTasks });
  });

  // -----------------------------------------------------------------------
  // GET /api/cron/:id/runs
  // -----------------------------------------------------------------------
  app.get("/api/cron/:id/runs", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const runs = getCronRunsForSchedule(db, id);
    return c.json(runs);
  });

  // -----------------------------------------------------------------------
  // GET /api/cron/:id/tasks
  // -----------------------------------------------------------------------
  app.get("/api/cron/:id/tasks", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const tasks = getTasksByCronSchedule(db, id);
    const result = tasks
      .map((task) => {
        const invocations = getInvocationsByTask(db, task.linearIssueId).sort(
          (a, b) =>
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
        );
        return { ...task, invocations };
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    return c.json(result);
  });

  // -----------------------------------------------------------------------
  // POST /api/cron
  // -----------------------------------------------------------------------
  app.post("/api/cron", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const {
      name,
      type,
      schedule,
      prompt,
      repoPath,
      model,
      maxTurns,
      timeoutMin,
      maxRuns,
    } = body as Record<string, unknown>;

    if (!name || typeof name !== "string" || name.trim() === "") {
      return c.json({ error: "name is required" }, 400);
    }
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      return c.json({ error: "prompt is required" }, 400);
    }
    if (type !== "claude" && type !== "shell") {
      return c.json({ error: 'type must be "claude" or "shell"' }, 400);
    }
    if (!schedule || typeof schedule !== "string") {
      return c.json({ error: "schedule is required" }, 400);
    }
    const scheduleError = validateCronExpression(schedule);
    if (scheduleError !== null) {
      return c.json({ error: `invalid schedule: ${scheduleError}` }, 400);
    }
    if (
      type === "claude" &&
      (!repoPath || typeof repoPath !== "string" || repoPath.trim() === "")
    ) {
      return c.json({ error: "repoPath is required for claude type" }, 400);
    }
    if (model !== undefined && model !== null) {
      if (typeof model !== "string" || model.length === 0) {
        return c.json({ error: "model must be a non-empty string" }, 400);
      }
      const MODEL_SHORTCUTS = new Set(["opus", "sonnet", "haiku"]);
      if (!MODEL_SHORTCUTS.has(model) && !model.startsWith("claude-")) {
        return c.json(
          {
            error:
              "model must be one of opus/sonnet/haiku or a full model ID (claude-...)",
          },
          400,
        );
      }
    }
    if (
      maxTurns !== undefined &&
      maxTurns !== null &&
      (typeof maxTurns !== "number" ||
        !Number.isInteger(maxTurns) ||
        maxTurns <= 0)
    ) {
      return c.json({ error: "maxTurns must be a positive integer" }, 400);
    }
    if (
      timeoutMin !== undefined &&
      timeoutMin !== null &&
      (typeof timeoutMin !== "number" ||
        !Number.isInteger(timeoutMin) ||
        timeoutMin <= 0)
    ) {
      return c.json({ error: "timeoutMin must be a positive integer" }, 400);
    }
    if (
      maxRuns !== undefined &&
      maxRuns !== null &&
      (typeof maxRuns !== "number" ||
        !Number.isInteger(maxRuns) ||
        maxRuns <= 0)
    ) {
      return c.json(
        { error: "maxRuns must be a positive integer or null" },
        400,
      );
    }

    const now = new Date().toISOString();
    const nextRunAt = computeNextRunAt(schedule as string);
    const id = insertCronSchedule(db, {
      name: (name as string).trim(),
      type: type as "claude" | "shell",
      schedule: schedule as string,
      prompt: (prompt as string).trim(),
      repoPath: typeof repoPath === "string" ? repoPath : null,
      model: typeof model === "string" ? model : null,
      maxTurns: typeof maxTurns === "number" ? maxTurns : null,
      timeoutMin: typeof timeoutMin === "number" ? timeoutMin : 30,
      maxRuns: typeof maxRuns === "number" ? maxRuns : null,
      enabled: 1,
      nextRunAt,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const created = getCronSchedule(db, id);
    return c.json(created, 201);
  });

  // -----------------------------------------------------------------------
  // PUT /api/cron/:id
  // -----------------------------------------------------------------------
  app.put("/api/cron/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const existing = getCronSchedule(db, id);
    if (!existing) {
      return c.json({ error: "not found" }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const {
      name,
      type,
      schedule,
      prompt,
      repoPath,
      model,
      maxTurns,
      timeoutMin,
      maxRuns,
      enabled,
    } = body as Record<string, unknown>;

    if (
      name !== undefined &&
      (typeof name !== "string" || name.trim() === "")
    ) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    if (
      prompt !== undefined &&
      (typeof prompt !== "string" || prompt.trim() === "")
    ) {
      return c.json({ error: "prompt must be a non-empty string" }, 400);
    }
    if (type !== undefined && type !== "claude" && type !== "shell") {
      return c.json({ error: 'type must be "claude" or "shell"' }, 400);
    }
    if (schedule !== undefined) {
      if (typeof schedule !== "string") {
        return c.json({ error: "schedule must be a string" }, 400);
      }
      const scheduleError = validateCronExpression(schedule);
      if (scheduleError !== null) {
        return c.json({ error: `invalid schedule: ${scheduleError}` }, 400);
      }
    }
    if (model !== undefined && model !== null) {
      if (typeof model !== "string" || model.length === 0) {
        return c.json({ error: "model must be a non-empty string" }, 400);
      }
      const MODEL_SHORTCUTS = new Set(["opus", "sonnet", "haiku"]);
      if (!MODEL_SHORTCUTS.has(model) && !model.startsWith("claude-")) {
        return c.json(
          {
            error:
              "model must be one of opus/sonnet/haiku or a full model ID (claude-...)",
          },
          400,
        );
      }
    }
    if (
      maxTurns !== undefined &&
      maxTurns !== null &&
      (typeof maxTurns !== "number" ||
        !Number.isInteger(maxTurns) ||
        maxTurns <= 0)
    ) {
      return c.json({ error: "maxTurns must be a positive integer" }, 400);
    }
    if (
      timeoutMin !== undefined &&
      timeoutMin !== null &&
      (typeof timeoutMin !== "number" ||
        !Number.isInteger(timeoutMin) ||
        timeoutMin <= 0)
    ) {
      return c.json({ error: "timeoutMin must be a positive integer" }, 400);
    }
    if (
      maxRuns !== undefined &&
      maxRuns !== null &&
      (typeof maxRuns !== "number" ||
        !Number.isInteger(maxRuns) ||
        maxRuns <= 0)
    ) {
      return c.json(
        { error: "maxRuns must be a positive integer or null" },
        400,
      );
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = (name as string).trim();
    if (type !== undefined) updates.type = type;
    if (prompt !== undefined) updates.prompt = (prompt as string).trim();
    if (repoPath !== undefined) updates.repoPath = repoPath as string | null;
    if (model !== undefined) updates.model = model as string | null;
    if (maxTurns !== undefined) updates.maxTurns = maxTurns as number | null;
    if (timeoutMin !== undefined)
      updates.timeoutMin = timeoutMin as number | null;
    if (maxRuns !== undefined) updates.maxRuns = maxRuns as number | null;
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;

    if (schedule !== undefined) {
      updates.schedule = schedule as string;
      updates.nextRunAt = computeNextRunAt(schedule as string);
    }

    updateCronSchedule(
      db,
      id,
      updates as Parameters<typeof updateCronSchedule>[2],
    );
    const updated = getCronSchedule(db, id);
    return c.json(updated);
  });

  // -----------------------------------------------------------------------
  // DELETE /api/cron/:id
  // -----------------------------------------------------------------------
  app.delete("/api/cron/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const existing = getCronSchedule(db, id);
    if (!existing) {
      return c.json({ error: "not found" }, 404);
    }
    const cronTasks = getTasksByCronSchedule(db, id);
    for (const task of cronTasks) {
      deleteTask(db, task.linearIssueId);
    }
    deleteCronSchedule(db, id);
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/cron/:id/toggle
  // -----------------------------------------------------------------------
  app.post("/api/cron/:id/toggle", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const schedule = getCronSchedule(db, id);
    if (!schedule) {
      return c.json({ error: "not found" }, 404);
    }
    const newEnabled = schedule.enabled ? 0 : 1;
    updateCronSchedule(db, id, { enabled: newEnabled });
    const updated = getCronSchedule(db, id);
    return c.json(updated);
  });

  // -----------------------------------------------------------------------
  // POST /api/cron/:id/trigger
  // -----------------------------------------------------------------------
  app.post("/api/cron/:id/trigger", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) {
      return c.json({ error: "invalid id" }, 400);
    }
    const schedule = getCronSchedule(db, id);
    if (!schedule) {
      return c.json({ error: "not found" }, 404);
    }
    const now = new Date().toISOString();
    const taskId = `cron-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    insertTask(db, {
      linearIssueId: taskId,
      agentPrompt: schedule.prompt,
      repoPath: schedule.repoPath ?? "",
      orcaStatus: "ready",
      taskType: schedule.type === "claude" ? "cron_claude" : "cron_shell",
      cronScheduleId: schedule.id,
      createdAt: now,
      updatedAt: now,
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
    });
    incrementCronRunCount(db, id, computeNextRunAt(schedule.schedule));

    // Emit Inngest event for the new cron task
    const cronTask = getTask(db, taskId);
    if (cronTask) {
      emitTaskReady(inngest, cronTask);
    }

    return c.json({ ok: true, taskId });
  });

  // -----------------------------------------------------------------------
  // GET /api/inngest/workflows
  // -----------------------------------------------------------------------
  app.get("/api/inngest/workflows", async (c) => {
    const inngestBaseUrl =
      process.env["INNGEST_BASE_URL"] ?? "http://localhost:8288";
    const gqlUrl = `${inngestBaseUrl}/v0/gql`;
    const timeoutMs = 5000;

    try {
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), timeoutMs);

      // Fetch functions list
      const functionsRes = await fetch(gqlUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query { functions { id name slug triggers { type value } } }`,
        }),
        signal: controller.signal,
      });
      const functionsBody = (await functionsRes.json()) as {
        data?: {
          functions?: Array<{
            id: string;
            name: string;
            slug: string;
            triggers: Array<{ type: string; value: string }>;
          }>;
        };
      };
      const functions = functionsBody.data?.functions ?? [];

      // Fetch recent runs (last 24h)
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const runsRes = await fetch(gqlUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($from: Time!) {
            runs(
              filter: { from: $from }
              orderBy: [{ field: QUEUED_AT, direction: DESC }]
              first: 100
            ) {
              edges { node { id functionID status startedAt endedAt } }
            }
          }`,
          variables: { from },
        }),
        signal: controller.signal,
      });
      const runsBody = (await runsRes.json()) as {
        data?: {
          runs?: {
            edges?: Array<{
              node: {
                id: string;
                functionID: string;
                status: string;
                startedAt: string;
                endedAt: string | null;
              };
            }>;
          };
        };
      };
      clearTimeout(timerId);

      const runs = (runsBody.data?.runs?.edges ?? []).map((e) => e.node);

      // Join: for each function, attach its recent runs and compute stats
      const result = functions.map((fn) => {
        const fnRuns = runs.filter((r) => r.functionID === fn.id);
        const completed = fnRuns.filter((r) => r.status === "COMPLETED").length;
        const failed = fnRuns.filter((r) => r.status === "FAILED").length;
        return {
          id: fn.id,
          name: fn.name,
          slug: fn.slug,
          triggers: fn.triggers,
          recentRuns: fnRuns.map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          })),
          stats: { total: fnRuns.length, completed, failed },
        };
      });

      return c.json({ functions: result });
    } catch {
      return c.json({ functions: [], error: "Inngest unreachable" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/deploy/drain
  // -----------------------------------------------------------------------
  app.post("/api/deploy/drain", (c) => {
    setDraining();
    logger.info("audit: drain triggered");
    return c.json({ ok: true, draining: true });
  });

  // -----------------------------------------------------------------------
  // POST /api/deploy/unpause
  // -----------------------------------------------------------------------
  // Legacy unpause — Inngest mode has no scheduler to unpause
  app.post("/api/deploy/unpause", (c) => c.json({ status: "ok" }));

  // -----------------------------------------------------------------------
  // POST /api/deploy/event  — log deploy success/failure to system_events
  // -----------------------------------------------------------------------
  app.post("/api/deploy/event", async (c) => {
    const body = await c.req.json<{ status: string; message?: string }>();
    const status = body.status === "failure" ? "failure" : "success";
    const message = body.message ?? `Deploy ${status}`;
    insertSystemEvent(db, {
      type: "deploy",
      message,
      metadata: { status },
    });
    logger.info(`audit: deploy event status=${status}`);
    return c.json({ ok: true });
  });

  return app;
}
