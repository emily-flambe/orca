# Orca Agents: Journey So Far & Next Steps

## What We Built

Added persistent, memory-accumulating AI agents to Orca. Unlike one-off tasks (Linear issues) or stateless crons, agents have persistent identity, accumulated memory across invocations, and self-directed prioritization.

### Architecture

**Schema** (`src/db/schema.ts`, `src/db/index.ts`):
- `agents` table: id, name, description, systemPrompt, model, maxTurns, timeoutMin, repoPath, schedule, maxMemories, enabled, runCount, lastRunAt, nextRunAt, lastRunStatus
- `agent_memories` table: id, agentId, type (episodic/semantic/procedural), content, sourceRunId, timestamps
- `agent_id` column added to `tasks` table

**Queries** (`src/db/queries.ts`): 17 functions — full CRUD for agents and memories, `getDueAgents()` for cron dispatch, memory pruning (oldest-first when count exceeds `maxMemories`).

**API** (`src/api/routes.ts`): 9 endpoints:
- `GET/POST /api/agents` — list all, create
- `GET/PUT/DELETE /api/agents/:id` — read, update, delete (cascades memories)
- `POST /api/agents/:id/toggle` — enable/disable
- `POST /api/agents/:id/trigger` — manual trigger
- `GET /api/agents/:id/memories` — list memories
- `DELETE /api/agents/:id/memories/:memoryId` — delete memory (with ownership check)

**Inngest Workflows** (`src/inngest/workflows/`):
- `agent-dispatch.ts` — cron (every minute) checks `getDueAgents()`, creates task with `taskType: "agent"`, emits `task/ready`
- `agent-task-lifecycle.ts` — claim → load agent+memories → format memories as markdown → inject via `--append-system-prompt` → spawn session → wait → finalize → update `lastRunStatus`
- Standard `task-lifecycle.ts` updated to exclude `taskType == 'agent'` events

**MCP Server** (`src/mcp-server/index.ts`): 4 memory tools gated by `ORCA_AGENT_ID` env var:
- `get_agent_memories` — retrieve all memories for this agent
- `save_agent_memory` — persist new memory (episodic/semantic/procedural)
- `update_agent_memory` — update existing memory content
- `forget_agent_memory` — delete a memory
- DB connection switches to read-write mode when `ORCA_AGENT_ID` is set

**Dashboard** (`web/src/components/AgentsPage.tsx`):
- Full CRUD page (create/edit/delete agents via forms)
- Toggle enable/disable, "Run now" manual trigger
- Expandable system prompt (click to expand/collapse)
- Expandable memories section with type badges and delete buttons
- Expandable recent tasks with clickable rows that navigate to `/tasks/:id` log viewer
- Sidebar nav item, header title

**Memory Injection**: Memories formatted as markdown grouped by type (episodic → semantic → procedural), most recent first within each group, injected via `--append-system-prompt`.

**First Agent**: "Orca SRE" — autonomous site reliability agent with a `program.md`-style system prompt (`docs/orca-sre-prompt.md`). Runs every 12 hours, audits health, diagnoses problems, implements fixes, deploys. Old "Orca Health Audit" cron (ID 3) disabled.

### Test Coverage
- 64 query tests (`test/agent-queries.test.ts`)
- 59 API tests (`test/agent-api.test.ts`)
- Bugs found by adversarial tester and fixed: cross-agent memory deletion (ownership check), single-char ID validation, non-deterministic memory ordering

### PRs & Commits
- PR #458 (squash-merged): all Phase 1-6 implementation
- Post-merge commits on main: task-lifecycle filter fix, deploy script MCP build fix, clickable task rows, expandable prompt

## Bugs Found & Fixed

1. **Cross-agent memory deletion** — `DELETE /api/agents/:id/memories/:memoryId` didn't verify ownership. Added `getAgentMemory()` query + check.
2. **Single-char agent IDs bypassed validation** — regex required 2+ chars. Fixed with `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
3. **Non-deterministic memory ordering** — added `desc(agentMemories.id)` tiebreaker.
4. **Standard task-lifecycle also claiming agent tasks** — both workflows fired on `task/ready`. Added `event.data.taskType != 'agent'` filter.
5. **MCP server never built during deploy** — deploy script only built frontend. Agent sessions had no MCP tools, so memories couldn't be saved. Added `npm run build` (tsup) to deploy script.

## What's Missing — The Agent Gap

Right now agents are essentially **crons with memory injection**. The user correctly identified that this isn't enough to call them "agents." Key gaps:

### 1. No Interactive Communication
You can't chat with an agent. You can't send it an ad-hoc message like "hey, investigate the CI failures from last night" and have it respond in context with its memories. The only interaction is: trigger a full run, or wait for the schedule.

**What agents should support:**
- Send an ad-hoc prompt/message to a running or idle agent
- Agent responds using its accumulated memory context
- Conversation history is preserved (at least for the current session)
- Different from a regular task: the agent's identity, memories, and system prompt persist

### 2. No Conversational Memory
Memories are only saved if the agent explicitly calls MCP tools during a session. There's no automatic extraction of important findings. If the agent runs out of turns before Step 6 (save memories), nothing persists.

### 3. No Event-Driven Triggers
Agents only trigger on cron schedule or manual button press. They can't react to events like "a deploy failed" or "CI is red" or "a task has been stuck for 2 hours."

### 4. No Agent-to-Agent Communication
Agents can't delegate to or communicate with other agents.

### 5. Agent Sessions Are Fire-and-Forget
Once an agent session starts, you can only watch the logs. You can't inject context, redirect the agent, or ask follow-up questions mid-session.

## Research Prompt for Next Session

```
I'm building agent orchestration into Orca, an AI task scheduler. I've implemented
the basics (persistent agents with scheduled runs and memory injection via MCP tools)
but the current implementation is essentially "crons with memory."

I want to research and design the next evolution that makes these actual agents.
The key doc for current state is docs/agents-journey.md. The spec is docs/agents-spec.md.
The SRE agent prompt is docs/orca-sre-prompt.md.

### Research Questions

1. **Interactive agent communication**: How should users chat with agents? Options:
   - Dedicated chat UI per agent (like a ChatGPT conversation but with agent identity)
   - Ad-hoc prompt injection into the next scheduled run
   - Always-on agent process that accepts messages (vs. ephemeral session per run)
   - Resume-based: keep the Claude session alive and resume it with new messages

   Consider: Claude Code's `--resume` flag, session persistence, cost implications
   of keeping sessions alive vs. cold-starting with memory injection.

2. **Automatic memory extraction**: How should memories be captured without relying
   on the agent to explicitly call MCP tools? Options:
   - Post-session analysis: after a run completes, analyze the transcript and
     extract key findings as memories
   - Structured output: require agents to output a summary block that gets parsed
   - Hybrid: MCP tools during session + post-session extraction as fallback

3. **Event-driven triggers**: Beyond cron schedules, what events should agents
   react to? How to wire them up without over-engineering?
   - Orca internal events (task failed, deploy completed, CI red)
   - External webhooks (GitHub, Linear)
   - Other agents' outputs

4. **Agent autonomy spectrum**: Where on this spectrum should agents sit?
   - Fully autonomous (SRE agent: runs, fixes, deploys without asking)
   - Semi-autonomous (reports findings, asks for approval before acting)
   - Reactive (only responds to explicit prompts/events)
   - Should this be configurable per agent?

5. **Conversation vs. task model**: Should agent interactions be:
   - Conversations (stateful, back-and-forth, like a chat)
   - Tasks (stateless, fire-and-forget, current model)
   - Hybrid (default to task, but support follow-up within a time window)

6. **Reference architectures**: Look at how these systems handle agents:
   - OpenAI Assistants API (threads, runs, tool calls)
   - LangGraph (stateful agent graphs)
   - CrewAI (multi-agent orchestration)
   - Claude's own agent patterns (computer use, tool use loops)
   - Karpathy's "program.md" pattern (which we already follow for system prompts)

### Constraints

- Orca runs Claude Code CLI sessions. Each session is a child process with
  --output-format stream-json. Sessions are expensive ($2-5 per run).
- Memory is SQLite, not vector DB. Keep it simple.
- The dashboard is a React SPA — any chat UI needs to work within that.
- Agent sessions run in git worktrees. They can read/write code.
- Claude Code supports --resume to continue a session. This could be key for
  conversational agents.

### Deliverable

A revised agents-spec.md with:
1. Updated architecture for interactive agents
2. Chat UI design (wireframes or description)
3. Memory lifecycle (automatic extraction + manual MCP tools)
4. Event trigger system design
5. Implementation plan (phased, like before)
```

## Files Reference

| File | Role |
|------|------|
| `docs/agents-spec.md` | Technical specification |
| `docs/agents-todo.md` | Implementation checklist (Phases 1-6 done) |
| `docs/agents-journey.md` | This file — journey log and next steps |
| `docs/orca-sre-prompt.md` | First agent's system prompt |
| `src/db/schema.ts` | Drizzle schema (agents + agent_memories tables) |
| `src/db/queries.ts` | All agent/memory query functions |
| `src/api/routes.ts` | Agent API endpoints |
| `src/inngest/workflows/agent-dispatch.ts` | Cron-based agent dispatch |
| `src/inngest/workflows/agent-task-lifecycle.ts` | Agent session lifecycle |
| `src/mcp-server/index.ts` | Memory MCP tools (gated by ORCA_AGENT_ID) |
| `web/src/components/AgentsPage.tsx` | Dashboard CRUD page |
| `test/agent-queries.test.ts` | 64 query tests |
| `test/agent-api.test.ts` | 59 API tests |
