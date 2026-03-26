// seed-agent-mcp.js - Seeds Orca architectural context into Agent-MCP knowledge graph
// Usage: node scripts/seed-agent-mcp.js [--url http://localhost:8080/mcp] [--token <token>]
// ESM, uses built-in http module only

import http from "http";

const MCP_URL = process.env.AGENT_MCP_URL || "http://localhost:8080/mcp";
const AUTH_TOKEN =
  process.env.AGENT_MCP_TOKEN || "eadbe4889e0e755efe5b4e71a99ceac0";
const { hostname, port, pathname } = new URL(MCP_URL);

const contextUpdates = [
  {
    context_key: "orca/architecture",
    description: "High-level architecture of the Orca AI agent scheduler",
    context_value: {
      summary:
        "Orca is an AI agent scheduler that pulls tasks from Linear, dispatches them as Claude Code CLI sessions in isolated git worktrees, manages a multi-phase lifecycle, and serves a real-time web dashboard.",
      backend:
        "Node.js 22+, TypeScript (ESM), Hono HTTP server, SQLite via better-sqlite3 + drizzle-orm, Inngest for durable workflow orchestration",
      frontend:
        "React 19 + Vite dashboard at web/. Routes: / (dashboard), /metrics, /tasks, /cron, /logs, /settings",
      runner:
        "Spawns Claude Code CLI sessions as child processes in isolated git worktrees. Each session gets its own --mcp-config with Orca-state MCP server plus optional GitHub MCP.",
      deployment:
        "Windows primary. Blue-green zero-downtime via scripts/deploy.sh. Ports alternate 4000/4001 tracked in deploy-state.json.",
      database:
        "SQLite at ORCA_DB_PATH (default: ./orca.db). Schema: tasks, invocations, budget_events. Synchronous better-sqlite3 access only.",
      orchestration:
        "Inngest durable workflows (NOT polling). Events: task/ready, task/awaiting-ci, task/deploying, session/completed.",
      key_entry_points: {
        cli: "src/cli/ - Commander CLI: start, add, status",
        server: "src/api/ - Hono routes for REST + SSE",
        workflows: "src/inngest/ - all durable workflows",
        runner: "src/runner/ - Claude process spawning",
        db: "src/db/ - schema, queries, migrations",
      },
    },
  },
  {
    context_key: "orca/modules",
    description: "Module map for Orca source directories",
    context_value: {
      "src/cli/":
        "Entry point. Commander CLI commands: start (launch server), add (enqueue task), status",
      "src/scheduler/":
        "Types and alert utilities only. Legacy tick-loop scheduler removed, orchestration now in src/inngest/",
      "src/inngest/":
        "Durable workflows: task-lifecycle (implement-review-fix loop), ci-gate-merge (CI polling + PR merge), deploy-monitor (GitHub Actions polling), cleanup cron (every 5min). Events in events.ts, registration in functions.ts, deps injection in deps.ts",
      "src/runner/":
        "Spawns/kills Claude Code CLI via child_process.spawn. NDJSON stream parsing, rate limit detection, --resume support. Windows: resolves .cmd shim to direct node cli.js invocation.",
      "src/session-handles.ts":
        "In-memory registry of active Claude process handles, keyed by invocationId",
      "src/db/":
        "Schema (tasks, invocations, budget_events), named query functions in queries.ts, sentinel-based inline migrations in index.ts",
      "src/api/":
        "Hono HTTP routes: tasks CRUD, invocation logs, SSE for dashboard, metrics, deploy drain/unpause",
      "src/linear/":
        "GraphQL client (client.ts), HMAC webhook (webhook.ts), full sync (sync.ts), state write-back, conflict resolution, polling fallback (poller.ts)",
      "src/github/":
        "gh CLI wrapper: PR find/merge/close, CI status checks, workflow run status",
      "src/worktree/":
        "Git worktree create/remove. Windows-aware EPERM retry. Supports baseRef param for review/fix phases.",
      "src/cleanup/":
        "Stale orca/* branch deletion and orphaned worktree/PR cleanup",
      "src/config/":
        "Env var loading + built-in system prompts for implement/review/fix phases",
      "src/tunnel/": "Cloudflared tunnel management (spawn, health check)",
      "src/mcp-server/":
        "Orca-state MCP server (stdio). Exposes task metadata, invocation history, parent issue context to spawned agents",
      "src/cron/":
        "Orca dashboard cron jobs - user-defined shell commands and Claude prompts on cron schedules",
      "web/":
        "React 19 + Vite + Tailwind dashboard. Components in web/src/components/",
    },
  },
  {
    context_key: "orca/conventions",
    description:
      "Coding conventions, patterns, and invariants in the Orca codebase",
    context_value: {
      imports: "ESM with .js extensions on all relative imports",
      naming:
        "camelCase functions, PascalCase types/interfaces, UPPER_SNAKE_CASE constants",
      logging:
        "console.log/warn with module tags like [orca/scheduler], [orca/runner], [orca/sync]",
      db_access:
        "Synchronous only (better-sqlite3). All queries are named functions in src/db/queries.ts. Never use async DB calls.",
      migrations:
        "Sentinel-based: check column via PRAGMA table_info, then ALTER TABLE if missing. No migration framework.",
      error_handling:
        "Try/catch with context. Fire-and-forget for non-critical async ops (Linear comments). Never throw in Inngest claim steps (retries: 0 - a thrown error orphans the task permanently).",
      file_org:
        "One module per directory with index.ts. Types co-located with module.",
      inngest_invariants: [
        "Never throw in claim steps - always return { claimed: false, reason } instead",
        "Every DB orca_status change must emit the matching Inngest event",
        "task/ready emit required when resetting to ready (even via direct DB query)",
        "All functions use retries: 0",
      ],
      testing:
        "Vitest for backend (test/*.test.ts) and frontend (web/src/components/__tests__/). Playwright for E2E. Always run tsc, lint, format:check before committing.",
      windows_specifics:
        "EPERM retry in worktree ops, taskkill for process cleanup, .cmd shim resolution for Claude binary, DLL_INIT cooldown on startup",
      session_bridge_pattern:
        "Inngest steps must not block for 10-45 min Claude sessions. step.run() spawns process and returns. bridgeSessionCompletion() (fire-and-forget) watches process then calls inngest.send(session/completed) when done.",
    },
  },
  {
    context_key: "orca/task-lifecycle",
    description:
      "Full task lifecycle: states, transitions, Inngest workflows, and key behaviors",
    context_value: {
      states: [
        "backlog",
        "ready",
        "running",
        "in_review",
        "awaiting_ci",
        "deploying",
        "changes_requested",
        "done",
        "failed",
      ],
      state_machine:
        "backlog/ready -> running [implement] -> in_review (PR exists) -> running [review] -> approved: awaiting_ci->merge->deploying->done OR done directly (strategy=none). changes_requested -> running [fix] -> in_review loop. failed -> retry up to ORCA_MAX_RETRIES then permanent failed",
      inngest_events: {
        "task/ready":
          "Triggers task-lifecycle workflow (implement->Gate2->review->fix loop)",
        "task/awaiting-ci":
          "Triggers ci-gate-merge workflow (poll mergeStateStatus, merge when CLEAN)",
        "task/deploying":
          "Triggers deploy-monitor workflow (poll GitHub Actions runs by merge commit SHA)",
        "session/completed":
          "Emitted by bridgeSessionCompletion when Claude process exits. exitCode=0 means success.",
      },
      gate_2:
        "Post-implement verification: gh pr list --head <branch>, then URL extraction from agent output, then worktree diff check. No PR = failure + retry.",
      review_agent:
        "haiku model. Must output REVIEW_RESULT:APPROVED or REVIEW_RESULT:CHANGES_REQUESTED. No marker = retry review.",
      retry_logic:
        "retry_count < ORCA_MAX_RETRIES (default 3) -> reset to ready + emit task/ready. Exhausted -> permanent failed, Linear write-back to Canceled.",
      resume:
        "If implement hits error_max_turns: preserve worktree, retry sets back to ready, next dispatch detects previous max-turns invocation and passes --resume <sessionId>.",
      linear_writeback: {
        "ready->running": "In Progress",
        implement_done: "In Review",
        changes_requested: "In Progress",
        done: "Done",
        retry: "Todo",
        permanent_failed: "Canceled",
      },
      parent_child:
        "Parent issues (is_parent=1) are tracked but never dispatched. Child agents get parent context in prompt under ## Parent Issue header. Parent status rolls up from children.",
      cleanup_cron:
        "Every 5 min: delete stale orca/* branches (>60min, no running invocations, no open PRs), remove orphaned worktrees.",
      stuck_task_reconciler:
        "Every 5 min: re-emits events for tasks stuck in ready/awaiting_ci/deploying with no active Inngest workflow.",
      self_deploy:
        "When task repoPath matches Orca own process.cwd(), spawns scripts/deploy.sh detached after merge/deploy success.",
    },
  },
];

function mcpRequest(sessionId, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname,
        port: parseInt(port) || 8080,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
      },
      (res) => {
        const sessionIdHeader = res.headers["mcp-session-id"];
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            sessionId: sessionIdHeader,
            body: data,
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseEvent(rawBody) {
  const match = rawBody.match(/^data: (.+)$/m);
  if (match) return JSON.parse(match[1]);
  return JSON.parse(rawBody);
}

async function main() {
  console.log(`Connecting to Agent-MCP at ${MCP_URL}...`);

  // Initialize session
  const initRes = await mcpRequest(null, {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "orca-seed", version: "1.0" },
    },
    id: 1,
  });

  if (initRes.statusCode !== 200) {
    console.error("Failed to initialize MCP session:", initRes.body);
    process.exit(1);
  }

  const sessionId = initRes.sessionId;
  console.log(`Session ID: ${sessionId}`);

  // Seed all 4 context entries in one bulk call
  console.log("Seeding 4 context entries...");
  const seedRes = await mcpRequest(sessionId, {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "bulk_update_project_context",
      arguments: { token: AUTH_TOKEN, updates: contextUpdates },
    },
    id: 2,
  });

  const result = parseEvent(seedRes.body);
  const text = result?.result?.content?.[0]?.text || JSON.stringify(result);
  console.log("\nResult:", text);

  if (result?.error) {
    console.error("Error seeding context:", result.error);
    process.exit(1);
  }

  console.log(
    '\nDone. Verify with: view_project_context({ token, search_query: "orca" })',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
