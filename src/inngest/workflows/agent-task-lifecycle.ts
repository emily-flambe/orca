/**
 * Agent task lifecycle — handles agent tasks independently from the main
 * task-lifecycle and cron-task-lifecycle. Agent tasks respect the global
 * concurrency cap. Memories are injected via --append-system-prompt.
 *
 * Steps: claim → load memories → spawn implement → wait → finalize → cleanup
 */

import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  getAgent,
  getAgentMemories,
  updateAgentLastRunStatus,
  deleteTask,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import { emitTaskUpdated, emitInvocationStarted } from "../../events.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import { getHookUrl } from "../../hooks.js";
import { activeHandles } from "../../session-handles.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { getSchedulerDeps } from "../deps.js";
import {
  assertAgentSessionCapacity,
  bridgeSessionCompletion,
  buildDisallowedTools,
  buildOrcaMcpServers,
} from "./task-lifecycle.js";
import type { AgentMemoryRow } from "../../db/queries.js";

const logger = createLogger("inngest/agent-lifecycle");

function log(message: string): void {
  logger.info(message);
}

const SESSION_TIMEOUT = "60m";
const WORKFLOW_TIMEOUT = "2h";

/**
 * Format agent memories as markdown for injection into the system prompt.
 * Groups by type, most recent first within each group.
 */
function formatMemoriesForPrompt(memories: AgentMemoryRow[]): string {
  if (memories.length === 0) return "";

  const episodic = memories.filter((m) => m.type === "episodic");
  const semantic = memories.filter((m) => m.type === "semantic");
  const procedural = memories.filter((m) => m.type === "procedural");

  const sections: string[] = ["## Your Memory\n"];

  if (episodic.length > 0) {
    sections.push("### Recent Events (Episodic)");
    for (const m of episodic) {
      const date = m.createdAt.split("T")[0];
      sections.push(`- [${date}] ${m.content}`);
    }
    sections.push("");
  }

  if (semantic.length > 0) {
    sections.push("### Knowledge (Semantic)");
    for (const m of semantic) {
      sections.push(`- ${m.content}`);
    }
    sections.push("");
  }

  if (procedural.length > 0) {
    sections.push("### Procedures (Procedural)");
    for (const m of procedural) {
      sections.push(`- ${m.content}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export const agentTaskLifecycle = inngest.createFunction(
  {
    id: "agent-task-lifecycle",
    concurrency: [
      {
        limit: parseInt(process.env.ORCA_AGENT_CONCURRENCY_CAP ?? "12", 10),
      },
      { limit: 1, key: "event.data.linearIssueId" },
    ],
    cancelOn: [
      {
        event: "task/cancelled" as const,
        if: "async.data.linearIssueId == event.data.linearIssueId",
      },
    ],
    timeouts: { finish: WORKFLOW_TIMEOUT },
    retries: 0,
  },
  {
    event: "task/ready" as const,
    if: "event.data.taskType == 'agent'",
  },
  async ({ event, step }) => {
    const taskId = event.data.linearIssueId;

    log(`agent workflow started for task ${taskId}`);

    // Step 1: Claim task
    const claimResult = await step.run(
      "claim-task",
      (): { claimed: boolean; reason?: string } => {
        const { db } = getSchedulerDeps();

        try {
          assertAgentSessionCapacity(db);
        } catch (err) {
          const reason =
            err instanceof Error ? err.message : "session cap reached";
          // Capacity blocked — delete the task so agent can re-dispatch next schedule
          const task = getTask(db, taskId);
          if (task && task.orcaStatus === "ready") {
            deleteTask(db, taskId);
            log(
              `agent task ${taskId}: capacity blocked, deleted task for re-dispatch`,
            );
          }
          return { claimed: false, reason };
        }

        const task = getTask(db, taskId);
        if (!task) return { claimed: false, reason: "task not found" };

        const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
        if (!claimed) {
          return {
            claimed: false,
            reason: `not in ready state (current: ${task.orcaStatus})`,
          };
        }

        emitTaskUpdated(getTask(db, taskId)!);
        return { claimed: true };
      },
    );

    if (!claimResult.claimed) {
      log(`agent task ${taskId}: claim failed — ${claimResult.reason}`);
      return { outcome: "not_claimed", reason: claimResult.reason };
    }

    // Step 2: Load agent + memories, spawn session
    const implementCtx = await step.run(
      "start-agent-session",
      (): {
        invocationId: number;
        worktreePath: string;
        branchName: string;
        agentId: string | null;
      } | null => {
        const { db, config } = getSchedulerDeps();
        const task = getTask(db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);

        try {
          assertAgentSessionCapacity(db);
        } catch (err) {
          const reason =
            err instanceof Error ? err.message : "session cap reached";
          log(
            `agent task ${taskId}: spawn blocked (${reason}), resetting to ready`,
          );
          updateTaskStatus(db, taskId, "ready");
          emitTaskUpdated(getTask(db, taskId)!);
          return null;
        }

        // Load agent definition and memories
        const agentId = task.agentId;
        const agent = agentId ? getAgent(db, agentId) : null;
        const model = agent?.model ?? "opus";
        const maxTurns = agent?.maxTurns ?? config.defaultMaxTurns;

        // Build system prompt with memories
        let systemPrompt = config.implementSystemPrompt || "";
        if (agent && agentId) {
          const memories = getAgentMemories(db, agentId);
          const memoryBlock = formatMemoriesForPrompt(memories);
          if (memoryBlock) {
            systemPrompt = systemPrompt
              ? `${systemPrompt}\n\n${memoryBlock}`
              : memoryBlock;
          }
        }

        const repoPath = task.repoPath || agent?.repoPath || config.defaultCwd;
        if (!repoPath) {
          throw new Error(
            `agent task ${taskId}: no repoPath — set repoPath on the agent or ORCA_DEFAULT_CWD`,
          );
        }
        const wtResult = createWorktree(repoPath, taskId, 0);
        const { worktreePath, branchName } = wtResult;

        const now = new Date().toISOString();
        const invocationId = insertInvocation(db, {
          linearIssueId: taskId,
          startedAt: now,
          status: "running",
          phase: "implement",
          model,
          worktreePath,
          branchName,
          logPath: "logs/0.ndjson",
        });
        updateInvocation(db, invocationId, {
          logPath: `logs/${invocationId}.ndjson`,
        });

        // Build MCP config with ORCA_AGENT_ID for memory write tools
        const baseMcpServers = buildOrcaMcpServers(config) ?? {};
        const mcpServers = agentId
          ? Object.fromEntries(
              Object.entries(baseMcpServers).map(([name, cfg]) => [
                name,
                "command" in cfg
                  ? {
                      ...cfg,
                      env: { ...cfg.env, ORCA_AGENT_ID: agentId },
                    }
                  : cfg,
              ]),
            )
          : baseMcpServers;

        const handle = spawnSession({
          agentPrompt: task.agentPrompt ?? "",
          worktreePath,
          maxTurns,
          invocationId,
          projectRoot: process.cwd(),
          claudePath: config.claudePath,
          appendSystemPrompt: systemPrompt || undefined,
          disallowedTools: buildDisallowedTools(config),
          repoPath: task.repoPath,
          model,
          mcpServers:
            Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
          hookUrl: getHookUrl(invocationId),
        });

        bridgeSessionCompletion(
          invocationId,
          taskId,
          "implement",
          handle,
          branchName,
          worktreePath,
        );

        emitInvocationStarted({ taskId, invocationId });
        emitTaskUpdated(getTask(db, taskId)!);

        log(
          `agent task ${taskId}: session spawned as invocation ${invocationId}`,
        );
        return { invocationId, worktreePath, branchName, agentId };
      },
    );

    if (!implementCtx) return { outcome: "capacity_blocked" };

    // Step 3: Wait for session to complete
    const sessionEvent = await step.waitForEvent("await-session", {
      event: "session/completed",
      if: `async.data.invocationId == ${implementCtx.invocationId}`,
      timeout: SESSION_TIMEOUT,
    });

    // Step 4: Finalize
    const timedOut = !sessionEvent;
    const succeeded = sessionEvent && sessionEvent.data.exitCode === 0;

    const result = await step.run("finalize-agent-task", () => {
      const { db } = getSchedulerDeps();
      const { invocationId, agentId } = implementCtx;
      const task = getTask(db, taskId);
      if (!task) return { outcome: "permanent_fail" as const };

      if (timedOut) {
        log(
          `agent task ${taskId}: session timed out (invocation ${invocationId})`,
        );
        const handle = activeHandles.get(invocationId);
        if (handle) {
          killSession(handle).catch(() => {});
          activeHandles.delete(invocationId);
        }
        updateInvocation(db, invocationId, {
          status: "timed_out",
          endedAt: new Date().toISOString(),
          outputSummary: `agent session timed out after ${SESSION_TIMEOUT}`,
        });
        updateTaskStatus(db, taskId, "failed", {
          reason: "agent_session_timeout",
        });
        if (agentId) updateAgentLastRunStatus(db, agentId, "failed");
        emitTaskUpdated(getTask(db, taskId)!);
        return { outcome: "permanent_fail" as const };
      }

      if (succeeded) {
        updateTaskStatus(db, taskId, "done", {
          reason: "agent_session_succeeded",
        });
        if (agentId) updateAgentLastRunStatus(db, agentId, "success");
        emitTaskUpdated(getTask(db, taskId)!);
        log(`agent task ${taskId} completed successfully`);
        return { outcome: "done" as const };
      }

      updateTaskStatus(db, taskId, "failed", {
        reason: "agent_session_failed",
      });
      if (agentId) updateAgentLastRunStatus(db, agentId, "failed");
      emitTaskUpdated(getTask(db, taskId)!);
      log(
        `agent task ${taskId} failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
      );
      return { outcome: "permanent_fail" as const };
    });

    // Step 5: Cleanup worktree
    if (implementCtx.worktreePath) {
      await step.run("cleanup-worktree", () => {
        try {
          removeWorktree(implementCtx.worktreePath);
        } catch (err) {
          log(
            `failed to remove agent worktree ${implementCtx.worktreePath}: ${err}`,
          );
        }
      });
    }

    return { outcome: result.outcome };
  },
);
