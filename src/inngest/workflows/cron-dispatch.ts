/**
 * Cron dispatch workflow.
 *
 * Runs every minute to poll cron_schedules for due tasks and dispatch them.
 * - `claude` type: creates a task and sends it through task-lifecycle.
 * - `shell` type: executes the command directly in a child process.
 */

import { execSync } from "node:child_process";
import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  getDueCronSchedules,
  getTask,
  insertTask,
  incrementCronRunCount,
  updateCronLastRunStatus,
  insertCronRun,
  completeCronRun,
  getActiveCronTaskByScheduleId,
} from "../../db/queries.js";
import { computeNextRunAt } from "../../cron/index.js";
import { createLogger } from "../../logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const logger = createLogger("cron-dispatch");

/**
 * Resolve the active Orca port from deploy-state.json.
 * Falls back to ORCA_PORT env var, then 4000.
 */
function getActivePort(): number {
  try {
    const statePath = join(process.cwd(), "deploy-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.activePort) return state.activePort;
  } catch {
    // deploy-state.json missing or unreadable
  }
  return parseInt(process.env.ORCA_PORT ?? "4000", 10);
}

/**
 * Replace template variables in cron prompts so they stay correct
 * across blue/green deploys.
 *
 * Supported variables:
 *   {{ORCA_PORT}}      → active port (e.g. 4000)
 *   {{ORCA_BASE_URL}}  → http://localhost:<activePort>
 *
 * Also re-interpolates already-substituted ports so that cron tasks
 * created by an old instance (with a stale port baked in) get the
 * correct port when they run on a new instance after a blue/green deploy.
 */
export function interpolateCronPrompt(prompt: string): string {
  const port = getActivePort();
  // Replace any previously-substituted port numbers (e.g. "localhost:4001")
  // so blue/green deploy doesn't leave stale ports in already-dispatched tasks.
  const portFixed = prompt.replace(
    /localhost:(\d{4,5})(?=\/api\/)/g,
    `localhost:${port}`,
  );
  return portFixed
    .replace(/\{\{ORCA_PORT\}\}/g, String(port))
    .replace(/\{\{ORCA_BASE_URL\}\}/g, `http://localhost:${port}`);
}

// Internal alias for backward compat within this file
function interpolatePrompt(prompt: string): string {
  return interpolateCronPrompt(prompt);
}

export const cronDispatchWorkflow = inngest.createFunction(
  {
    id: "cron-dispatch",
    retries: 1,
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    const dueSchedules = await step.run("get-due-schedules", () => {
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      return getDueCronSchedules(db, now);
    });

    if (dueSchedules.length === 0) {
      return { dispatched: 0 };
    }

    logger.info(`found ${dueSchedules.length} due cron schedule(s)`);

    let dispatched = 0;

    for (const schedule of dueSchedules) {
      if (schedule.type === "shell") {
        // Shell cron: execute command directly, no task-lifecycle needed
        await step.run(`run-shell-cron-${schedule.id}`, () => {
          const { db } = getSchedulerDeps();
          const startedAt = new Date().toISOString();
          const startMs = Date.now();
          const runId = insertCronRun(db, {
            cronScheduleId: schedule.id,
            startedAt,
            status: "running",
          });
          try {
            const cwd = schedule.repoPath || process.cwd();
            const stdout = execSync(interpolatePrompt(schedule.prompt), {
              cwd,
              timeout: 60_000,
              stdio: "pipe",
              encoding: "utf8",
              shell: process.platform === "win32" ? "bash" : "/bin/sh",
            });
            const durationMs = Date.now() - startMs;
            const output =
              typeof stdout === "string" ? stdout.slice(0, 10_000) : null;
            completeCronRun(db, runId, {
              endedAt: new Date().toISOString(),
              status: "success",
              output,
              durationMs,
            });
            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "success");
            logger.info(
              `[cron-${schedule.id}] shell command succeeded for "${schedule.name}"`,
            );
          } catch (err) {
            const durationMs = Date.now() - startMs;
            let output: string | null = null;
            if (err && typeof err === "object" && "stderr" in err) {
              const stderr = (err as { stderr?: unknown }).stderr;
              if (typeof stderr === "string") {
                output = stderr.slice(0, 10_000);
              }
            }
            if (!output && err instanceof Error) {
              output = err.message.slice(0, 10_000);
            }
            completeCronRun(db, runId, {
              endedAt: new Date().toISOString(),
              status: "failed",
              output,
              durationMs,
            });
            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "failed");
            logger.error(
              `[cron-${schedule.id}] shell command failed for "${schedule.name}": ${err}`,
            );
          }
        });
      } else {
        // Claude cron: create a task and send through task-lifecycle
        await step.run(`dispatch-cron-${schedule.id}`, async () => {
          const { db } = getSchedulerDeps();

          // Skip if a previous run of this cron is still active (prevents
          // concurrent executions when a task takes longer than its schedule interval)
          const activeTask = getActiveCronTaskByScheduleId(db, schedule.id);
          if (activeTask) {
            logger.info(
              `[cron-${schedule.id}] skipping dispatch — previous run still active: ${activeTask.linearIssueId} (${activeTask.orcaStatus})`,
            );
            return;
          }

          const now = new Date().toISOString();
          const taskId = `cron-${schedule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          try {
            insertTask(db, {
              linearIssueId: taskId,
              agentPrompt: interpolatePrompt(schedule.prompt),
              repoPath: schedule.repoPath ?? "",
              orcaStatus: "ready",
              taskType: "cron_claude",
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

            incrementCronRunCount(
              db,
              schedule.id,
              computeNextRunAt(schedule.schedule),
            );
            updateCronLastRunStatus(db, schedule.id, "success");

            const cronTask = getTask(db, taskId);
            if (cronTask) {
              await inngest.send({
                name: "task/ready",
                data: {
                  linearIssueId: cronTask.linearIssueId,
                  repoPath: cronTask.repoPath,
                  priority: cronTask.priority,
                  projectName: cronTask.projectName ?? null,
                  taskType: cronTask.taskType ?? "standard",
                  createdAt: cronTask.createdAt,
                },
              });
            }

            logger.info(
              `[cron-${schedule.id}] dispatched task ${taskId} for schedule "${schedule.name}"`,
            );
          } catch (err) {
            updateCronLastRunStatus(db, schedule.id, "failed");
            logger.error(
              `[cron-${schedule.id}] failed to dispatch task for schedule "${schedule.name}": ${err}`,
            );
            throw err;
          }
        });
      }

      dispatched++;
    }

    logger.info(`dispatched ${dispatched} cron task(s)`);
    return { dispatched };
  },
);
