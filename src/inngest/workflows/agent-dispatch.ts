/**
 * Agent dispatch workflow.
 *
 * Runs every minute to poll the agents table for due agents and dispatch them.
 * Creates a task with taskType='agent' and emits task/ready, which is picked up
 * by the agent-task-lifecycle workflow.
 */

import { inngest } from "../client.js";
import { getSchedulerDeps, isReady } from "../deps.js";
import {
  getDueAgents,
  getTask,
  insertTask,
  incrementAgentRunCount,
  updateAgentLastRunStatus,
} from "../../db/queries.js";
import { computeNextRunAt } from "../../cron/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-dispatch");

export const agentDispatchWorkflow = inngest.createFunction(
  {
    id: "agent-dispatch",
    retries: 1,
  },
  { cron: "* * * * *" },
  async ({ step }) => {
    const dueAgents = await step.run("get-due-agents", () => {
      // Skip if deps aren't initialized yet (startup grace period).
      // The next cron tick (in 1 minute) will pick up any due agents.
      if (!isReady()) return [] as ReturnType<typeof getDueAgents>;
      const { db } = getSchedulerDeps();
      const now = new Date().toISOString();
      return getDueAgents(db, now);
    });

    if (dueAgents.length === 0) {
      return { dispatched: 0 };
    }

    logger.info(`found ${dueAgents.length} due agent(s)`);

    let dispatched = 0;

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

      dispatched++;
    }

    logger.info(`dispatched ${dispatched} agent task(s)`);
    return { dispatched };
  },
);
