/**
 * Agent task lifecycle — handles agent tasks independently from the main
 * task-lifecycle and cron-task-lifecycle. Agent tasks respect the global
 * concurrency cap. Memories are injected via --append-system-prompt.
 *
 * For synthetic agent tasks (agent-*, cron-*):
 *   Steps: claim → load memories → spawn implement → wait → finalize → cleanup
 *
 * For label-routed Linear tickets:
 *   Steps: claim → load memories → spawn implement → wait → Gate 2 (verify PR)
 *          → transition to awaiting_ci → cleanup
 */

import {
  getTask,
  getInvocation,
  claimTaskForDispatch,
  updateTaskStatus,
  insertInvocation,
  updateInvocation,
  getAgent,
  getAgentMemories,
  updateAgentLastRunStatus,
  deleteTask,
  updateTaskPrBranch,
  updateTaskPrState,
  updateTaskCiInfo,
  updateTaskDeployInfo,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import {
  emitTaskUpdated,
  emitInvocationStarted,
} from "../../events.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import { getHookUrl } from "../../hooks.js";
import { activeHandles } from "../../session-handles.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { runWithLogContext } from "../../logger-context.js";
import { getSchedulerDeps } from "../deps.js";
import {
  assertAgentSessionCapacity,
  bridgeSessionCompletion,
  buildDisallowedTools,
  buildOrcaMcpServers,
} from "./task-lifecycle.js";
import type { AgentMemoryRow } from "../../db/queries.js";
import { finalizeInvocation } from "./finalize-invocation.js";
import {
  worktreeHasNoChanges,
  alreadyDonePatterns,
  updateAndEmit,
  transitionToFinalState,
} from "../workflow-utils.js";
import { writeBackStatus } from "../../linear/sync.js";
import { findPrForBranch, closeSupersededPrs } from "../../github/index.js";

const logger = createLogger("inngest/agent-lifecycle");

function log(message: string): void {
  logger.info(message);
}

/** Real Linear issue IDs don't start with synthetic prefixes. */
function isLinearTicket(taskId: string): boolean {
  return !taskId.startsWith("agent-") && !taskId.startsWith("cron-");
}

const SESSION_TIMEOUT = "60m";
const WORKFLOW_TIMEOUT = "4h";

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

    return runWithLogContext({ taskId }, async () => {
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
            // Capacity blocked — delete synthetic tasks so agent can re-dispatch next schedule
            // Real Linear tickets stay at ready for the reconciler
            const task = getTask(db, taskId);
            if (
              task &&
              task.lifecycleStage === "ready" &&
              !isLinearTicket(taskId)
            ) {
              deleteTask(db, taskId);
              log(
                `agent task ${taskId}: capacity blocked, deleted task for re-dispatch`,
              );
            }
            return { claimed: false, reason };
          }

          const task = getTask(db, taskId);
          if (!task) return { claimed: false, reason: "task not found" };

          const claimed = claimTaskForDispatch(db, taskId);
          if (!claimed) {
            return {
              claimed: false,
              reason: `not in ready state (stage=${task.lifecycleStage}, phase=${task.currentPhase})`,
            };
          }

          emitTaskUpdated(getTask(db, taskId)!);

          // Write back "running" to Linear for assigned tickets
          if (isLinearTicket(taskId)) {
            const { client, stateMap } = getSchedulerDeps();
            writeBackStatus(client, taskId, "running", stateMap).catch(
              (err: unknown) => {
                logger.warn("Linear write-back failed (agent claim)", {
                  taskId,
                  error: String(err),
                });
              },
            );
          }

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

          // Build system prompt with memories.
          // For label-routed tickets the agentPrompt (-p) is the ticket
          // content, so inject the agent's own systemPrompt into
          // appendSystemPrompt so the agent knows HOW to work.
          // For scheduled/manual tasks agentPrompt already IS the
          // systemPrompt, so skip to avoid duplication.
          let systemPrompt = config.implementSystemPrompt || "";
          if (agent && agentId) {
            if (isLinearTicket(taskId) && agent.systemPrompt) {
              systemPrompt =
                agent.systemPrompt +
                (systemPrompt ? `\n\n${systemPrompt}` : "");
            }
            const memories = getAgentMemories(db, agentId);
            const memoryBlock = formatMemoriesForPrompt(memories);
            if (memoryBlock) {
              systemPrompt = systemPrompt
                ? `${systemPrompt}\n\n${memoryBlock}`
                : memoryBlock;
            }
          }

          const repoPath =
            task.repoPath || agent?.repoPath || config.defaultCwd;
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

      // Step 4: Finalize implement phase
      const timedOut = !sessionEvent;
      const succeeded = sessionEvent && sessionEvent.data.exitCode === 0;

      const result = await step.run("finalize-agent-task", () =>
        runWithLogContext(
          { taskId, invocationId: String(implementCtx.invocationId) },
          () => {
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
                killSession(handle).catch((err: unknown) => {
                  logger.warn("killSession failed (agent timeout)", {
                    taskId,
                    invocationId,
                    error: String(err),
                  });
                });
              }
              finalizeInvocation(db, invocationId, "timed_out", {
                outputSummary: `agent session timed out after ${SESSION_TIMEOUT}`,
              });
              updateTaskStatus(db, taskId, "failed", {
                reason: "agent_session_timeout",
                failureReason: `Agent session timed out after ${SESSION_TIMEOUT}`,
                failedPhase: "implement",
              });
              if (agentId) updateAgentLastRunStatus(db, agentId, "failed");
              emitTaskUpdated(getTask(db, taskId)!);
              return { outcome: "permanent_fail" as const };
            }

            if (succeeded) {
              finalizeInvocation(db, invocationId, "completed", {
                costUsd: sessionEvent.data.costUsd ?? null,
                inputTokens: sessionEvent.data.inputTokens ?? null,
                outputTokens: sessionEvent.data.outputTokens ?? null,
              });

              // For synthetic agent tasks, mark done immediately
              if (!isLinearTicket(taskId)) {
                updateTaskStatus(db, taskId, "done", {
                  reason: "agent_session_succeeded",
                });
                if (agentId) updateAgentLastRunStatus(db, agentId, "success");
                emitTaskUpdated(getTask(db, taskId)!);
                log(`agent task ${taskId} completed successfully`);
                return { outcome: "done" as const };
              }

              // For Linear tickets, don't mark done yet — proceed to Gate 2
              log(
                `agent task ${taskId}: implement succeeded, proceeding to Gate 2`,
              );
              return { outcome: "gate2" as const };
            }

            finalizeInvocation(db, invocationId, "failed", {
              costUsd: sessionEvent?.data.costUsd ?? null,
              inputTokens: sessionEvent?.data.inputTokens ?? null,
              outputTokens: sessionEvent?.data.outputTokens ?? null,
            });
            updateTaskStatus(db, taskId, "failed", {
              reason: "agent_session_failed",
              failureReason: `Agent session failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
              failedPhase: "implement",
            });
            if (agentId) updateAgentLastRunStatus(db, agentId, "failed");
            emitTaskUpdated(getTask(db, taskId)!);
            log(
              `agent task ${taskId} failed (exit code: ${sessionEvent?.data.exitCode ?? "timeout"})`,
            );
            return { outcome: "permanent_fail" as const };
          },
        ),
      );

      // -----------------------------------------------------------------------
      // Non-Linear agent tasks: write back + cleanup + return
      // -----------------------------------------------------------------------
      if (result.outcome !== "gate2") {
        if (isLinearTicket(taskId)) {
          await step.run("linear-writeback", async () => {
            const { client, stateMap } = getSchedulerDeps();
            const targetStatus =
              result.outcome === "done" ? "done" : "failed_permanent";
            await transitionToFinalState(
              { client, stateMap },
              taskId,
              targetStatus as Parameters<typeof transitionToFinalState>[2],
            );
          });
        }

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
      }

      // =====================================================================
      // Gate 2 + Review Loop (Linear tickets only)
      // =====================================================================

      const gate2 = await step.run(
        "gate2-verify-pr",
        async (): Promise<{
          outcome: "awaiting_ci" | "done" | "permanent_fail" | "retry";
          prBranch?: string;
          prNumber?: number;
          ciStartedAt?: string;
        }> =>
          runWithLogContext(
            { taskId, invocationId: String(implementCtx.invocationId) },
            async () => {
              const { db, client, stateMap } = getSchedulerDeps();
              const { invocationId, branchName, worktreePath } = implementCtx;
              const task = getTask(db, taskId);
              if (!task) return { outcome: "permanent_fail" };

              const invRecord = getInvocation(db, invocationId);
              const outputSummary =
                invRecord?.outputSummary?.toLowerCase() ?? "";
              const isAlreadyDone = alreadyDonePatterns.some((p) =>
                outputSummary.includes(p),
              );
              const noChanges = await worktreeHasNoChanges(worktreePath);

              if (!branchName) {
                if (isAlreadyDone || noChanges) {
                  log(
                    `agent task ${taskId}: work already on main — marking done`,
                  );
                  updateTaskStatus(db, taskId, "done", {
                    reason: "already_on_main",
                  });
                  emitTaskUpdated(getTask(db, taskId)!);
                  transitionToFinalState(
                    { client, stateMap },
                    taskId,
                    "done",
                  ).catch(() => {});
                  try {
                    removeWorktree(worktreePath);
                  } catch {
                    /* ignore */
                  }
                  return { outcome: "done" };
                }
                updateInvocation(db, invocationId, {
                  status: "failed",
                  endedAt: new Date().toISOString(),
                  outputSummary:
                    "Post-implementation gate failed: no branch name",
                });
                updateAndEmit(db, taskId, "failed", "gate2_no_branch", {
                  failureReason:
                    "Post-implementation gate failed: no branch name",
                  failedPhase: "gate2",
                });
                return { outcome: "permanent_fail" };
              }

              const prInfo = await findPrForBranch(branchName, task.repoPath);

              if (!prInfo.exists) {
                if (isAlreadyDone || noChanges) {
                  log(
                    `agent task ${taskId}: no PR found but work is already done — marking done`,
                  );
                  updateTaskStatus(db, taskId, "done", {
                    reason: "already_done",
                  });
                  emitTaskUpdated(getTask(db, taskId)!);
                  transitionToFinalState(
                    { client, stateMap },
                    taskId,
                    "done",
                  ).catch(() => {});
                  try {
                    removeWorktree(worktreePath);
                  } catch {
                    /* ignore */
                  }
                  return { outcome: "done" };
                }
                log(
                  `agent task ${taskId}: Gate 2 failed — no PR found for branch ${branchName}`,
                );
                updateInvocation(db, invocationId, {
                  status: "failed",
                  endedAt: new Date().toISOString(),
                  outputSummary: `Post-implementation gate failed: no PR found for branch ${branchName}`,
                });
                updateAndEmit(db, taskId, "failed", "gate2_no_pr", {
                  failureReason: `Post-implementation gate failed: no PR found for branch ${branchName}`,
                  failedPhase: "gate2",
                });
                return { outcome: "permanent_fail" };
              }

              // PR found but already merged — the work is done
              if (prInfo.merged) {
                log(
                  `agent task ${taskId}: PR already merged (${prInfo.url}) — marking done`,
                );
                updateTaskStatus(db, taskId, "done", {
                  reason: "pr_already_merged",
                });
                emitTaskUpdated(getTask(db, taskId)!);
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "done",
                ).catch(() => {});
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }
                return { outcome: "done" };
              }

              // PR found — store branch + PR info
              const storedBranch = prInfo.headBranch ?? branchName;
              updateTaskPrBranch(db, taskId, storedBranch);
              if (prInfo.number != null) {
                updateTaskDeployInfo(db, taskId, { prNumber: prInfo.number });
              }
              if (prInfo.url != null || prInfo.state != null) {
                updateTaskPrState(
                  db,
                  taskId,
                  prInfo.url ?? null,
                  prInfo.state ?? null,
                );
              }

              if (prInfo.number != null) {
                try {
                  closeSupersededPrs(
                    taskId,
                    prInfo.number,
                    invocationId,
                    branchName,
                    task.repoPath,
                  );
                } catch {
                  /* ignore */
                }
              }

              if (prInfo.url) {
                client
                  .createAttachment(
                    task.linearIssueId,
                    prInfo.url,
                    "Pull Request",
                  )
                  .catch((err: unknown) => {
                    logger.warn("Linear createAttachment failed", {
                      taskId,
                      error: String(err),
                    });
                  });
              }

              const ciStartedAt = new Date().toISOString();
              updateTaskCiInfo(db, taskId, { ciStartedAt });
              updateAndEmit(db, taskId, "awaiting_ci", "pr_found");
              transitionToFinalState(
                { client, stateMap },
                taskId,
                "awaiting_ci",
                `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${storedBranch}\`, awaiting CI`,
              ).catch((err: unknown) => {
                logger.warn(
                  "transitionToFinalState failed (agent gate2 → awaiting_ci)",
                  { taskId, error: String(err) },
                );
              });

              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }

              log(
                `agent task ${taskId}: Gate 2 passed → awaiting_ci (PR #${prInfo.number ?? "?"})`,
              );
              return {
                outcome: "awaiting_ci",
                prBranch: storedBranch,
                prNumber: prInfo.number,
                ciStartedAt,
              };
            },
          ),
      );

      // Terminal outcomes after Gate 2
      if (gate2.outcome === "done" || gate2.outcome === "permanent_fail") {
        return { outcome: gate2.outcome };
      }

      if (gate2.outcome === "retry") {
        const { db: retryDb } = getSchedulerDeps();
        const retryTask = getTask(retryDb, taskId);
        if (retryTask) {
          await inngest.send({
            name: "task/ready",
            data: {
              linearIssueId: taskId,
              repoPath: retryTask.repoPath,
              priority: retryTask.priority,
              projectName: retryTask.projectName ?? null,
              taskType: retryTask.taskType ?? "agent",
              createdAt: retryTask.createdAt,
            },
          });
        }
        return { outcome: "retry" };
      }

      // -------------------------------------------------------------------
      // Emit task/awaiting-ci to trigger CI gate workflow
      // -------------------------------------------------------------------
      {
        const { db: awaitingDb, config: awaitingConfig } = getSchedulerDeps();
        await inngest.send({
          name: "task/awaiting-ci",
          data: {
            linearIssueId: taskId,
            prNumber: (gate2.prNumber ?? 0) as number,
            prBranchName: (gate2.prBranch ?? "") as string,
            repoPath:
              getTask(awaitingDb, taskId)?.repoPath ??
              awaitingConfig.defaultCwd ??
              "",
            ciStartedAt: gate2.ciStartedAt ?? new Date().toISOString(),
          },
        });
      }

      return { outcome: "awaiting_ci" };
    }); // end runWithLogContext({ taskId })
  },
);
