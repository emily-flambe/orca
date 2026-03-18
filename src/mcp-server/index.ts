#!/usr/bin/env node
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

const sqlite = new Database(dbPath, { readonly: true });
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
      orcaStatus: task.orcaStatus,
      priority: task.priority,
      retryCount: task.retryCount,
      reviewCycleCount: task.reviewCycleCount,
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
      orcaStatus: parent.orcaStatus,
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
      orcaStatus: t.orcaStatus,
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
