# Agent Orchestration — Implementation TODO

## Phase 1: Schema + Types + Queries ✅

- [x] Add `agents` table to `src/db/schema.ts`
- [x] Add `agent_memories` table to `src/db/schema.ts`
- [x] Add `agent_id` column to `tasks` table
- [x] Add CREATE TABLE SQL + migrations to `src/db/index.ts`
- [x] Add `Agent`, `AgentMemory` interfaces to `src/shared/types.ts`
- [x] Add `"agent"` to `TASK_TYPES`
- [x] Add `AGENT_MEMORY_TYPES` constant and type
- [x] Add `agentId` to `Task` interface
- [x] Add 16 query functions to `src/db/queries.ts` (agent CRUD, memory CRUD, getDueAgents, pruneAgentMemories, getTasksByAgent)
- [x] Type check passes (zero errors in modified files)

## Phase 2: API Routes

- [ ] Add `GET /api/agents` — list all agents
- [ ] Add `GET /api/agents/:id` — get agent with recent memories + task history
- [ ] Add `POST /api/agents` — create agent (validate required fields, generate timestamps)
- [ ] Add `PUT /api/agents/:id` — update agent
- [ ] Add `DELETE /api/agents/:id` — delete agent + all memories
- [ ] Add `POST /api/agents/:id/toggle` — enable/disable
- [ ] Add `POST /api/agents/:id/trigger` — manual trigger (create task, emit task/ready)
- [ ] Add `GET /api/agents/:id/memories` — list memories (with optional type filter)
- [ ] Add `DELETE /api/agents/:id/memories/:memoryId` — delete single memory
- [ ] Add tests for agent API routes

## Phase 3: Inngest Workflows

- [ ] Create `src/inngest/workflows/agent-dispatch.ts` — Inngest cron (every minute), calls getDueAgents(), creates tasks, emits task/ready
- [ ] Handle task ID format: `agent-<agentId>-<timestamp>-<random>`
- [ ] Handle capacity block: delete task and return (re-dispatch on next schedule)
- [ ] Modify task-lifecycle to detect agent tasks and inject memories via --append-system-prompt
- [ ] Build memory injection: load memories, format as markdown (grouped by type), pass to session
- [ ] Register new workflow in `src/inngest/functions.ts`
- [ ] Add agent-dispatch events to `src/inngest/events.ts` if needed
- [ ] Add tests for agent dispatch and memory injection

## Phase 4: MCP Server Extension

- [ ] Add `save_agent_memory` tool to `src/mcp-server/index.ts`
- [ ] Add `update_agent_memory` tool
- [ ] Add `forget_agent_memory` tool (delete)
- [ ] Add `get_agent_memories` tool (read own memories)
- [ ] Gate write tools behind `ORCA_AGENT_ID` env var (only available to agent sessions)
- [ ] Pass `ORCA_AGENT_ID` env var when spawning agent sessions
- [ ] Add tests for MCP memory tools

## Phase 5: Dashboard

- [ ] Create `web/src/pages/AgentsPage.tsx` — agent list with create/edit/delete
- [ ] Create `web/src/pages/AgentDetailPage.tsx` — agent detail with memory timeline + task history
- [ ] Create `web/src/components/AgentForm.tsx` — create/edit form
- [ ] Add `/agents` route to `web/src/App.tsx`
- [ ] Add Agents nav item to `web/src/components/Sidebar.tsx`
- [ ] Add frontend tests

## Phase 6: Orca SRE Agent

- [ ] Write system prompt for "Orca SRE" agent (program.md style)
- [ ] Create agent via API or seed script
- [ ] Validate full loop: schedule triggers → task created → session runs with memory injection → memories saved via MCP → next run sees previous memories
- [ ] Migrate existing "improve orca" cron to agent
- [ ] End-to-end verification

## Dependencies

- Phase 2 depends on Phase 1 ✅
- Phase 3 depends on Phase 1 ✅
- Phase 4 depends on Phase 3 (needs agent session spawning)
- Phase 5 depends on Phase 2 (needs API routes)
- Phase 6 depends on Phases 3 + 4 (needs full workflow + MCP)
- Phases 2 and 3 can be worked in parallel after Phase 1
