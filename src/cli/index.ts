import { Command } from "commander";
import { type TaskStatus } from "../shared/types.js";
import {
  loadConfig,
  parseRepoPath,
  validateProjectRepoPaths,
} from "../config/index.js";
import { createDb } from "../db/index.js";
import {
  insertTask,
  getAllTasks,
  getTask,
  getRunningInvocations,
  updateInvocation,
  updateTaskStatus,
  updateTaskFields,
  clearSessionIds,
  insertSystemEvent,
  getInvocationsByTask,
  getTaskStateTransitions,
} from "../db/queries.js";
import { LinearClient } from "../linear/client.js";
import { DependencyGraph } from "../linear/graph.js";
import { fullSync, writeBackStatus, logStateMapping } from "../linear/sync.js";
import { createWebhookRoute } from "../linear/webhook.js";
import { initDeployState, isDraining } from "../deploy.js";
import { startTunnel, type TunnelHandle } from "../tunnel/index.js";
import { createPoller, type PollerHandle } from "../linear/poller.js";
import { inngest } from "../inngest/client.js";
import { serve as serveInngest } from "inngest/hono";
import { functions as inngestFunctions } from "../inngest/functions.js";
import {
  setSchedulerDeps,
  markReady,
  getSchedulerDeps,
  isReady,
} from "../inngest/deps.js";
import { createApiRoutes } from "../api/routes.js";
import { removeWorktree } from "../worktree/index.js";
import { createWorktreePool } from "../worktree/pool.js";
import { probeDllHealth } from "../git.js";
import { initFileLogger, createLogger } from "../logger.js";
import { initAlertSystem } from "../scheduler/alerts.js";
import { activeHandles } from "../session-handles.js";
import { killSession } from "../runner/index.js";
import { backfillPrState } from "../db/backfill.js";
import { startInngestHealthMonitor } from "../inngest/health-monitor.js";

const logger = createLogger("cli");
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
const program = new Command();

program
  .name("orca")
  .description(
    "AI agent scheduler — dispatches and manages Claude Code sessions",
  );

// ---------------------------------------------------------------------------
// orca add
// ---------------------------------------------------------------------------

program
  .command("add")
  .description("Add a new task to the queue")
  .requiredOption("--prompt <text>", "Agent prompt for the task")
  .requiredOption("--repo <path>", "Path to the repository")
  .option("--priority <n>", "Priority level 0-4 (lower runs first)", "0")
  .option("--id <text>", "Custom task ID (auto-generated if omitted)")
  .action(
    (opts: { prompt: string; repo: string; priority: string; id?: string }) => {
      const priority = Number(opts.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
        logger.error("orca: --priority must be an integer between 0 and 4");
        process.exit(1);
      }

      const taskId = opts.id ?? `ORCA-${Date.now().toString(36)}`;
      const now = new Date().toISOString();

      const config = loadConfig();
      const db = createDb(config.dbPath);

      insertTask(db, {
        linearIssueId: taskId,
        agentPrompt: opts.prompt,
        repoPath: opts.repo,
        orcaStatus: "ready",
        priority,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      logger.info(`Task ${taskId} added (priority: ${priority})`);
    },
  );

// ---------------------------------------------------------------------------
// orca start
// ---------------------------------------------------------------------------

program
  .command("start")
  .description("Start the Orca scheduler")
  .action(async () => {
    const config = loadConfig();
    initFileLogger({
      logPath: config.logPath,
      maxSizeBytes: 10 * 1024 * 1024,
    });
    const db = createDb(config.dbPath);
    initAlertSystem(db);

    // Backfill pr_url/pr_state for existing tasks that predate this feature.
    // Fire-and-forget — failures are silently skipped.
    backfillPrState(db).catch(() => {});

    // Initialize deploy state (SHA dedup + cooldown)
    initDeployState();

    // Log startup event
    insertSystemEvent(db, {
      type: "startup",
      message: "Orca starting up",
      metadata: {
        port: config.port,
        version: process.env.npm_package_version ?? "unknown",
        nodeVersion: process.version,
        pid: process.pid,
        pm2: typeof process.send === "function",
      },
    });

    // Initialize Linear dependencies
    const client = new LinearClient(config.linearApiKey);
    const graph = new DependencyGraph();

    // Fetch project metadata: descriptions (for repo mapping) + team IDs
    const projectMeta = await client.fetchProjectMetadata(
      config.linearProjectIds,
    );

    // Build per-project repo map from project descriptions
    for (const pm of projectMeta) {
      const repoPath = parseRepoPath(pm.description);
      if (repoPath) {
        config.projectRepoMap.set(pm.id, repoPath);
        logger.info(`project ${pm.id} → repo: ${repoPath}`);
      }
    }

    // Validate every project resolves to a valid directory
    validateProjectRepoPaths(config);

    // Mark orphaned invocations as failed FIRST. At startup activeHandles
    // is empty, so ALL "running" invocations are orphans from a previous
    // crash/restart. This must happen before orphan task recovery so that
    // orphaned tasks have no running invocations and get correctly reset.
    const orphanedInvocations = getRunningInvocations(db);
    for (const inv of orphanedInvocations) {
      updateInvocation(db, inv.id, {
        status: "failed",
        endedAt: new Date().toISOString(),
        outputSummary: "orphaned by crash/restart",
        sessionId: null,
      });
    }
    if (orphanedInvocations.length > 0) {
      logger.info(
        `marked ${orphanedInvocations.length} orphaned invocation(s) as failed`,
      );
    }

    // Collect task IDs affected by orphaned invocations, then clear their
    // implement-phase session IDs so dead pre-restart sessions aren't resumed.
    const orphanedTaskIds = new Set(
      orphanedInvocations.map((inv) => inv.linearIssueId),
    );
    for (const taskId of orphanedTaskIds) {
      clearSessionIds(db, taskId);
      updateTaskFields(db, taskId, { staleSessionRetryCount: 0 });
    }
    if (orphanedTaskIds.size > 0) {
      logger.info(
        `cleared session IDs and reset stale counts for ${orphanedTaskIds.size} task(s) with orphaned invocations`,
      );
    }

    // Now recover orphaned tasks: any task stuck in "running"
    // with no running invocation is dead.
    const allTasks = getAllTasks(db);
    const runningInvIssueIds = new Set(
      getRunningInvocations(db).map((inv) => inv.linearIssueId),
    );
    let recovered = 0;
    for (const t of allTasks) {
      if (
        t.lifecycleStage === "active" &&
        !runningInvIssueIds.has(t.linearIssueId)
      ) {
        updateTaskStatus(db, t.linearIssueId, "ready", {
          reason: "manual_cli_add",
        });
        updateTaskFields(db, t.linearIssueId, { staleSessionRetryCount: 0 });
        clearSessionIds(db, t.linearIssueId);
        recovered++;
      }
    }
    if (recovered > 0) {
      logger.info(`recovered ${recovered} orphaned task(s) → ready`);
    }

    // Full sync: populate tasks table + dependency graph
    // Do NOT pass inngest here — the startup re-emit block below handles all
    // ready tasks after registration. Passing inngest would double-emit task/ready
    // for every newly-inserted ready task.
    const syncedIssues = await fullSync(db, client, graph, config);

    // Fetch workflow states for write-back (state name → state UUID)
    const teamIds = [...new Set(projectMeta.flatMap((pm) => pm.teamIds))];
    const stateMap = await client.fetchWorkflowStates(teamIds);

    // Log resolved state mapping + warn on ambiguity
    logStateMapping(stateMap);

    // Reconcile failed tasks whose Linear status is still active.
    // On crash/restart, fire-and-forget write-backs may have been lost.
    // Find any task with orcaStatus === "failed" that Linear still shows as
    // "In Progress" or "In Review" and write back "Canceled" with a comment.
    const activeLinearStates = new Set(["In Progress", "In Review"]);
    const failedTasks = getAllTasks(db).filter(
      (t) => t.lifecycleStage === "failed",
    );
    const syncedIssueMap = new Map(
      syncedIssues.map((issue) => [issue.identifier, issue]),
    );
    let reconciled = 0;
    for (const task of failedTasks) {
      const linearIssue = syncedIssueMap.get(task.linearIssueId);
      if (!linearIssue || !activeLinearStates.has(linearIssue.state.name)) {
        continue;
      }
      // Write back Canceled and post a comment (fire-and-forget with error logging)
      writeBackStatus(client, task.linearIssueId, "failed_permanent", stateMap)
        .then(() =>
          client.createComment(
            task.linearIssueId,
            "**Orca status correction:** This task was marked as failed internally (retries exhausted) but the Linear status was not updated due to a crash or restart. Setting to Canceled now.",
          ),
        )
        .catch((err) => {
          logger.warn(
            `reconcile write-back failed for ${task.linearIssueId}: ${err}`,
          );
        });
      reconciled++;
    }
    if (reconciled > 0) {
      logger.info(
        `reconciling ${reconciled} failed task(s) with stale Linear status`,
      );
    }

    // Reconcile backlog/ready tasks whose Linear status is still active.
    // On crash/restart, tasks may have been reset to backlog/ready but the
    // Linear status was never updated from "In Progress" / "In Review".
    const resetTasks = getAllTasks(db).filter(
      (t) => t.lifecycleStage === "backlog" || t.lifecycleStage === "ready",
    );
    let reconciledReset = 0;
    for (const task of resetTasks) {
      const linearIssue = syncedIssueMap.get(task.linearIssueId);
      if (!linearIssue || !activeLinearStates.has(linearIssue.state.name)) {
        continue;
      }
      const transition =
        task.lifecycleStage === "backlog" ? "backlog" : "retry";
      const label = task.lifecycleStage === "backlog" ? "backlog" : "ready";
      writeBackStatus(client, task.linearIssueId, transition, stateMap)
        .then(() =>
          client.createComment(
            task.linearIssueId,
            `**Orca status correction:** This task was reset to ${label} after a crash/restart but the Linear status was not updated. Correcting now.`,
          ),
        )
        .catch((err) => {
          logger.warn(
            `reconcile write-back failed for ${task.linearIssueId}: ${err}`,
          );
        });
      reconciledReset++;
    }
    if (reconciledReset > 0) {
      logger.info(
        `reconciling ${reconciledReset} backlog/ready task(s) with stale Linear status`,
      );
    }

    // Start Hono HTTP server with webhook endpoint
    const webhookApp = createWebhookRoute({
      db,
      client,
      graph,
      config,
      stateMap,
      inngest,
    });

    // Create API routes
    const apiApp = createApiRoutes({
      db,
      config,
      syncTasks: () => fullSync(db, client, graph, config, stateMap, inngest),
      client,
      stateMap,
      projectMeta,
      inngest,
    });

    const app = new Hono();
    app.route("/", webhookApp);
    app.route("/", apiApp);

    // Inngest serve endpoint
    const inngestHandler = serveInngest({
      client: inngest,
      functions: inngestFunctions,
    });
    app.on(["GET", "PUT", "POST"], "/api/inngest", (c) => inngestHandler(c));
    logger.info("serve endpoint mounted at /api/inngest");

    // Static files + SPA fallback (after API routes so API takes priority)
    app.use("/*", serveStatic({ root: "./web/dist" }));
    app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));

    const server = serve({ fetch: app.fetch, port: config.port });
    logger.info(`Hono server listening on port ${config.port}`);

    // Start cloudflared tunnel (skip in external tunnel mode)
    let tunnel: TunnelHandle | null = null;
    if (config.externalTunnel) {
      logger.info("external tunnel mode — skipping cloudflared spawn");
    } else {
      tunnel = startTunnel({
        cloudflaredPath: config.cloudflaredPath,
        token: config.tunnelToken || undefined,
      });
    }

    // Start polling fallback (activates when tunnel is down)
    const poller: PollerHandle = createPoller({
      db,
      client,
      graph,
      config,
      stateMap,
      inngest,
      isTunnelConnected: () =>
        config.externalTunnel ? true : tunnel!.isTunnelConnected(),
    });
    poller.start();

    // Signal PM2 that the app is ready to accept traffic IMMEDIATELY after
    // port bind, before Inngest registration. This ensures health checks can
    // respond during the grace period.
    if (typeof process.send === "function") {
      process.send("ready");
    }

    // Defer Inngest registration and task re-emission so health checks can
    // respond without contention from workflow execution saturating the
    // event loop.
    const STARTUP_GRACE_MS = 15_000;
    logger.info(
      `startup grace period: deferring Inngest registration for ${STARTUP_GRACE_MS / 1000}s`,
    );

    setTimeout(async () => {
      logger.info("startup grace period ended — initializing Inngest");

      // Initialize Inngest workflow deps (must happen before workflows fire)
      setSchedulerDeps({ db, config, graph, client, stateMap });
      logger.info("task lifecycle deps initialized");

      // Start worktree pool if configured
      if (config.worktreePoolSize > 0) {
        const pool = createWorktreePool(config.worktreePoolSize);
        const repoPaths = [
          ...new Set([
            ...config.projectRepoMap.values(),
            ...(config.defaultCwd ? [config.defaultCwd] : []),
          ]),
        ];
        pool.start(repoPaths);
        const deps = getSchedulerDeps();
        setSchedulerDeps({ ...deps, worktreePool: pool });
        logger.info(
          `worktree pool started (size=${config.worktreePoolSize}, repos=${repoPaths.length})`,
        );
      }

      // Verify Inngest server is reachable before self-registration.
      const inngestBaseUrl =
        process.env.INNGEST_BASE_URL || "http://localhost:8288";
      fetch(inngestBaseUrl)
        .then(() =>
          logger.info(`Inngest server is reachable at ${inngestBaseUrl}`),
        )
        .catch(() =>
          logger.error(
            `WARNING: Inngest server is not reachable at ${inngestBaseUrl} — task dispatching will not work`,
          ),
        );

      // Start Inngest self-healing health monitor. Detects Inngest downtime
      // and auto-restarts via PM2, then re-emits events for stranded tasks.
      startInngestHealthMonitor(inngest, db);

      // Self-register with Inngest server so it knows our callback URL.
      // Without this, deploys/restarts that change ports leave Inngest
      // accepting events but unable to execute workflows.
      fetch(`http://localhost:${config.port}/api/inngest`, { method: "PUT" })
        .then(async (res) => {
          if (res.ok) {
            logger.info("Inngest functions registered successfully");
          } else {
            const body = await res.text().catch(() => "");
            logger.warn(`Inngest registration returned ${res.status}: ${body}`);
          }
        })
        .catch((err: unknown) =>
          logger.warn(`Inngest registration failed: ${err}`),
        );

      // Send task/cancelled events for tasks that had orphaned invocations.
      // When Orca crashes (no clean shutdown), old Inngest workflows survive
      // and hold per-task concurrency locks. Sending cancellation events kills
      // them so re-emitted task/ready events aren't blocked.
      //
      // We must await these before emitting task/ready — otherwise the new
      // workflow can queue behind the zombie's per-task concurrency lock.
      if (orphanedTaskIds.size > 0) {
        const cancelPromises = [...orphanedTaskIds].map((taskId) => {
          const task = getTask(db, taskId);
          return inngest
            .send({
              name: "task/cancelled" as const,
              data: {
                linearIssueId: taskId,
                reason: "orphaned_by_crash",
                retryCount: task?.retryCount ?? 0,
                previousStatus: (task?.orcaStatus ?? "running") as TaskStatus,
              },
            })
            .catch((err: unknown) =>
              logger.warn(
                `startup: failed to cancel zombie workflow for ${taskId}: ${err}`,
              ),
            );
        });
        await Promise.allSettled(cancelPromises);
        logger.info(
          `startup: sent task/cancelled for ${orphanedTaskIds.size} orphaned task(s)`,
        );
      }

      // Re-emit task/ready events for any tasks that need dispatch.
      // Events can be lost if Orca crashes, Inngest is down, or tasks were
      // recovered from running→ready above. Without this, dispatchable tasks
      // sit in the DB with no corresponding Inngest workflow to pick them up.
      //
      // Covers: ready, changes_requested, in_review — the claim step accepts
      // all three statuses, so they all need a workflow run to make progress.
      // Covers: ready, active/review, active/fix — these all need a workflow run.
      const dispatchableTasks = getAllTasks(db).filter(
        (t) =>
          t.lifecycleStage === "ready" ||
          (t.lifecycleStage === "active" &&
            (t.currentPhase === "review" || t.currentPhase === "fix")),
      );
      if (dispatchableTasks.length > 0) {
        for (const task of dispatchableTasks) {
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
              logger.warn(
                `startup: failed to re-emit task/ready for ${task.linearIssueId}: ${err}`,
              ),
            );
        }
        logger.info(
          `startup: re-emitted task/ready for ${dispatchableTasks.length} task(s): ${dispatchableTasks.map((t) => `${t.linearIssueId}(${t.lifecycleStage}${t.currentPhase ? "/" + t.currentPhase : ""})`).join(", ")}`,
        );
      }

      markReady();
      logger.info("Inngest ready gate opened");
    }, STARTUP_GRACE_MS);

    // Self-health monitoring: detect DLL_INIT degradation and exit for PM2 restart
    let consecutiveDllFailures = 0;
    setInterval(() => {
      if (probeDllHealth()) {
        consecutiveDllFailures = 0;
      } else {
        consecutiveDllFailures++;
        logger.warn(
          `DLL health check failed (${consecutiveDllFailures} consecutive)`,
        );
        if (consecutiveDllFailures >= 3) {
          insertSystemEvent(db, {
            type: "error",
            message: "DLL_INIT degradation detected — exiting for PM2 restart",
            metadata: { consecutiveFailures: consecutiveDllFailures },
          });
          logger.error(
            "DLL_INIT degradation detected — exiting for PM2 restart",
          );
          process.exit(1);
        }
      }
    }, 60_000);

    // Graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info("Orca shutting down...");

      const running = getRunningInvocations(db);
      const deployInProgress = isDraining();

      insertSystemEvent(db, {
        type: "shutdown",
        message: "Graceful shutdown",
        metadata: {
          reason: deployInProgress ? "deploy" : "signal",
          runningTasks: running.length,
        },
      });

      // Close HTTP server first to stop accepting new requests
      server.close();

      // Stop polling fallback
      poller.stop();

      // Stop cloudflared tunnel
      if (tunnel) tunnel.stop();

      // Stop worktree pool (best-effort)
      if (isReady()) {
        const poolDeps = getSchedulerDeps().worktreePool;
        if (poolDeps) {
          await poolDeps.stop().catch((err) => {
            logger.warn(`pool stop failed: ${err}`);
          });
        }
      }

      // 1. Gracefully kill all active Claude sessions
      const killPromises: Promise<void>[] = [];
      for (const [invId, handle] of activeHandles) {
        logger.info(`killing session for invocation ${invId}...`);
        killPromises.push(
          killSession(handle).catch((err) => {
            logger.warn(`failed to kill session ${invId}: ${err}`);
          }) as Promise<void>,
        );
      }
      // Wait up to 10s for all sessions to die
      await Promise.race([
        Promise.allSettled(killPromises),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);

      // 2. Update DB records (preserve worktrees for ALL phases during deploy)
      for (const inv of running) {
        if (deployInProgress && inv.worktreePath) {
          // Preserve worktree for ALL phases during deploy (not just implement)
          updateInvocation(db, inv.id, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: "interrupted_by_deploy",
            worktreePreserved: 1,
          });
          logger.info(
            `preserving worktree for deploy-interrupted task ${inv.linearIssueId} (${inv.phase}): ${inv.worktreePath}`,
          );
        } else {
          updateInvocation(db, inv.id, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: "interrupted by shutdown",
          });
          // Best-effort worktree cleanup for interrupted sessions
          if (inv.worktreePath) {
            try {
              removeWorktree(inv.worktreePath);
            } catch {
              // Worktree may already be removed or in a bad state — ignore
            }
          }
        }
        updateTaskStatus(db, inv.linearIssueId, "ready", {
          reason: "manual_cli_reset",
        });
        // Only clear session IDs for non-deploy shutdowns so the new instance
        // can use --resume for deploy-interrupted sessions.
        if (!deployInProgress) {
          clearSessionIds(db, inv.linearIssueId);
        }
        updateTaskFields(db, inv.linearIssueId, { staleSessionRetryCount: 0 });
      }

      // 3. Send task/cancelled events to Inngest so orphaned workflow runs
      // unblock per-task concurrency instead of waiting for timeout.
      if (running.length > 0) {
        const cancelEvents = running.map((inv) => {
          const task = getTask(db, inv.linearIssueId);
          return {
            name: "task/cancelled" as const,
            data: {
              linearIssueId: inv.linearIssueId,
              reason: deployInProgress
                ? "interrupted_by_deploy"
                : "interrupted_by_shutdown",
              retryCount: task?.retryCount ?? 0,
              previousStatus: (task?.orcaStatus ?? "running") as TaskStatus,
            },
          };
        });
        await Promise.allSettled(
          cancelEvents.map((evt) => inngest.send(evt).catch(() => {})),
        ).catch(() => {});
        logger.info(
          `sent ${cancelEvents.length} task/cancelled event(s) to Inngest`,
        );
      }

      setTimeout(() => {
        process.exit(0);
      }, 2000);
    };

    // Signal handlers call the async function fire-and-forget
    // (signal handlers can't be async directly)
    process.on("SIGTERM", () => {
      shutdown();
    });
    process.on("SIGINT", () => {
      shutdown();
    });

    process.on("unhandledRejection", (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      logger.error(`unhandledRejection: ${err.message}\n${err.stack ?? ""}`);
      // Log and continue — do not crash the daemon
    });

    process.on("uncaughtException", (err: Error, origin: string) => {
      logger.error(
        `uncaughtException (${origin}): ${err.message}\n${err.stack ?? ""}`,
      );
      shutdown();
    });
  });

// ---------------------------------------------------------------------------
// orca status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Show current scheduler status")
  .action(() => {
    const config = loadConfig();
    const db = createDb(config.dbPath);

    // Active sessions
    const running = getRunningInvocations(db);
    const activeCount = running.length;
    const activeTaskIds = running.map((inv) => inv.linearIssueId);

    // Queued tasks
    const allTasks = getAllTasks(db);
    const readyCount = allTasks.filter(
      (t) => t.lifecycleStage === "ready",
    ).length;
    const failedCount = allTasks.filter(
      (t) => t.lifecycleStage === "failed",
    ).length;

    logger.info("=== Orca Status ===");
    logger.info("");
    logger.info(
      `Active sessions: ${activeCount}${activeTaskIds.length > 0 ? ` [${activeTaskIds.join(", ")}]` : ""}`,
    );
    logger.info(`Queued tasks:    ${readyCount}`);
    logger.info(`Failed tasks:    ${failedCount}`);
  });

// ---------------------------------------------------------------------------
// orca inspect <linearId>
// ---------------------------------------------------------------------------

program
  .command("inspect <linearId>")
  .description("Show diagnostic summary for a task")
  .action(async (linearId: string) => {
    const config = loadConfig();
    const db = createDb(config.dbPath);

    const task = getTask(db, linearId);
    if (!task) {
      console.log("Task not found");
      process.exit(1);
    }

    // Header
    console.log(`\n=== ${linearId} ===`);
    console.log(`Status:     ${task.orcaStatus}`);
    console.log(`Stage:      ${task.lifecycleStage ?? "(not set)"}`);
    console.log(`Phase:      ${task.currentPhase ?? "(none)"}`);
    console.log(`Priority:   ${task.priority}`);
    console.log(`Retries:    ${task.retryCount}/${config.maxRetries}`);

    const prDisplay = task.prBranchName
      ? `${task.prBranchName}${task.prNumber ? ` (#${task.prNumber})` : ""}`
      : "(none)";
    console.log(`PR:         ${prDisplay}`);
    console.log(`Project:    ${task.projectName ?? "(unknown)"}`);
    console.log(`Repo:       ${task.repoPath}`);
    console.log(`Created:    ${task.createdAt}`);
    console.log(`Updated:    ${task.updatedAt}`);

    // Last failure info
    if (task.lastFailureReason) {
      console.log("");
      console.log(`Last failure: ${task.lastFailureReason}`);
      if (task.lastFailedPhase) {
        console.log(`Failed phase: ${task.lastFailedPhase}`);
      }
      if (task.lastFailedAt) {
        console.log(`Failed at:    ${task.lastFailedAt}`);
      }
    }

    // Invocations (newest first)
    const allInvocations = getInvocationsByTask(db, linearId);
    const sorted = [...allInvocations].sort(
      (a, b) => (b.id ?? 0) - (a.id ?? 0),
    );
    console.log(`\n--- Invocations (${sorted.length}) ---`);
    for (const inv of sorted) {
      const startShort = inv.startedAt
        ? inv.startedAt.replace(/\.\d+Z$/, "Z")
        : "?";
      const endShort = inv.endedAt
        ? inv.endedAt.replace(/^.*T/, "").replace(/\.\d+Z$/, "Z")
        : "running";
      const summary = inv.outputSummary
        ? inv.outputSummary.length > 60
          ? inv.outputSummary.slice(0, 60) + "..."
          : inv.outputSummary
        : "";
      const turns =
        inv.numTurns != null
          ? `${String(inv.numTurns).padStart(2)} turns`
          : "       ";
      console.log(
        `#${inv.id} | ${inv.phase ?? "?"} | ${inv.status} | ${inv.model ?? "?"} | ${turns} | ${startShort} → ${endShort} | ${summary}`,
      );
    }

    // State transitions (oldest first — already ordered by id asc from query)
    const transitions = getTaskStateTransitions(db, linearId);
    console.log(`\n--- State Transitions (${transitions.length}) ---`);
    for (const t of transitions) {
      const from = t.fromStatus ?? "(init)";
      const reason = t.reason ?? "";
      console.log(`${from} → ${t.toStatus} | ${reason} | ${t.createdAt}`);
    }

    console.log("");
  });

// ---------------------------------------------------------------------------
// orca init
// ---------------------------------------------------------------------------

program
  .command("init")
  .description("Interactive setup wizard")
  .action(async () => {
    const { runInit } = await import("./init.js");
    await runInit();
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse();
