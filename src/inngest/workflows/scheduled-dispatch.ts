/**
 * Scheduled dispatch workflow.
 *
 * Runs every minute to poll both:
 * - `agents` table for due scheduled agents (dispatches as taskType='agent')
 * - `cron_schedules` table for due cron tasks (shell: runs inline; claude: dispatches as taskType='cron_claude')
 *
 * Replaces the separate agent-dispatch and cron-dispatch workflows.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../client.js";
import { getSchedulerDeps, isReady } from "../deps.js";
import {
  getDueAgents,
  getDueCronSchedules,
  getTask,
  insertTask,
  incrementAgentRunCount,
  updateAgentLastRunStatus,
  incrementCronRunCount,
  updateCronLastRunStatus,
  insertCronRun,
  completeCronRun,
  getActiveCronTaskByScheduleId,
} from "../../db/queries.js";
import { computeNextRunAt } from "../../cron/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("scheduled-dispatch");

// ---------------------------------------------------------------------------
// Cron prompt interpolation
// ---------------------------------------------------------------------------

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
 *   {{ORCA_PORT}}      -> active port (e.g. 4000)
 *   {{ORCA_BASE_URL}}  -> http://localhost:<activePort>
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

// ---------------------------------------------------------------------------
// Combined dispatch workflow
// ---------------------------------------------------------------------------

export const scheduledDispatchWorkflow = inngest.createFunction(
  {
    id: "scheduled-dispatch",
    retries: 1,
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    // -----------------------------------------------------------------------
    // Phase 1: Agent dispatch
    // -----------------------------------------------------------------------

    const dueAgents = await step.run("get-due-agents", () => {
      // Skip if deps aren't initialized yet (startup grace period).
      // The next cron tick (in 1 minute) will pick up any due agents.
      if (!isReady()) return [] as ReturnType<typeof getDueAgents>;
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      return getDueAgents(db, now);
    });

    let agentDispatched = 0;

    if (dueAgents.length > 0) {
      logger.info(`found ${dueAgents.length} due agent(s)`);

      for (const agent of dueAgents) {
        await step.run(`dispatch-agent-${agent.id}`, async () => {
          const { db, config } = getSchedulerDeps();
          const now = new Date().toISOString();
          const taskId = `agent-${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          try {
            insertTask(db, {
              linearIssueId: taskId,
              agentPrompt: agent.systemPrompt,
              repoPath: agent.repoPath || config.defaultCwd || "",
              lifecycleStage: "ready",
              taskType: "agent",
              agentId: agent.id,
              createdAt: now,
              updatedAt: now,
              priority: 0,
              retryCount: 0,
              mergeAttemptCount: 0,
              isParent: 0,
            });

            const nextRunAt = agent.schedule
              ? computeNextRunAt(agent.schedule)
              : null;
            incrementAgentRunCount(db, agent.id, nextRunAt);

            const agentTask = getTask(db, taskId);
            if (agentTask) {
              await inngest.send({
                name: "task/ready",
                data: {
                  linearIssueId: agentTask.linearIssueId,
                  repoPath: agentTask.repoPath,
                  priority: agentTask.priority,
                  projectName: agentTask.projectName ?? null,
                  taskType: agentTask.taskType ?? "agent",
                  createdAt: agentTask.createdAt,
                },
              });
            }

            logger.info(
              `[agent-${agent.id}] dispatched task ${taskId} for agent "${agent.name}"`,
            );
          } catch (err) {
            updateAgentLastRunStatus(db, agent.id, "failed");
            logger.error(
              `[agent-${agent.id}] failed to dispatch task for agent "${agent.name}": ${err}`,
            );
            throw err;
          }
        });

        agentDispatched++;
      }
    }

    // -----------------------------------------------------------------------
    // Phase 2: Cron schedule dispatch
    // -----------------------------------------------------------------------

    const dueSchedules = await step.run("get-due-schedules", () => {
      if (!isReady()) return [] as ReturnType<typeof getDueCronSchedules>;
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      return getDueCronSchedules(db, now);
    });

    let cronDispatched = 0;

    if (dueSchedules.length > 0) {
      logger.info(`found ${dueSchedules.length} due cron schedule(s)`);

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
              const stdout = execSync(
                interpolateCronPrompt(schedule.prompt),
                {
                  cwd,
                  timeout: 60_000,
                  stdio: "pipe",
                  encoding: "utf8",
                  shell: process.platform === "win32" ? "bash" : "/bin/sh",
                },
              );
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
                `[cron-${schedule.id}] skipping dispatch — previous run still active: ${activeTask.linearIssueId} (stage=${activeTask.lifecycleStage}, phase=${activeTask.currentPhase})`,
              );
              return;
            }

            const now = new Date().toISOString();
            const taskId = `cron-${schedule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

            try {
              insertTask(db, {
                linearIssueId: taskId,
                agentPrompt: interpolateCronPrompt(schedule.prompt),
                repoPath: schedule.repoPath ?? "",
                lifecycleStage: "ready",
                taskType: "cron_claude",
                cronScheduleId: schedule.id,
                createdAt: now,
                updatedAt: now,
                priority: 0,
                retryCount: 0,
                mergeAttemptCount: 0,
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

        cronDispatched++;
      }
    }

    const total = agentDispatched + cronDispatched;
    if (total > 0) {
      logger.info(
        `dispatched ${total} task(s) (${agentDispatched} agent, ${cronDispatched} cron)`,
      );
    }
    return { dispatched: total, agentDispatched, cronDispatched };
  },
);
