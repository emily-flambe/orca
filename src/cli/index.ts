import { Command } from "commander";
import { loadConfig } from "../config/index.js";
import { createDb } from "../db/index.js";
import {
  insertTask,
  getAllTasks,
  getRunningInvocations,
  sumCostInWindow,
  updateInvocation,
} from "../db/queries.js";
import { startScheduler, activeHandles } from "../scheduler/index.js";

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
  .action(() => {
    const config = loadConfig();
    const db = createDb(config.dbPath);

    const scheduler = startScheduler(db, config);

    console.log(
      `Orca scheduler started (concurrency: ${config.concurrencyCap}, interval: ${config.schedulerIntervalSec}s)`,
    );

    // 8.1 Graceful shutdown
    const shutdown = () => {
      console.log("Orca shutting down...");

      // Stop the scheduler (clears interval, kills active sessions)
      scheduler.stop();

      // Mark all running invocations as failed with shutdown note
      const running = getRunningInvocations(db);
      for (const inv of running) {
        updateInvocation(db, inv.id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          outputSummary: "interrupted by shutdown",
        });
      }

      // Allow a short delay for cleanup before exiting
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
