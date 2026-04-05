/**
 * Orca MCP server — exposes Orca's internal DB state to agent sessions via
 * stdio JSON-RPC (Model Context Protocol).
 *
 * Start via:
 *   node dist/mcp-server.js
 *
 * Required env:
 *   ORCA_DB_PATH  — absolute path to the Orca SQLite database file
 *
 * The server is read-only; no write tools are exposed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  getTask,
  getInvocation,
  getInvocationsByTask,
  getChildTasks,
  getAgentMemories,
  insertAgentMemory,
  updateAgentMemory,
  deleteAgentMemory,
  getAllTasks,
  getRunningInvocations,
  getTaskStateTransitions,
  getInvocationStats,
  getDailyStats,
  getSuccessRate12h,
  sumTokensInWindow,
  budgetWindowStart,
  countActiveSessions,
  countActiveAgentSessions,
} from "../db/queries.js";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

const dbPath = process.env.ORCA_DB_PATH;
if (!dbPath) {
  console.error("[orca/mcp] ORCA_DB_PATH env var is required");
  process.exit(1);
}

const agentId = process.env.ORCA_AGENT_ID ?? null;
const isAgentSession = agentId !== null;

const sqlite = new Database(dbPath, { readonly: !isAgentSession });
const db = drizzle(sqlite, { schema });

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "orca",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: get_task
// ---------------------------------------------------------------------------

server.registerTool(
  "get_task",
  {
    description:
      "Get task metadata by ID: title (agent prompt), state, retry count, PR info, and invocation history summary.",
    inputSchema: {
      task_id: z.string().describe("The Linear issue ID of the task"),
    },
  },
  ({ task_id }) => {
    const task = getTask(db, task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task ${task_id} not found.` }],
        isError: true,
      };
    }

    const invocations = getInvocationsByTask(db, task_id);
    const invocationSummary = invocations.map((inv) => ({
      id: inv.id,
      phase: inv.phase,
      status: inv.status,
      model: inv.model,
      costUsd: inv.costUsd,
      numTurns: inv.numTurns,
      startedAt: inv.startedAt,
      endedAt: inv.endedAt,
      outputSummary: inv.outputSummary,
    }));

    const result = {
      taskId: task.linearIssueId,
      agentPrompt: task.agentPrompt,
      lifecycleStage: task.lifecycleStage,
      currentPhase: task.currentPhase,
      priority: task.priority,
      retryCount: task.retryCount,
      // reviewCycleCount removed in EMI-504
      prBranchName: task.prBranchName,
      prNumber: task.prNumber,
      repoPath: task.repoPath,
      projectName: task.projectName,
      parentIdentifier: task.parentIdentifier,
      isParent: task.isParent === 1,
      fixReason: task.fixReason,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      doneAt: task.doneAt,
      invocations: invocationSummary,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_invocation
// ---------------------------------------------------------------------------

server.registerTool(
  "get_invocation",
  {
    description:
      "Get full invocation details by numeric ID: phase, model, cost, token counts, output summary, and timestamps.",
    inputSchema: {
      invocation_id: z
        .number()
        .int()
        .describe("Numeric invocation ID (integer)"),
    },
  },
  ({ invocation_id }) => {
    const inv = getInvocation(db, invocation_id);
    if (!inv) {
      return {
        content: [
          { type: "text", text: `Invocation ${invocation_id} not found.` },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(inv, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_task_invocations
// ---------------------------------------------------------------------------

server.registerTool(
  "list_task_invocations",
  {
    description:
      "List all invocations for a task, ordered by start time. Returns phase, status, cost, and output summary for each.",
    inputSchema: {
      task_id: z.string().describe("The Linear issue ID of the task"),
    },
  },
  ({ task_id }) => {
    const task = getTask(db, task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task ${task_id} not found.` }],
        isError: true,
      };
    }

    const invocations = getInvocationsByTask(db, task_id);
    const result = invocations.map((inv) => ({
      id: inv.id,
      phase: inv.phase,
      status: inv.status,
      model: inv.model,
      costUsd: inv.costUsd,
      inputTokens: inv.inputTokens,
      outputTokens: inv.outputTokens,
      numTurns: inv.numTurns,
      startedAt: inv.startedAt,
      endedAt: inv.endedAt,
      outputSummary: inv.outputSummary,
      branchName: inv.branchName,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_parent_issue
// ---------------------------------------------------------------------------

server.registerTool(
  "get_parent_issue",
  {
    description:
      "Get the parent Linear issue for a task. Returns the parent task's agent prompt and status if it exists in the DB.",
    inputSchema: {
      task_id: z
        .string()
        .describe(
          "The Linear issue ID of the child task to look up the parent for",
        ),
    },
  },
  ({ task_id }) => {
    const task = getTask(db, task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task ${task_id} not found.` }],
        isError: true,
      };
    }

    if (!task.parentIdentifier) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { message: "Task has no parent issue.", taskId: task_id },
              null,
              2,
            ),
          },
        ],
      };
    }

    const parent = getTask(db, task.parentIdentifier);
    if (!parent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message: "Parent identifier found but not in DB cache.",
                parentIdentifier: task.parentIdentifier,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const result = {
      taskId: parent.linearIssueId,
      agentPrompt: parent.agentPrompt,
      lifecycleStage: parent.lifecycleStage,
      currentPhase: parent.currentPhase,
      projectName: parent.projectName,
      isParent: parent.isParent === 1,
      createdAt: parent.createdAt,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_sibling_tasks
// ---------------------------------------------------------------------------

server.registerTool(
  "get_sibling_tasks",
  {
    description:
      "List sibling tasks — other tasks that share the same parent identifier or project name. Useful for understanding what else is being worked on in the same batch.",
    inputSchema: {
      task_id: z.string().describe("The Linear issue ID of the task"),
    },
  },
  ({ task_id }) => {
    const task = getTask(db, task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task ${task_id} not found.` }],
        isError: true,
      };
    }

    let siblings: (typeof schema.tasks.$inferSelect)[] = [];

    if (task.parentIdentifier) {
      // Siblings share the same parent
      siblings = getChildTasks(db, task.parentIdentifier).filter(
        (t) => t.linearIssueId !== task_id,
      );
    } else if (task.projectName) {
      // Fall back to project-level siblings
      siblings = db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.projectName, task.projectName))
        .all()
        .filter((t) => t.linearIssueId !== task_id);
    }

    const result = siblings.map((t) => ({
      taskId: t.linearIssueId,
      agentPrompt: t.agentPrompt,
      lifecycleStage: t.lifecycleStage,
      currentPhase: t.currentPhase,
      retryCount: t.retryCount,
      prBranchName: t.prBranchName,
      projectName: t.projectName,
      parentIdentifier: t.parentIdentifier,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: result.length, siblings: result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_tasks
// ---------------------------------------------------------------------------

server.registerTool(
  "list_tasks",
  {
    description:
      "List all tasks in the Orca DB, optionally filtered by status. Returns task ID, prompt, status, PR info, retry count, and timestamps.",
    inputSchema: {
      status: z
        .enum([
          "backlog",
          "ready",
          "running",
          "done",
          "failed",
          "canceled",
          "in_review",
          "changes_requested",
          "deploying",
          "awaiting_ci",
        ])
        .optional()
        .describe("Filter by orca status (optional)"),
    },
  },
  ({ status }) => {
    const allTasks = getAllTasks(db);
    const filtered = status
      ? allTasks.filter((t) => t.lifecycleStage === status)
      : allTasks;

    const result = filtered.map((t) => ({
      taskId: t.linearIssueId,
      agentPrompt:
        t.agentPrompt && t.agentPrompt.length > 120
          ? t.agentPrompt.slice(0, 120)
          : t.agentPrompt,
      lifecycleStage: t.lifecycleStage,
      currentPhase: t.currentPhase,
      priority: t.priority,
      retryCount: t.retryCount,
      prBranchName: t.prBranchName,
      prNumber: t.prNumber,
      projectName: t.projectName,
      repoPath: t.repoPath,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      doneAt: t.doneAt,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: result.length, tasks: result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_orca_status
// ---------------------------------------------------------------------------

server.registerTool(
  "get_orca_status",
  {
    description:
      "Get the current Orca scheduler status: active session counts, token usage in the rolling budget window, and concurrency caps from environment variables.",
    inputSchema: {},
  },
  () => {
    const activeSessions = countActiveSessions(db);
    const activeAgentSessions = countActiveAgentSessions(db);
    const budgetWindowHours =
      parseInt(process.env.ORCA_BUDGET_WINDOW_HOURS ?? "4", 10) || 4;
    const windowStart = budgetWindowStart(budgetWindowHours);
    const tokensInWindow = sumTokensInWindow(db, windowStart);
    const budgetMaxTokens = parseInt(
      process.env.ORCA_BUDGET_MAX_TOKENS ?? "0",
      10,
    );
    const concurrencyCap = parseInt(
      process.env.ORCA_CONCURRENCY_CAP ?? "1",
      10,
    );
    const agentConcurrencyCap = parseInt(
      process.env.ORCA_AGENT_CONCURRENCY_CAP ?? "12",
      10,
    );

    const result = {
      activeSessions,
      activeAgentSessions,
      budgetWindowHours,
      tokensInWindow,
      budgetMaxTokens,
      concurrencyCap,
      agentConcurrencyCap,
      model: process.env.ORCA_MODEL ?? "sonnet",
      reviewModel: process.env.ORCA_REVIEW_MODEL ?? "haiku",
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_metrics
// ---------------------------------------------------------------------------

server.registerTool(
  "get_metrics",
  {
    description:
      "Get Orca performance metrics: invocation stats (total cost, tokens, counts by phase/status), daily stats for the past 14 days, and 12h success rate.",
    inputSchema: {},
  },
  () => {
    const stats = getInvocationStats(db);
    const dailyStats = getDailyStats(db, 14);
    const successRate12h = getSuccessRate12h(db);

    const result = {
      invocationStats: stats,
      dailyStats,
      successRate12h,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_running_invocations
// ---------------------------------------------------------------------------

server.registerTool(
  "list_running_invocations",
  {
    description:
      "List all currently running invocations (active Claude sessions). Returns task ID, phase, model, start time, and current cost/token estimates.",
    inputSchema: {},
  },
  () => {
    const running = getRunningInvocations(db);

    const result = running.map((inv) => ({
      id: inv.id,
      linearIssueId: inv.linearIssueId,
      phase: inv.phase,
      model: inv.model,
      costUsd: inv.costUsd,
      inputTokens: inv.inputTokens,
      outputTokens: inv.outputTokens,
      numTurns: inv.numTurns,
      startedAt: inv.startedAt,
      branchName: inv.branchName,
      worktreePath: inv.worktreePath,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: result.length, invocations: result },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_task_transitions
// ---------------------------------------------------------------------------

server.registerTool(
  "get_task_transitions",
  {
    description:
      "Get the state transition history for a task: every status change with timestamps, reasons, and associated invocation IDs.",
    inputSchema: {
      task_id: z.string().describe("The Linear issue ID of the task"),
    },
  },
  ({ task_id }) => {
    const task = getTask(db, task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task ${task_id} not found.` }],
        isError: true,
      };
    }

    const transitions = getTaskStateTransitions(db, task_id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { taskId: task_id, count: transitions.length, transitions },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Agent memory tools (only available when ORCA_AGENT_ID is set)
// ---------------------------------------------------------------------------

if (isAgentSession && agentId) {
  server.registerTool(
    "get_agent_memories",
    {
      description:
        "Retrieve your accumulated memories from past runs. Returns memories grouped by type (episodic, semantic, procedural).",
      inputSchema: {
        type: z
          .enum(["episodic", "semantic", "procedural"])
          .optional()
          .describe("Filter by memory type (optional)"),
      },
    },
    ({ type }) => {
      const memories = getAgentMemories(db, agentId);
      const filtered = type
        ? memories.filter((m) => m.type === type)
        : memories;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
    },
  );

  server.registerTool(
    "save_agent_memory",
    {
      description:
        "Save a new memory for future runs. Use 'episodic' for events/outcomes, 'semantic' for knowledge/facts, 'procedural' for how-to/workflows.",
      inputSchema: {
        memory_type: z
          .enum(["episodic", "semantic", "procedural"])
          .describe("Type of memory to save"),
        content: z
          .string()
          .describe("The memory content to persist across runs"),
      },
    },
    ({ memory_type, content }) => {
      const id = insertAgentMemory(db, {
        agentId,
        type: memory_type,
        content,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ saved: true, memoryId: id }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "update_agent_memory",
    {
      description: "Update the content of an existing memory by its ID.",
      inputSchema: {
        memory_id: z
          .number()
          .int()
          .describe("The numeric ID of the memory to update"),
        content: z.string().describe("The updated memory content"),
      },
    },
    ({ memory_id, content }) => {
      updateAgentMemory(db, memory_id, content);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { updated: true, memoryId: memory_id },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "forget_agent_memory",
    {
      description:
        "Delete a memory by its ID. Use when a memory is outdated or no longer relevant.",
      inputSchema: {
        memory_id: z
          .number()
          .int()
          .describe("The numeric ID of the memory to delete"),
      },
    },
    ({ memory_id }) => {
      deleteAgentMemory(db, memory_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { deleted: true, memoryId: memory_id },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Exit cleanly when stdin closes (parent Claude process exits)
process.stdin.on("close", () => {
  server.close().catch(() => {});
  process.exit(0);
});

process.stdin.on("end", () => {
  server.close().catch(() => {});
  process.exit(0);
});
