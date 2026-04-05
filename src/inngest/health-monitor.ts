/**
 * Inngest self-healing health monitor.
 *
 * Polls the Inngest server every 30 seconds. After 3 consecutive failures
 * (90s of downtime), attempts to restart Inngest via PM2. After a successful
 * restart, re-emits task/ready events for dispatchable tasks so they are not
 * stranded.
 */

import { execSync } from "child_process";
import { createLogger } from "../logger.js";
import { getAllTasks } from "../db/queries.js";
import type { OrcaDb } from "../db/index.js";
import type { InngestClient } from "./client.js";

const logger = createLogger("inngest-health");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const FAILURE_THRESHOLD = 3; // consecutive failures before restart
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes after a restart attempt
const POST_RESTART_WAIT_MS = 10_000; // wait after restart before re-checking
const HEALTH_TIMEOUT_MS = 5_000; // fetch timeout for health check

// ---------------------------------------------------------------------------
// Metrics (exported for status API)
// ---------------------------------------------------------------------------

export interface InngestHealthMetrics {
  restartAttempts: number;
  restartSuccesses: number;
  consecutiveFailures: number;
  lastRestartAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  isInCooldown: boolean;
}

let metrics: InngestHealthMetrics = {
  restartAttempts: 0,
  restartSuccesses: 0,
  consecutiveFailures: 0,
  lastRestartAttemptAt: null,
  lastSuccessfulCheckAt: null,
  isInCooldown: false,
};

export function getInngestHealthMetrics(): InngestHealthMetrics {
  return { ...metrics };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let lastRestartAttemptAt = 0; // epoch ms
let inngestBaseUrl = "http://localhost:8288";

// Stored references for re-emission
let storedInngest: InngestClient | null = null;
let storedDb: OrcaDb | null = null;

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkInngestHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(inngestBaseUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PM2 restart
// ---------------------------------------------------------------------------

function attemptPm2Restart(): boolean {
  logger.info("Attempting to restart Inngest via PM2...");
  metrics.restartAttempts++;
  metrics.lastRestartAttemptAt = new Date().toISOString();

  try {
    execSync("pm2 restart inngest", {
      timeout: 15_000,
      stdio: "pipe",
    });
    logger.info("pm2 restart inngest succeeded");
    return true;
  } catch (err) {
    logger.warn(`pm2 restart inngest failed: ${err}`);
  }

  // Fallback: delete and re-create from ecosystem config
  try {
    logger.info(
      "Fallback: pm2 delete inngest && pm2 start ecosystem.config.cjs --only inngest",
    );
    execSync("pm2 delete inngest", {
      timeout: 10_000,
      stdio: "pipe",
    });
    execSync("pm2 start ecosystem.config.cjs --only inngest", {
      timeout: 15_000,
      stdio: "pipe",
      cwd: process.cwd(),
    });
    logger.info("pm2 fallback restart succeeded");
    return true;
  } catch (err) {
    logger.error(`pm2 fallback restart also failed: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Re-emit task/ready events for stranded tasks
// ---------------------------------------------------------------------------

function reEmitDispatchableEvents(): void {
  if (!storedInngest || !storedDb) return;

  let dispatchableTasks;
  try {
    dispatchableTasks = getAllTasks(storedDb).filter(
      (t) =>
        t.lifecycleStage === "ready" ||
        (t.lifecycleStage === "active" && t.currentPhase === "fix"),
    );
  } catch (err) {
    logger.warn(`Failed to query dispatchable tasks: ${err}`);
    return;
  }

  if (dispatchableTasks.length === 0) return;

  for (const task of dispatchableTasks) {
    storedInngest
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
          `Failed to re-emit task/ready for ${task.linearIssueId}: ${err}`,
        ),
      );
  }

  logger.info(
    `Re-emitted task/ready for ${dispatchableTasks.length} task(s) after Inngest restart: ${dispatchableTasks.map((t) => `${t.linearIssueId}(stage=${t.lifecycleStage}, phase=${t.currentPhase})`).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const healthy = await checkInngestHealth();

  if (healthy) {
    if (consecutiveFailures > 0) {
      logger.info(
        `Inngest recovered after ${consecutiveFailures} consecutive failure(s)`,
      );
    }
    consecutiveFailures = 0;
    metrics.consecutiveFailures = 0;
    metrics.lastSuccessfulCheckAt = new Date().toISOString();
    metrics.isInCooldown = false;
    return;
  }

  consecutiveFailures++;
  metrics.consecutiveFailures = consecutiveFailures;
  logger.warn(
    `Inngest health check failed (${consecutiveFailures}/${FAILURE_THRESHOLD})`,
  );

  if (consecutiveFailures < FAILURE_THRESHOLD) return;

  // Check cooldown
  const now = Date.now();
  if (now - lastRestartAttemptAt < COOLDOWN_MS) {
    metrics.isInCooldown = true;
    logger.info(
      `Skipping restart — in cooldown until ${new Date(lastRestartAttemptAt + COOLDOWN_MS).toISOString()}`,
    );
    return;
  }

  lastRestartAttemptAt = now;
  const restarted = attemptPm2Restart();

  if (!restarted) {
    logger.error(
      "All PM2 restart attempts failed. Inngest remains unreachable.",
    );
    return;
  }

  // Wait for Inngest to come up, then verify
  logger.info(
    `Waiting ${POST_RESTART_WAIT_MS / 1000}s for Inngest to come up...`,
  );
  await new Promise((resolve) => setTimeout(resolve, POST_RESTART_WAIT_MS));

  const healthyAfterRestart = await checkInngestHealth();
  if (healthyAfterRestart) {
    logger.info("Inngest is healthy after restart");
    metrics.restartSuccesses++;
    consecutiveFailures = 0;
    metrics.consecutiveFailures = 0;
    metrics.lastSuccessfulCheckAt = new Date().toISOString();
    metrics.isInCooldown = false;

    // Re-emit events for stranded tasks
    reEmitDispatchableEvents();
  } else {
    logger.error(
      "Inngest still unreachable after restart. Will retry after cooldown.",
    );
    metrics.isInCooldown = true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startInngestHealthMonitor(
  inngestClient: InngestClient,
  db: OrcaDb,
): void {
  if (intervalHandle) {
    logger.warn("Health monitor already running — skipping duplicate start");
    return;
  }

  storedInngest = inngestClient;
  storedDb = db;
  inngestBaseUrl = process.env.INNGEST_BASE_URL || "http://localhost:8288";

  // Reset metrics
  metrics = {
    restartAttempts: 0,
    restartSuccesses: 0,
    consecutiveFailures: 0,
    lastRestartAttemptAt: null,
    lastSuccessfulCheckAt: null,
    isInCooldown: false,
  };
  consecutiveFailures = 0;
  lastRestartAttemptAt = 0;

  intervalHandle = setInterval(() => {
    tick().catch((err) => logger.error(`Health monitor tick error: ${err}`));
  }, CHECK_INTERVAL_MS);

  logger.info(
    `Started (interval=${CHECK_INTERVAL_MS / 1000}s, threshold=${FAILURE_THRESHOLD}, cooldown=${COOLDOWN_MS / 60000}min, url=${inngestBaseUrl})`,
  );
}

export function stopInngestHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info("Stopped");
  }
  storedInngest = null;
  storedDb = null;
}
