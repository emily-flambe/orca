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
 *          → review loop (spawn review → wait → parse → spawn fix → wait → repeat)
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
  incrementReviewCycleCount,
  getLastCompletedImplementInvocation,
  resetStaleSessionRetryCount,
  clearSessionIds,
  insertSystemEvent,
  getTaskStateTransitions,
} from "../../db/queries.js";
import { spawnSession, killSession } from "../../runner/index.js";
import {
  emitTaskUpdated,
  emitInvocationStarted,
  emitInvocationCompleted,
} from "../../events.js";
import { createWorktree, removeWorktree } from "../../worktree/index.js";
import { getHookUrl } from "../../hooks.js";
import { getDefaultBranch } from "../../git.js";
import { activeHandles } from "../../session-handles.js";
import { inngest } from "../client.js";
import { createLogger } from "../../logger.js";
import { runWithLogContext } from "../../logger-context.js";
import { getSchedulerDeps } from "../deps.js";
import {
  assertAgentSessionCapacity,
  assertSessionCapacity,
  bridgeSessionCompletion,
  buildDisallowedTools,
  buildOrcaMcpServers,
} from "./task-lifecycle.js";
import type { AgentMemoryRow } from "../../db/queries.js";
import { finalizeInvocation } from "./finalize-invocation.js";
import {
  extractMarkerFromLog,
  worktreeHasNoChanges,
  alreadyDonePatterns,
  updateAndEmit,
  transitionToFinalState,
} from "../workflow-utils.js";
import { writeBackStatus } from "../../linear/sync.js";
import {
  findPrForBranch,
  closeSupersededPrs,
} from "../../github/index.js";

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

          const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
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
          outcome: "in_review" | "done" | "permanent_fail" | "retry";
          prBranch?: string;
          prNumber?: number;
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

              resetStaleSessionRetryCount(db, taskId);
              updateAndEmit(db, taskId, "in_review", "pr_found");
              transitionToFinalState(
                { client, stateMap },
                taskId,
                "in_review",
                `Implementation complete — PR #${prInfo.number ?? "?"} opened on branch \`${storedBranch}\``,
              ).catch((err: unknown) => {
                logger.warn(
                  "transitionToFinalState failed (agent gate2 → in_review)",
                  { taskId, error: String(err) },
                );
              });

              try {
                removeWorktree(worktreePath);
              } catch {
                /* ignore */
              }

              log(
                `agent task ${taskId}: Gate 2 passed → in_review (PR #${prInfo.number ?? "?"})`,
              );
              return {
                outcome: "in_review",
                prBranch: storedBranch,
                prNumber: prInfo.number,
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
      // Review-fix loop (up to maxReviewCycles)
      // -------------------------------------------------------------------
      const { config: loopConfig } = getSchedulerDeps();
      for (let cycle = 0; cycle < loopConfig.maxReviewCycles; cycle++) {
        // Guard A: abort if task is in a terminal state
        const guardAReview = await step.run(
          `guard-a-review-${cycle}`,
          (): { aborted: boolean } => {
            const { db } = getSchedulerDeps();
            const freshTask = getTask(db, taskId);
            if (
              !freshTask ||
              ["done", "failed", "canceled"].includes(freshTask.lifecycleStage!)
            ) {
              log(
                `agent task ${taskId} is ${freshTask?.lifecycleStage ?? "deleted"}, aborting stale workflow`,
              );
              insertSystemEvent(db, {
                type: "self_heal",
                message: `Aborted stale agent workflow for ${taskId} (stage: ${freshTask?.lifecycleStage ?? "deleted"})`,
                metadata: {
                  taskId,
                  previousStatus: freshTask?.orcaStatus ?? "deleted",
                  lifecycleStage: freshTask?.lifecycleStage ?? "deleted",
                  currentPhase: freshTask?.currentPhase ?? null,
                  phase: "review",
                  cycle,
                },
              });
              return { aborted: true };
            }
            return { aborted: false };
          },
        );
        if (guardAReview.aborted) return { outcome: "aborted_stale" };

        // 6a: Spawn review session
        const reviewCtx = await step.run(
          `start-review-${cycle}`,
          (): {
            invocationId: number;
            worktreePath: string;
            startedAt: number;
          } | null =>
            runWithLogContext({ taskId }, () => {
              const { db, config, client } = getSchedulerDeps();
              const task = getTask(db, taskId);
              if (!task) throw new Error(`task ${taskId} not found`);

              const prRef = task.prNumber
                ? `#${task.prNumber}`
                : "on this branch";
              const agentPrompt = `${task.agentPrompt ?? ""}\n\nReview PR ${prRef}. The PR branch is checked out in your working directory.`;

              const baseRef = task.prBranchName ?? undefined;
              let wtResult;
              try {
                wtResult = createWorktree(task.repoPath, taskId, cycle, {
                  baseRef,
                });
              } catch (err) {
                log(
                  `agent task ${taskId}: review spawn blocked by worktree error: ${err}`,
                );

                const MAX_CONSECUTIVE_WORKTREE_ERRORS = 5;
                const transitions = getTaskStateTransitions(db, taskId);
                let consecutiveErrors = 0;
                for (let i = transitions.length - 1; i >= 0; i--) {
                  if (
                    transitions[i]!.reason === "spawn_blocked_worktree_error"
                  ) {
                    consecutiveErrors++;
                  } else {
                    break;
                  }
                }

                if (consecutiveErrors >= MAX_CONSECUTIVE_WORKTREE_ERRORS) {
                  log(
                    `agent task ${taskId}: ${consecutiveErrors} consecutive worktree errors — failing permanently`,
                  );
                  updateAndEmit(
                    db,
                    taskId,
                    "failed",
                    "worktree_error_limit_exceeded",
                    {
                      failureReason: `${consecutiveErrors} consecutive worktree creation failures`,
                      failedPhase: "review",
                    },
                  );
                  return null;
                }

                updateTaskStatus(db, taskId, "ready", {
                  reason: "spawn_blocked_worktree_error",
                });
                emitTaskUpdated(getTask(db, taskId)!);
                return null;
              }

              try {
                assertSessionCapacity(db);
              } catch (err) {
                const reason =
                  err instanceof Error ? err.message : "session cap reached";
                log(
                  `agent task ${taskId}: review spawn blocked (${reason}), resetting to ready`,
                );
                updateTaskStatus(db, taskId, "ready", {
                  reason: "spawn_blocked_capacity",
                });
                emitTaskUpdated(getTask(db, taskId)!);
                try {
                  removeWorktree(wtResult.worktreePath);
                } catch {
                  /* ignore */
                }
                return null;
              }

              const now = new Date().toISOString();
              const invocationId = insertInvocation(db, {
                linearIssueId: taskId,
                startedAt: now,
                status: "running",
                phase: "review",
                model: config.reviewModel,
                worktreePath: wtResult.worktreePath,
                branchName: wtResult.branchName,
                logPath: "logs/0.ndjson",
              });
              updateInvocation(db, invocationId, {
                logPath: `logs/${invocationId}.ndjson`,
              });

              let reviewAppendPrompt = config.reviewSystemPrompt || undefined;
              if (reviewAppendPrompt) {
                const defaultBranchForReview = getDefaultBranch(task.repoPath);
                reviewAppendPrompt = reviewAppendPrompt.replace(
                  /\{\{DEFAULT_BRANCH_REF\}\}/g,
                  `origin/${defaultBranchForReview}`,
                );
              }

              const startedAt = Date.now();
              const handle = spawnSession({
                agentPrompt,
                worktreePath: wtResult.worktreePath,
                maxTurns: config.reviewMaxTurns,
                invocationId,
                projectRoot: process.cwd(),
                claudePath: config.claudePath,
                appendSystemPrompt: reviewAppendPrompt,
                disallowedTools: buildDisallowedTools(config),
                repoPath: task.repoPath,
                model: config.reviewModel,
                mcpServers: buildOrcaMcpServers(config),
                hookUrl: getHookUrl(invocationId),
              });

              bridgeSessionCompletion(
                invocationId,
                taskId,
                "review",
                handle,
                wtResult.branchName,
                wtResult.worktreePath,
              );

              emitInvocationStarted({ taskId, invocationId });
              updateAndEmit(db, taskId, "running", "review_dispatched");
              client
                .createComment(
                  taskId,
                  `Dispatched for code review (invocation #${invocationId}, cycle ${cycle + 1}/${config.maxReviewCycles})`,
                )
                .catch((err: unknown) => {
                  logger.warn(
                    "Linear createComment failed (agent review dispatch)",
                    { taskId, error: String(err) },
                  );
                });

              log(
                `agent task ${taskId}: review session spawned as invocation ${invocationId} (cycle ${cycle + 1})`,
              );
              return {
                invocationId,
                worktreePath: wtResult.worktreePath,
                startedAt,
              };
            }),
        );

        if (!reviewCtx) return { outcome: "capacity_blocked" as const };

        // 6b: Wait for review session to complete
        const reviewEvent = await step.waitForEvent(`await-review-${cycle}`, {
          event: "session/completed",
          if: `async.data.invocationId == ${reviewCtx.invocationId}`,
          timeout: SESSION_TIMEOUT,
        });

        // 6c: Process review result
        type ReviewOutcome =
          | "approved"
          | "changes_requested"
          | "no_marker"
          | "timed_out"
          | "failed";

        const reviewResult = await step.run(
          `process-review-${cycle}`,
          async (): Promise<{ outcome: ReviewOutcome }> =>
            runWithLogContext(
              { taskId, invocationId: String(reviewCtx.invocationId) },
              async () => {
                const { db } = getSchedulerDeps();
                const { invocationId, worktreePath } = reviewCtx;

                if (!reviewEvent) {
                  log(
                    `agent task ${taskId}: review session timed out (cycle ${cycle + 1})`,
                  );
                  const timedOutHandle = activeHandles.get(invocationId);
                  if (timedOutHandle) {
                    killSession(timedOutHandle).catch((err: unknown) => {
                      logger.warn("killSession failed (agent review timeout)", {
                        taskId,
                        invocationId,
                        error: String(err),
                      });
                    });
                  }
                  finalizeInvocation(db, invocationId, "timed_out", {
                    outputSummary: "review session timed out after 45 minutes",
                  });
                  updateAndEmit(
                    db,
                    taskId,
                    "in_review",
                    "review_session_timed_out",
                  );
                  try {
                    removeWorktree(worktreePath);
                  } catch {
                    /* ignore */
                  }
                  return { outcome: "timed_out" };
                }

                const isSuccess =
                  reviewEvent.data.exitCode === 0 &&
                  !reviewEvent.data.isMaxTurns;
                const revStatus = isSuccess ? "completed" : "failed";
                emitInvocationCompleted({
                  taskId,
                  invocationId,
                  status: revStatus,
                  costUsd: reviewEvent.data.costUsd ?? 0,
                  inputTokens: reviewEvent.data.inputTokens ?? 0,
                  outputTokens: reviewEvent.data.outputTokens ?? 0,
                });
                finalizeInvocation(db, invocationId, revStatus, {
                  costUsd: reviewEvent.data.costUsd ?? null,
                  inputTokens: reviewEvent.data.inputTokens ?? null,
                  outputTokens: reviewEvent.data.outputTokens ?? null,
                });
                if (!isSuccess) {
                  updateAndEmit(
                    db,
                    taskId,
                    "in_review",
                    "review_session_failed",
                  );
                  try {
                    removeWorktree(worktreePath);
                  } catch {
                    /* ignore */
                  }
                  return { outcome: "failed" };
                }

                // Parse REVIEW_RESULT marker
                const invRecord = getInvocation(db, invocationId);
                const summary = invRecord?.outputSummary ?? "";
                let approved = summary.includes("REVIEW_RESULT:APPROVED");
                let changesRequested = summary.includes(
                  "REVIEW_RESULT:CHANGES_REQUESTED",
                );

                if (!approved && !changesRequested) {
                  const markerFromLog =
                    await extractMarkerFromLog(invocationId);
                  if (markerFromLog === "APPROVED") approved = true;
                  else if (markerFromLog === "CHANGES_REQUESTED")
                    changesRequested = true;
                }

                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }

                if (approved) return { outcome: "approved" };
                if (changesRequested) return { outcome: "changes_requested" };
                return { outcome: "no_marker" };
              },
            ),
        );

        // 6d: Handle review outcome

        if (reviewResult.outcome === "approved") {
          const ciInfo = await step.run(
            `transition-awaiting-ci-${cycle}`,
            () => {
              const { db, client, stateMap } = getSchedulerDeps();
              const ciStartedAt = new Date().toISOString();
              updateTaskCiInfo(db, taskId, { ciStartedAt });
              resetStaleSessionRetryCount(db, taskId);
              updateAndEmit(db, taskId, "awaiting_ci", "review_approved");
              const task = getTask(db, taskId);
              transitionToFinalState(
                { client, stateMap },
                taskId,
                "awaiting_ci",
                `Review approved — awaiting CI checks on PR #${task?.prNumber ?? "?"} before merging`,
              ).catch((err: unknown) => {
                logger.warn(
                  "transitionToFinalState failed (agent review approved → awaiting_ci)",
                  { taskId, error: String(err) },
                );
              });
              log(
                `agent task ${taskId}: review approved → awaiting_ci (cycle ${cycle + 1})`,
              );
              return {
                prNumber: (task?.prNumber ?? 0) as number,
                prBranchName: (task?.prBranchName ?? "") as string,
                ciStartedAt: ciStartedAt as string,
              };
            },
          );

          // Emit event to trigger CI gate workflow
          {
            const { db: awaitingDb, config: awaitingConfig } =
              getSchedulerDeps();
            await inngest.send({
              name: "task/awaiting-ci",
              data: {
                linearIssueId: taskId,
                prNumber: ciInfo.prNumber,
                prBranchName: ciInfo.prBranchName,
                repoPath:
                  getTask(awaitingDb, taskId)?.repoPath ??
                  awaitingConfig.defaultCwd ??
                  "",
                ciStartedAt: ciInfo.ciStartedAt,
              },
            });
          }

          return { outcome: "awaiting_ci" };
        }

        if (
          reviewResult.outcome === "timed_out" ||
          reviewResult.outcome === "failed"
        ) {
          return { outcome: reviewResult.outcome };
        }

        // "no_marker" or "changes_requested" — check if we've exhausted cycles
        const isLastCycle = cycle >= loopConfig.maxReviewCycles - 1;

        if (reviewResult.outcome === "no_marker" || isLastCycle) {
          await step.run(`cycles-exhausted-${cycle}`, () => {
            const { db, client, config } = getSchedulerDeps();
            updateAndEmit(db, taskId, "in_review", "review_cycles_exhausted");
            const reason =
              reviewResult.outcome === "no_marker"
                ? "no REVIEW_RESULT marker found"
                : `review cycles exhausted (${config.maxReviewCycles}/${config.maxReviewCycles})`;
            client
              .createComment(
                taskId,
                `Review loop ended: ${reason} — manual intervention required`,
              )
              .catch((err: unknown) => {
                logger.warn(
                  "Linear createComment failed (agent review cycles exhausted)",
                  { taskId, error: String(err) },
                );
              });
            log(`agent task ${taskId}: ${reason} — leaving at in_review`);
          });
          return { outcome: "in_review_needs_human" };
        }

        // Changes requested — spawn fix session before next review cycle

        // Guard A: abort if task is in a terminal state before fix spawn
        const guardAFix = await step.run(
          `guard-a-fix-${cycle}`,
          (): { aborted: boolean } => {
            const { db } = getSchedulerDeps();
            const freshTask = getTask(db, taskId);
            if (
              !freshTask ||
              ["done", "failed", "canceled"].includes(freshTask.lifecycleStage!)
            ) {
              log(
                `agent task ${taskId} is ${freshTask?.lifecycleStage ?? "deleted"}, aborting stale workflow`,
              );
              insertSystemEvent(db, {
                type: "self_heal",
                message: `Aborted stale agent workflow for ${taskId} (stage: ${freshTask?.lifecycleStage ?? "deleted"})`,
                metadata: {
                  taskId,
                  previousStatus: freshTask?.orcaStatus ?? "deleted",
                  lifecycleStage: freshTask?.lifecycleStage ?? "deleted",
                  currentPhase: freshTask?.currentPhase ?? null,
                  phase: "fix",
                  cycle,
                },
              });
              return { aborted: true };
            }
            return { aborted: false };
          },
        );
        if (guardAFix.aborted) return { outcome: "aborted_stale" };

        // 6e: Spawn fix session
        const fixCtx = await step.run(
          `start-fix-${cycle}`,
          (): {
            invocationId: number;
            worktreePath: string;
            startedAt: number;
          } | null =>
            runWithLogContext({ taskId }, () => {
              const { db, config, client, stateMap } = getSchedulerDeps();
              const task = getTask(db, taskId);
              if (!task) throw new Error(`task ${taskId} not found`);

              incrementReviewCycleCount(db, taskId);
              updateAndEmit(
                db,
                taskId,
                "changes_requested",
                "review_changes_requested",
              );
              transitionToFinalState(
                { client, stateMap },
                taskId,
                "changes_requested",
              ).catch((err: unknown) => {
                logger.warn(
                  "transitionToFinalState failed (agent review → changes_requested)",
                  { taskId, error: String(err) },
                );
              });

              let resumeSessionId: string | undefined;
              {
                const prevInv = getLastCompletedImplementInvocation(db, taskId);
                if (prevInv?.sessionId) resumeSessionId = prevInv.sessionId;
              }

              const baseRef = task.prBranchName ?? undefined;
              let wtResult;
              try {
                wtResult = createWorktree(task.repoPath, taskId, cycle + 1000, {
                  baseRef,
                });
              } catch (err) {
                log(
                  `agent task ${taskId}: fix spawn blocked by worktree error: ${err}`,
                );

                const MAX_CONSECUTIVE_WORKTREE_ERRORS = 5;
                const transitions = getTaskStateTransitions(db, taskId);
                let consecutiveErrors = 0;
                for (let i = transitions.length - 1; i >= 0; i--) {
                  if (
                    transitions[i]!.reason === "spawn_blocked_worktree_error"
                  ) {
                    consecutiveErrors++;
                  } else {
                    break;
                  }
                }

                if (consecutiveErrors >= MAX_CONSECUTIVE_WORKTREE_ERRORS) {
                  log(
                    `agent task ${taskId}: ${consecutiveErrors} consecutive worktree errors — failing permanently`,
                  );
                  updateAndEmit(
                    db,
                    taskId,
                    "failed",
                    "worktree_error_limit_exceeded",
                    {
                      failureReason: `${consecutiveErrors} consecutive worktree creation failures`,
                      failedPhase: "fix",
                    },
                  );
                  return null;
                }

                updateTaskStatus(db, taskId, "ready", {
                  reason: "spawn_blocked_worktree_error",
                });
                emitTaskUpdated(getTask(db, taskId)!);
                return null;
              }

              const agentPrompt = task.agentPrompt ?? "";

              try {
                assertSessionCapacity(db);
              } catch (err) {
                const reason =
                  err instanceof Error ? err.message : "session cap reached";
                log(
                  `agent task ${taskId}: fix spawn blocked (${reason}), resetting to ready`,
                );
                updateTaskStatus(db, taskId, "ready", {
                  reason: "spawn_blocked_capacity",
                });
                emitTaskUpdated(getTask(db, taskId)!);
                try {
                  removeWorktree(wtResult.worktreePath);
                } catch {
                  /* ignore */
                }
                return null;
              }

              const now = new Date().toISOString();
              const invocationId = insertInvocation(db, {
                linearIssueId: taskId,
                startedAt: now,
                status: "running",
                phase: "implement",
                model: config.model,
                worktreePath: wtResult.worktreePath,
                branchName: wtResult.branchName,
                logPath: "logs/0.ndjson",
              });
              updateInvocation(db, invocationId, {
                logPath: `logs/${invocationId}.ndjson`,
              });

              let fixAppendPrompt = config.fixSystemPrompt || undefined;
              if (fixAppendPrompt) {
                const defaultBranchForFix = getDefaultBranch(task.repoPath);
                fixAppendPrompt = fixAppendPrompt.replace(
                  /\{\{DEFAULT_BRANCH_REF\}\}/g,
                  `origin/${defaultBranchForFix}`,
                );
              }

              const startedAt = Date.now();
              const handle = spawnSession({
                agentPrompt,
                worktreePath: wtResult.worktreePath,
                maxTurns: config.defaultMaxTurns,
                invocationId,
                projectRoot: process.cwd(),
                claudePath: config.claudePath,
                appendSystemPrompt: fixAppendPrompt,
                disallowedTools: buildDisallowedTools(config),
                resumeSessionId,
                repoPath: task.repoPath,
                model: config.model,
                mcpServers: buildOrcaMcpServers(config),
                hookUrl: getHookUrl(invocationId),
              });

              bridgeSessionCompletion(
                invocationId,
                taskId,
                "implement",
                handle,
                wtResult.branchName,
                wtResult.worktreePath,
              );

              emitInvocationStarted({ taskId, invocationId });
              updateAndEmit(db, taskId, "running", "fix_dispatched");

              const reviewCycle = task.reviewCycleCount + 1;
              client
                .createComment(
                  taskId,
                  resumeSessionId
                    ? `Dispatched to fix review feedback with session resume (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`
                    : `Dispatched to fix review feedback (invocation #${invocationId}, cycle ${reviewCycle}/${config.maxReviewCycles})`,
                )
                .catch((err: unknown) => {
                  logger.warn(
                    "Linear createComment failed (agent fix dispatch)",
                    { taskId, error: String(err) },
                  );
                });

              log(
                `agent task ${taskId}: fix session spawned as invocation ${invocationId} (review cycle ${reviewCycle})`,
              );
              return {
                invocationId,
                worktreePath: wtResult.worktreePath,
                startedAt,
              };
            }),
        );

        if (!fixCtx) return { outcome: "capacity_blocked" as const };

        // 6f: Wait for fix session
        const fixEvent = await step.waitForEvent(`await-fix-${cycle}`, {
          event: "session/completed",
          if: `async.data.invocationId == ${fixCtx.invocationId}`,
          timeout: SESSION_TIMEOUT,
        });

        // 6g: Process fix result
        const fixResult = await step.run(
          `process-fix-${cycle}`,
          (): { ok: boolean; timedOut: boolean; resumeNotFound: boolean } =>
            runWithLogContext(
              { taskId, invocationId: String(fixCtx.invocationId) },
              () => {
                const { db, client, stateMap } = getSchedulerDeps();
                const { invocationId, worktreePath } = fixCtx;

                if (!fixEvent) {
                  log(
                    `agent task ${taskId}: fix session timed out (cycle ${cycle + 1})`,
                  );
                  const timedOutHandle = activeHandles.get(invocationId);
                  if (timedOutHandle) {
                    killSession(timedOutHandle).catch((err: unknown) => {
                      logger.warn("killSession failed (agent fix timeout)", {
                        taskId,
                        invocationId,
                        error: String(err),
                      });
                    });
                  }
                  finalizeInvocation(db, invocationId, "timed_out", {
                    outputSummary: "fix session timed out after 45 minutes",
                  });
                  updateAndEmit(
                    db,
                    taskId,
                    "in_review",
                    "fix_session_timed_out",
                  );
                  try {
                    removeWorktree(worktreePath);
                  } catch {
                    /* ignore */
                  }
                  return { ok: false, timedOut: true, resumeNotFound: false };
                }

                const isSuccess =
                  fixEvent.data.exitCode === 0 && !fixEvent.data.isMaxTurns;
                const fixStatus = isSuccess ? "completed" : "failed";
                emitInvocationCompleted({
                  taskId,
                  invocationId,
                  status: fixStatus,
                  costUsd: fixEvent.data.costUsd ?? 0,
                  inputTokens: fixEvent.data.inputTokens ?? 0,
                  outputTokens: fixEvent.data.outputTokens ?? 0,
                });
                finalizeInvocation(db, invocationId, fixStatus, {
                  costUsd: fixEvent.data.costUsd ?? null,
                  inputTokens: fixEvent.data.inputTokens ?? null,
                  outputTokens: fixEvent.data.outputTokens ?? null,
                });
                try {
                  removeWorktree(worktreePath);
                } catch {
                  /* ignore */
                }

                if (!isSuccess) {
                  if (fixEvent.data.isResumeNotFound) {
                    log(
                      `agent task ${taskId}: fix resume session not found — clearing stale session ID`,
                    );
                    clearSessionIds(db, taskId);
                    client
                      .createComment(
                        taskId,
                        `Fix resume session not found (stale session ID) — restarting as fresh session`,
                      )
                      .catch((err: unknown) => {
                        logger.warn(
                          "Linear createComment failed (agent fix resume not found)",
                          { taskId, error: String(err) },
                        );
                      });
                    updateAndEmit(
                      db,
                      taskId,
                      "in_review",
                      "fix_resume_not_found",
                    );
                    return {
                      ok: false,
                      timedOut: false,
                      resumeNotFound: true,
                    };
                  }
                  updateAndEmit(db, taskId, "in_review", "fix_session_failed");
                  return { ok: false, timedOut: false, resumeNotFound: false };
                }

                // Fix succeeded — transition back to in_review for next review cycle
                resetStaleSessionRetryCount(db, taskId);
                updateAndEmit(db, taskId, "in_review", "fix_succeeded");
                transitionToFinalState(
                  { client, stateMap },
                  taskId,
                  "in_review",
                ).catch((err: unknown) => {
                  logger.warn(
                    "transitionToFinalState failed (agent fix → in_review)",
                    { taskId, error: String(err) },
                  );
                });
                log(
                  `agent task ${taskId}: fix complete → in_review (cycle ${cycle + 1})`,
                );
                return { ok: true, timedOut: false, resumeNotFound: false };
              },
            ),
        );

        if (!fixResult.ok) {
          if (fixResult.resumeNotFound) {
            continue;
          }
          return {
            outcome: fixResult.timedOut ? "fix_timed_out" : "fix_failed",
          };
        }

        // Continue to next review cycle
      }

      // Should not reach here — loop always returns early
      return { outcome: "unknown" };
    }); // end runWithLogContext({ taskId })
  },
);
