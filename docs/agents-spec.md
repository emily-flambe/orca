# Agents Technical Spec

Persistent AI agents with memory and identity. Agents run on cron schedules like cron_claude tasks, but accumulate episodic/semantic/procedural memory across runs and carry a stable system prompt (program.md pattern).

## Motivation

Orca has two execution modes today:

- **Tasks** (Linear-driven): one-off work items with full lifecycle (implement, review, fix, merge, deploy)
- **Crons** (schedule-driven): stateless recurring work (shell commands or Claude sessions)

Agents fill the gap: recurring AI work that learns from past runs. An SRE agent reviews recent failures, remembers which fixes worked, and accumulates codebase knowledge. A docs agent notices undocumented patterns and remembers what it already documented.

## Status: Phase 1 Complete (Schema + Types + Queries)

The data layer is already implemented. Remaining work is Phases 2-6.

## Data Model

### agents table

Already implemented in `src/db/schema.ts`.

```
id              TEXT PK      — user-provided slug (e.g. "orca-sre")
name            TEXT NOT NULL
description     TEXT
system_prompt   TEXT NOT NULL — the agent's full personality/instructions (program.md)
model           TEXT         — override model, nullable (falls back to ORCA_IMPLEMENT_MODEL)
max_turns       INTEGER      — nullable
timeout_min     INTEGER      — NOT NULL DEFAULT 45
repo_path       TEXT         — nullable (falls back to ORCA_DEFAULT_CWD)
schedule        TEXT         — cron expression, nullable for event-only agents
max_memories    INTEGER      — NOT NULL DEFAULT 200
enabled         INTEGER      — NOT NULL DEFAULT 1 (SQLite boolean)
run_count       INTEGER      — NOT NULL DEFAULT 0
last_run_at     TEXT
next_run_at     TEXT
last_run_status TEXT         — "success" | "failed" | null
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL
```

### agent_memories table

Already implemented in `src/db/schema.ts`.

```
id              INTEGER PK AUTOINCREMENT
agent_id        TEXT NOT NULL  — no FK constraint, manual cascade in deleteAgent()
type            TEXT NOT NULL  — CHECK(type IN ('episodic','semantic','procedural'))
content         TEXT NOT NULL
source_run_id   TEXT           — nullable, links to task linearIssueId
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL

INDEX on agent_id
```

### tasks table addition

Already implemented. The `agent_id` column (nullable TEXT) links agent-spawned tasks back to their source agent.

### Memory Types

| Type | Purpose | Examples |
|------|---------|----------|
| `episodic` | What happened in past runs | "Run on 2026-03-20 found 3 flaky tests in ci-merge.test.ts, filed EMI-401" |
| `semantic` | Accumulated facts about the domain | "The deploy script uses blue/green on ports 4000/4001" |
| `procedural` | How-to knowledge, effective patterns | "When investigating OOM, check session-handles.ts activeHandles map first" |

## Types

Already implemented in `src/shared/types.ts`:

- `TASK_TYPES` includes `"agent"`
- `AGENT_MEMORY_TYPES = ["episodic", "semantic", "procedural"] as const`
- `Agent` interface with all fields
- `AgentMemory` interface with all fields
- `Task` interface has `agentId: string | null`

## Queries

Already implemented in `src/db/queries.ts` (16 functions):

| Function | Description |
|----------|-------------|
| `insertAgent` | Insert a new agent |
| `updateAgent` | Partial update on agent fields |
| `deleteAgent` | Delete agent + cascade delete all memories |
| `getAgent` | Get single agent by id |
| `getAllAgents` | Get all agents |
| `getDueAgents` | Get enabled agents where `next_run_at <= now` |
| `updateAgentLastRunStatus` | Update last_run_status field |
| `incrementAgentRunCount` | Increment run_count, set last_run_at and next_run_at |
| `insertAgentMemory` | Insert memory, returns id |
| `updateAgentMemory` | Update memory content/type |
| `deleteAgentMemory` | Delete single memory by id |
| `getAgentMemories` | Get memories for agent (newest first, with optional limit) |
| `getAgentMemoryCount` | Count memories for an agent |
| `deleteAllAgentMemories` | Delete all memories for an agent |
| `pruneAgentMemories` | Delete oldest memories when count exceeds max_memories |
| `getTasksByAgent` | Get all tasks spawned by an agent |

---

## Phase 2: API Routes

Add agent CRUD routes to `src/api/routes.ts`, following the cron route patterns.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List all agents |
| `GET` | `/api/agents/:id` | Get agent with recent memories (limit 20) + recent tasks |
| `POST` | `/api/agents` | Create agent |
| `PUT` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Delete agent + memories |
| `POST` | `/api/agents/:id/toggle` | Toggle enabled/disabled |
| `POST` | `/api/agents/:id/trigger` | Manual trigger (create task immediately) |
| `GET` | `/api/agents/:id/memories` | List memories (query param `?limit=100`) |
| `DELETE` | `/api/agents/:id/memories/:memoryId` | Delete single memory |

### Validation Rules

- `id`: required, slug format (lowercase alphanumeric + hyphens), max 64 chars
- `name`: required, non-empty, max 200 chars
- `system_prompt`: required, non-empty
- `schedule`: if provided, must be a valid cron expression (use existing `validateCronExpression`)
- `timeout_min`: positive integer, default 45
- `max_memories`: positive integer, default 200
- `model`: optional string

### Create Agent Request Body

```typescript
{
  id: string;           // slug, e.g. "orca-sre"
  name: string;
  description?: string;
  systemPrompt: string; // the program.md content
  model?: string;
  maxTurns?: number;
  timeoutMin?: number;  // default 45
  repoPath?: string;
  schedule?: string;    // cron expression
  maxMemories?: number; // default 200
}
```

### Create Response

Return the created agent object. Set `next_run_at` from schedule if provided (use `computeNextRunAt`).

### Detail Response (GET /api/agents/:id)

```typescript
{
  ...agent,
  memories: AgentMemory[];       // most recent 20
  recentTasks: Task[];           // from getTasksByAgent, sorted newest first, limit 20
}
```

### Manual Trigger (POST /api/agents/:id/trigger)

Same pattern as `POST /api/cron/:id/trigger`:

1. Validate agent exists and is enabled
2. Generate task ID: `agent-<agentId>-<timestamp>-<random>`
3. Insert task with `taskType: "agent"`, `agentId: agent.id`
4. Use agent's `system_prompt` as `agentPrompt` (the system prompt IS the prompt)
5. Emit `task/ready` via Inngest
6. Return the created task

---

## Phase 3: Inngest Workflow

### agent-dispatch (new Inngest cron)

New file: `src/inngest/workflows/agent-dispatch.ts`

Runs every minute (separate Inngest cron, same as `cron-dispatch`).

```
Steps:
1. get-due-agents: call getDueAgents(db, now)
2. For each due agent:
   a. Check no existing running task for this agent
   b. Generate task ID: agent-<agentId>-<timestamp>-<random>
   c. Insert task (taskType: "agent", agentId: agent.id)
   d. Set agentPrompt = agent.systemPrompt
   e. incrementAgentRunCount(db, agent.id, computeNextRunAt(agent.schedule))
   f. Emit task/ready event
3. Return { dispatched: count }
```

**Capacity block handling**: If the concurrency cap is full when the agent task runs, the task-lifecycle claim step fails. Unlike linear tasks which stay in `ready`, agent tasks should be deleted — the agent will re-dispatch on its next schedule. This prevents queue buildup from agents that can't run.

**Duplicate prevention**: Before inserting a task, check if there's already a `running` or `ready` task with `agentId = agent.id`. If so, skip dispatch (the previous run hasn't finished).

### agent-task-lifecycle (new Inngest function)

New file: `src/inngest/workflows/agent-task-lifecycle.ts`

Mirrors `cron-task-lifecycle` with these differences:

1. **Event filter**: `event.data.taskType == 'agent'`
2. **Memory injection**: Before spawning the session, load memories and format as append-system-prompt
3. **No review loop**: Agent tasks go straight to done/failed after implement phase (MVP)
4. **Post-run pruning**: After task completes, call `pruneAgentMemories` to enforce max_memories
5. **Update agent status**: Call `updateAgentLastRunStatus` on completion

### Memory Injection Format

Memories are loaded from DB and formatted as markdown, injected via `--append-system-prompt`:

```markdown
## Your Memories

### Episodic (What happened)
- [2026-03-20] Run on 2026-03-20 found 3 flaky tests in ci-merge.test.ts
- [2026-03-18] Investigated OOM in runner — activeHandles map was leaking

### Semantic (What you know)
- Deploy script uses blue/green on ports 4000/4001
- Linear webhook secret rotates monthly

### Procedural (How to do things)
- When investigating OOM, check session-handles.ts activeHandles map first
- To verify deploy health, check deploy-state.json timestamp + query /api/status
```

**Rules:**
- Group by type with headers
- Most recent first within each type
- Include date prefix from `created_at` (date only, not full ISO)
- If no memories exist, omit the section entirely
- Limit to agent's `max_memories` setting

### Registration

Add both new workflows to `src/inngest/functions.ts`:

```typescript
import { agentDispatchWorkflow } from "./workflows/agent-dispatch.js";
import { agentTaskLifecycle } from "./workflows/agent-task-lifecycle.js";

export const functions = [
  // ... existing
  agentDispatchWorkflow,
  agentTaskLifecycle,
];
```

---

## Phase 4: MCP Server Extension

Extend the existing MCP server (`src/mcp-server/index.ts`) with write tools for agent memory management.

### Gating

Write tools are only available when `ORCA_AGENT_ID` env var is set. The runner injects this env var when spawning agent sessions.

```typescript
const agentId = process.env.ORCA_AGENT_ID;
if (agentId) {
  // Register write tools
}
```

The MCP server DB connection must be opened read-write (not `readonly: true`) when `ORCA_AGENT_ID` is set.

### New Tools

| Tool | Description |
|------|-------------|
| `save_agent_memory` | Create a new memory (type + content) |
| `update_agent_memory` | Update existing memory by id |
| `forget_agent_memory` | Delete a memory by id |
| `get_agent_memories` | List memories, optionally filtered by type |

### Tool Definitions

**save_agent_memory**
```
Input: { type: "episodic" | "semantic" | "procedural", content: string }
Effect: insertAgentMemory(db, { agentId, type, content })
        then pruneAgentMemories(db, agentId, agent.maxMemories)
Output: { id, type, content, created_at }
```

**update_agent_memory**
```
Input: { memory_id: number, content: string, type?: string }
Effect: updateAgentMemory(db, memory_id, { content, type, updatedAt })
        Validates memory belongs to this agent
Output: updated memory object
```

**forget_agent_memory**
```
Input: { memory_id: number }
Effect: Validates memory belongs to this agent, then deleteAgentMemory(db, memory_id)
Output: { deleted: true }
```

**get_agent_memories**
```
Input: { type?: "episodic" | "semantic" | "procedural", limit?: number }
Effect: getAgentMemories(db, agentId, limit) with optional type filter
Output: array of memory objects
```

### Runner Changes

When spawning an agent task, the runner must:

1. Set `ORCA_AGENT_ID=<agentId>` in the child process environment
2. Open the MCP server DB connection read-write instead of read-only

The MCP config already gets passed via `--mcp-config`. The agent ID env var is the only addition.

---

## Phase 5: Dashboard

### /agents page

Add to the React dashboard sidebar navigation. Follows `/cron` page patterns.

#### List View
- Table with columns: Name, Status (enabled/disabled), Schedule, Last Run, Run Count, Actions
- Toggle button (enable/disable)
- Trigger button (manual run)
- Create button opens form
- Click row to see detail

#### Create/Edit Form
- Fields: id (create only), name, description, system_prompt (large textarea), model, maxTurns, timeoutMin, repoPath, schedule, maxMemories
- Schedule field with cron expression validation
- system_prompt textarea should be tall (min 20 rows) since it holds the full program.md

#### Detail View (GET /api/agents/:id)
- Agent metadata card
- Memory timeline: list of memories grouped by type, with delete button per memory
- Recent tasks list with status indicators
- Manual trigger button

### Navigation

Add "Agents" to the sidebar between "Cron" and "Logs":

```
Dashboard | Metrics | Tasks | Cron | Agents | Logs | Settings
```

Route: `/agents` (list), `/agents/:id` (detail)

---

## Phase 6: Orca SRE Agent (First Real Agent)

The first agent validates the architecture. Its system prompt:

### Identity
- Name: `orca-sre`
- Schedule: `0 */4 * * *` (every 4 hours)
- Repo: orca's own repo path
- Model: default (sonnet)
- Timeout: 30 min
- Max memories: 200

### System Prompt (program.md)

The SRE agent's prompt instructs it to:

1. **Review recent task outcomes**: Query Orca's API for failed/completed tasks since last run
2. **Check for patterns**: Are the same tests failing? Are timeouts clustering?
3. **Self-directed triage**: Prioritize what to investigate based on severity and recurrence
4. **Take action**: File issues, write fixes, or document findings
5. **Remember**: Save episodic memories about what happened, semantic memories about what was learned, procedural memories about effective debugging approaches

### Crash Recovery

Baked into the system prompt: if the agent's memories indicate a previous run crashed or was interrupted, it should check whether its last action completed and pick up where it left off.

### Memory Usage Example

After a run that investigated flaky tests:

```
episodic: "2026-03-22 run: found ci-merge.test.ts timing out in CI due to
          Inngest step mock not resolving. Filed EMI-412. Applied fix in
          commit abc123."

semantic: "ci-merge.test.ts uses a custom Inngest step mock that requires
          explicit resolution — default vitest timers don't work."

procedural: "When Inngest workflow tests time out, check if step.waitForEvent
            mock is configured to resolve. The mock setup is in
            test/helpers/inngest-mock.ts."
```

---

## Design Principles

### Agents are additive
Crons (claude and shell types) remain unchanged. Agent dispatch is a separate Inngest cron. Agent lifecycle is a separate workflow. No modifications to existing cron behavior.

### Memory is simple
SQLite rows, not vector DB. No embeddings, no similarity search, no knowledge graphs. Retrieval is "all memories for this agent, newest first, grouped by type." Pruning is "delete oldest when over limit."

This is deliberately simple. If retrieval quality becomes a problem, the fix is better prompting (teach the agent to write more useful memories), not infrastructure complexity.

### The agent IS its system prompt
Following Karpathy's program.md pattern. The `system_prompt` field is the complete definition of the agent's behavior. The agent's personality, goals, tools, and constraints are all in one place. No code changes needed to create a new agent — just write a prompt.

### No over-engineering
- No embedding search — full memory list injected every run
- No memory importance scoring — pruning is oldest-first
- No inter-agent communication — agents are independent
- No complex retrieval — group by type, sort by date
- No workflow customization — all agents use the same lifecycle

### Task ID Convention

Agent tasks use the pattern: `agent-<agentId>-<timestamp>-<random5>`

Example: `agent-orca-sre-1711100000000-x7k2m`

This mirrors the cron convention (`cron-<scheduleId>-<timestamp>-<random5>`) and ensures task IDs are globally unique and traceable to their source.

---

## Implementation Order

| Phase | Work | Dependencies |
|-------|------|-------------|
| 1 | Schema + Types + Queries | None (done) |
| 2 | API Routes | Phase 1 |
| 3 | Inngest Workflows (dispatch + lifecycle) | Phase 2 |
| 4 | MCP Server Extension | Phase 3 |
| 5 | Dashboard UI | Phase 2 |
| 6 | Orca SRE Agent | Phases 3 + 4 |

Phases 2 and 5 can run in parallel. Phase 4 can start after Phase 3. Phase 6 is validation — it should be attempted only after the full pipeline is wired.

---

## Open Questions

None. All decisions have been made. Ship it.
