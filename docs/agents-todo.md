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

## Phase 2: API Routes ✅

- [x] Add `GET /api/agents` — list all agents
- [x] Add `GET /api/agents/:id` — get agent with recent memories + task history
- [x] Add `POST /api/agents` — create agent (validate required fields, generate timestamps)
- [x] Add `PUT /api/agents/:id` — update agent
- [x] Add `DELETE /api/agents/:id` — delete agent + all memories
- [x] Add `POST /api/agents/:id/toggle` — enable/disable
- [x] Add `POST /api/agents/:id/trigger` — manual trigger (create task, emit task/ready)
- [x] Add `GET /api/agents/:id/memories` — list memories (with optional type filter)
- [x] Add `DELETE /api/agents/:id/memories/:memoryId` — delete single memory
- [ ] Add tests for agent API routes

## Phase 3: Inngest Workflows ✅

- [x] Create `src/inngest/workflows/agent-dispatch.ts` — Inngest cron (every minute), calls getDueAgents(), creates tasks, emits task/ready
- [x] Handle task ID format: `agent-<agentId>-<timestamp>-<random>`
- [x] Handle capacity block: delete task and return (re-dispatch on next schedule)
- [x] Separate agent-task-lifecycle workflow with memory injection via --append-system-prompt
- [x] Build memory injection: load memories, format as markdown (grouped by type), pass to session
- [x] Register new workflows in `src/inngest/functions.ts`
- [ ] Add tests for agent dispatch and memory injection

## Phase 4: MCP Server Extension ✅

- [x] Add `save_agent_memory` tool to `src/mcp-server/index.ts`
- [x] Add `update_agent_memory` tool
- [x] Add `forget_agent_memory` tool (delete)
- [x] Add `get_agent_memories` tool (read own memories)
- [x] Gate write tools behind `ORCA_AGENT_ID` env var (only available to agent sessions)
- [x] Pass `ORCA_AGENT_ID` env var when spawning agent sessions via MCP config
- [ ] Add tests for MCP memory tools

## Phase 5: Dashboard ✅

- [x] Create `web/src/components/AgentsPage.tsx` — agent list with create/edit/delete/toggle/trigger + inline memory view
- [x] Add `/agents` route to `web/src/App.tsx`
- [x] Add Agents nav item to `web/src/components/Sidebar.tsx`
- [x] Add Agent/AgentMemory types to `web/src/types.ts`
- [x] Add agent API hooks to `web/src/hooks/useApi.ts`
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
