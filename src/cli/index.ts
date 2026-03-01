import { Command } from "commander";
import {
  loadConfig,
  parseRepoPath,
  validateProjectRepoPaths,
} from "../config/index.js";
import { initLogger, createLogger } from "../logger.js";
import { createDb } from "../db/index.js";
import {
  insertTask,
  getAllTasks,
  getRunningInvocations,
  sumCostInWindow,
  updateInvocation,
  updateTaskStatus,
} from "../db/queries.js";
import { startScheduler } from "../scheduler/index.js";
import { LinearClient } from "../linear/client.js";
import { DependencyGraph } from "../linear/graph.js";
import { fullSync } from "../linear/sync.js";
import { createWebhookRoute } from "../linear/webhook.js";
import { startTunnel, type TunnelHandle } from "../tunnel/index.js";
import { createPoller, type PollerHandle } from "../linear/poller.js";
import { createApiRoutes } from "../api/routes.js";
import { removeWorktree } from "../worktree/index.js";
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
    (opts: {
      prompt: string;
      repo: string;
      priority: string;
      id?: string;
    }) => {
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
  .action(async () => {
    const config = loadConfig();
    initLogger({ logPath: config.logPath, maxSizeMb: config.logMaxSizeMb });
    const logger = createLogger("cli");
    const db = createDb(config.dbPath);

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
      });
    }
    if (orphanedInvocations.length > 0) {
      logger.info(
        `marked ${orphanedInvocations.length} orphaned invocation(s) as failed`,
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
        recovered++;
      }
    }
    if (recovered > 0) {
      logger.info(`recovered ${recovered} orphaned task(s) → ready`);
    }

    // Full sync: populate tasks table + dependency graph
    await fullSync(db, client, graph, config);

    // Fetch workflow states for write-back (state name → state UUID)
    const teamIds = [
      ...new Set(projectMeta.flatMap((pm) => pm.teamIds)),
    ];
    const stateMap = await client.fetchWorkflowStates(teamIds);

    // Start Hono HTTP server with webhook endpoint
    const webhookApp = createWebhookRoute({
      db,
      client,
      graph,
      config,
      stateMap,
    });

    // Create API routes
    const apiApp = createApiRoutes({
      db,
      config,
      syncTasks: () => fullSync(db, client, graph, config, stateMap),
      client,
      stateMap,
    });

    const app = new Hono();
    app.route("/", webhookApp);
    app.route("/", apiApp);

    // Static files + SPA fallback (after API routes so API takes priority)
    app.use("/*", serveStatic({ root: "./web/dist" }));
    app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));

    serve({ fetch: app.fetch, port: config.port });
    logger.info(`Hono server listening on port ${config.port}`);

    // Start cloudflared tunnel
    const tunnel: TunnelHandle = startTunnel({
      cloudflaredPath: config.cloudflaredPath,
      token: config.tunnelToken || undefined,
    });

    // Start polling fallback (activates when tunnel is down)
    const poller: PollerHandle = createPoller({
      db,
      client,
      graph,
      config,
      stateMap,
      isTunnelConnected: () => tunnel.isTunnelConnected(),
    });
    poller.start();

    // Start scheduler
    const scheduler = startScheduler({ db, config, graph, client, stateMap });

    logger.info(
      `Orca scheduler started (concurrency: ${config.concurrencyCap}, interval: ${config.schedulerIntervalSec}s)`,
    );

    // Graceful shutdown
    const shutdown = () => {
      logger.info("Orca shutting down...");

      // Stop scheduler (clears interval, kills active sessions)
      scheduler.stop();

      // Stop polling fallback
      poller.stop();

      // Stop cloudflared tunnel
      tunnel.stop();

      // Mark all running invocations as failed AND reset their tasks to
      // "ready" so they re-enter the dispatch queue on next startup.
      // Without this, tasks stay orphaned in "running" state forever.
      const running = getRunningInvocations(db);
      for (const inv of running) {
        updateInvocation(db, inv.id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          outputSummary: "interrupted by shutdown",
        });
        updateTaskStatus(db, inv.linearIssueId, "ready");

        // Best-effort worktree cleanup for interrupted sessions
        if (inv.worktreePath) {
          try {
            removeWorktree(inv.worktreePath);
          } catch {
            // Worktree may already be removed or in a bad state — ignore
          }
        }
      }

      setTimeout(() => {
        process.exit(0);
      }, 500);
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
    const windowStart = new Date(
      Date.now() - config.budgetWindowHours * 60 * 60 * 1000,
    ).toISOString();
    const costInWindow = sumCostInWindow(db, windowStart);

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
// Parse
// ---------------------------------------------------------------------------

program.parse();
