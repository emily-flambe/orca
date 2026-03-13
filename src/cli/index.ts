import { Command } from "commander";
import {
  loadConfig,
  parseRepoPath,
  validateProjectRepoPaths,
} from "../config/index.js";
import { createDb } from "../db/index.js";
import {
  insertTask,
  getAllTasks,
  getRunningInvocations,
  sumCostInWindow,
  budgetWindowStart,
  updateInvocation,
  updateTaskStatus,
  updateTaskFields,
  clearSessionIds,
} from "../db/queries.js";
import { createScheduler } from "../scheduler/index.js";
import { setSchedulerHandle } from "../scheduler/state.js";
import { LinearClient } from "../linear/client.js";
import { DependencyGraph } from "../linear/graph.js";
import { fullSync, writeBackStatus } from "../linear/sync.js";
import { createWebhookRoute } from "../linear/webhook.js";
import { createGithubWebhookRoute } from "../github/webhook.js";
import { initDeployState, isDraining } from "../deploy.js";
import { startTunnel, type TunnelHandle } from "../tunnel/index.js";
import { createPoller, type PollerHandle } from "../linear/poller.js";
import { createApiRoutes } from "../api/routes.js";
import { removeWorktree } from "../worktree/index.js";
import { initFileLogger } from "../logger.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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
        console.error("orca: --priority must be an integer between 0 and 4");
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

      console.log(`Task ${taskId} added (priority: ${priority})`);
    },
  );

// ---------------------------------------------------------------------------
// orca start
// ---------------------------------------------------------------------------

program
  .command("start")
  .description("Start the Orca scheduler")
  .option(
    "--scheduler-paused",
    "Start with the scheduler paused (POST /api/deploy/unpause to start)",
  )
  .action(async (opts: { schedulerPaused?: boolean }) => {
    const config = loadConfig();
    initFileLogger({
      logPath: config.logPath,
      maxSizeBytes: config.logMaxSizeMb * 1024 * 1024,
    });
    const db = createDb(config.dbPath);

    // Initialize deploy state (SHA dedup + cooldown)
    initDeployState();

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
        console.log(`[orca] project ${pm.id} → repo: ${repoPath}`);
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
      console.log(
        `[orca] marked ${orphanedInvocations.length} orphaned invocation(s) as failed`,
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
      console.log(
        `[orca] cleared session IDs and reset stale counts for ${orphanedTaskIds.size} task(s) with orphaned invocations`,
      );
    }

    // Now recover orphaned tasks: any task stuck in "running" or
    // "dispatched" with no running invocation is dead.
    const allTasks = getAllTasks(db);
    const runningInvIssueIds = new Set(
      getRunningInvocations(db).map((inv) => inv.linearIssueId),
    );
    let recovered = 0;
    for (const t of allTasks) {
      if (
        (t.orcaStatus === "running" || t.orcaStatus === "dispatched") &&
        !runningInvIssueIds.has(t.linearIssueId)
      ) {
        updateTaskStatus(db, t.linearIssueId, "ready");
        updateTaskFields(db, t.linearIssueId, { staleSessionRetryCount: 0 });
        clearSessionIds(db, t.linearIssueId);
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(`[orca] recovered ${recovered} orphaned task(s) → ready`);
    }

    // Label filter cache (shared between fullSync and webhook handler)
    const labelIdCache = new Map<string, string>();

    // Full sync: populate tasks table + dependency graph
    const syncedIssues = await fullSync(
      db,
      client,
      graph,
      config,
      undefined,
      labelIdCache,
    );

    // Fetch workflow states for write-back (state name → state UUID)
    const teamIds = [...new Set(projectMeta.flatMap((pm) => pm.teamIds))];
    const stateMap = await client.fetchWorkflowStates(teamIds);

    // Reconcile failed tasks whose Linear status is still active.
    // On crash/restart, fire-and-forget write-backs may have been lost.
    // Find any task with orcaStatus === "failed" that Linear still shows as
    // "In Progress" or "In Review" and write back "Canceled" with a comment.
    const activeLinearStates = new Set(["In Progress", "In Review"]);
    const failedTasks = getAllTasks(db).filter(
      (t) => t.orcaStatus === "failed",
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
          console.log(
            `[orca] reconcile write-back failed for ${task.linearIssueId}: ${err}`,
          );
        });
      reconciled++;
    }
    if (reconciled > 0) {
      console.log(
        `[orca] reconciling ${reconciled} failed task(s) with stale Linear status`,
      );
    }

    // Start Hono HTTP server with webhook endpoint
    const webhookApp = createWebhookRoute({
      db,
      client,
      graph,
      config,
      stateMap,
      labelIdCache,
    });

    // Create API routes
    const apiApp = createApiRoutes({
      db,
      config,
      syncTasks: () =>
        fullSync(db, client, graph, config, stateMap, labelIdCache),
      client,
      stateMap,
      projectMeta,
    });

    const app = new Hono();
    app.route("/", webhookApp);
    app.route("/", apiApp);

    // GitHub webhook route (optional — used for future integrations)
    if (config.githubWebhookSecret) {
      const githubWebhookApp = createGithubWebhookRoute({
        secret: config.githubWebhookSecret,
        onPushToMain: () => {
          /* auto-deploy via webhook removed — deploy.sh handles deploys */
        },
      });
      app.route("/", githubWebhookApp);
      console.log("[orca/github-webhook] webhook registered");
    }

    // Static files + SPA fallback (after API routes so API takes priority)
    app.use("/*", serveStatic({ root: "./web/dist" }));
    app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));

    const server = serve({ fetch: app.fetch, port: config.port });
    console.log(`Hono server listening on port ${config.port}`);

    // Write port-aware pidfile to avoid collisions during blue/green deploy
    const pidFile = join(process.cwd(), `orca-${config.port}.pid`);
    writeFileSync(pidFile, String(process.pid));
    // Legacy pidfile for backward compat with scripts/deploy.sh
    const legacyPidFile = join(process.cwd(), "orca.pid");
    writeFileSync(legacyPidFile, String(process.pid));
    for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) {
      process.on(sig, () => {
        try {
          unlinkSync(pidFile);
        } catch {
          /* already gone */
        }
        try {
          unlinkSync(legacyPidFile);
        } catch {
          /* already gone */
        }
      });
    }

    // Start cloudflared tunnel (skip in external tunnel mode)
    let tunnel: TunnelHandle | null = null;
    if (config.externalTunnel) {
      console.log("[orca] external tunnel mode — skipping cloudflared spawn");
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
      labelIdCache,
      isTunnelConnected: () =>
        config.externalTunnel ? true : tunnel!.isTunnelConnected(),
    });
    poller.start();

    // Start scheduler
    const scheduler = createScheduler(
      { db, config, graph, client, stateMap },
      { paused: opts.schedulerPaused },
    );
    setSchedulerHandle(scheduler);

    if (opts.schedulerPaused) {
      console.log(
        `Orca scheduler created (PAUSED — POST /api/deploy/unpause to start)`,
      );
    } else {
      console.log(
        `Orca scheduler started (concurrency: ${config.concurrencyCap}, interval: ${config.schedulerIntervalSec}s)`,
      );
    }

    // Graceful shutdown
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("Orca shutting down...");

      // Close HTTP server first to stop accepting new requests
      server.close();

      // Stop scheduler (clears interval, kills active sessions)
      scheduler.stop();

      // Stop polling fallback
      poller.stop();

      // Stop cloudflared tunnel
      if (tunnel) tunnel.stop();

      // Mark all running invocations as failed AND reset their tasks to
      // "ready" so they re-enter the dispatch queue on next startup.
      // Without this, tasks stay orphaned in "running" state forever.
      //
      // If the scheduler was draining (deploy in progress), preserve the
      // worktree so the next dispatch can resume from the interrupted state.
      // Otherwise, remove the worktree so retries start fresh.
      const deployInProgress = isDraining();
      const running = getRunningInvocations(db);
      for (const inv of running) {
        if (deployInProgress && inv.phase === "implement" && inv.worktreePath) {
          // Preserve worktree for deploy-interrupted resume
          updateInvocation(db, inv.id, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: "interrupted_by_deploy",
            worktreePreserved: 1,
          });
          console.log(
            `[orca/shutdown] preserving worktree for deploy-interrupted task ${inv.linearIssueId}: ${inv.worktreePath}`,
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
        updateTaskStatus(db, inv.linearIssueId, "ready");
        // Clear implement-phase session IDs so the next startup doesn't try
        // to resume a dead Claude session. Also reset the stale counter so
        // pre-shutdown stale detections don't carry over into the next run.
        clearSessionIds(db, inv.linearIssueId);
        updateTaskFields(db, inv.linearIssueId, { staleSessionRetryCount: 0 });
      }

      setTimeout(() => {
        process.exit(0);
      }, 2000);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
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
    const readyCount = allTasks.filter((t) => t.orcaStatus === "ready").length;
    const failedCount = allTasks.filter(
      (t) => t.orcaStatus === "failed",
    ).length;

    // Budget
    const costInWindow = sumCostInWindow(
      db,
      budgetWindowStart(config.budgetWindowHours),
    );

    console.log("=== Orca Status ===");
    console.log();
    console.log(
      `Active sessions: ${activeCount}${activeTaskIds.length > 0 ? ` [${activeTaskIds.join(", ")}]` : ""}`,
    );
    console.log(`Queued tasks:    ${readyCount}`);
    console.log(
      `Budget:          $${costInWindow.toFixed(2)} / $${config.budgetMaxCostUsd.toFixed(2)} (${config.budgetWindowHours}h window)`,
    );
    console.log(`Failed tasks:    ${failedCount}`);
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
