# ADR: MCP as Pluggable Extension Mechanism (EMI-349)

**Status:** Accepted — Partial Adoption
**Date:** 2026-03-15
**Linear:** EMI-128 (discovery), EMI-349 (this ADR)

---

## Context

Orca hardcodes all integrations — Linear, GitHub, context injection — in TypeScript. Adding a new data source requires writing a client, wiring it into the scheduler, and redeploying.

MCP (Model Context Protocol) offers an alternative: integrations live as independent servers, and Orca passes them per-session via `--mcp-config`. Most MCP servers already exist in the ecosystem (Linear, GitHub, Notion, etc.), so Orca could gain integrations without maintaining them.

The question: should Orca adopt MCP as its primary extension mechanism, replacing hardcoded TypeScript integrations?

---

## MCP Ecosystem Survey

| Integration | Official Server | Transport | Auth | Scheduler-replaceable? | Agent-session usable? |
|---|---|---|---|---|---|
| Linear | `https://mcp.linear.app/mcp` | HTTP | OAuth2 | **No** — OAuth is interactive | Yes (read context) |
| GitHub | `https://api.githubcopilot.com/mcp/` | HTTP | PAT via header | **No** — scheduler uses gh CLI outside sessions | **Yes** — works headlessly |
| Notion | `https://mcp.notion.com/mcp` | HTTP | OAuth2 | No | Yes |
| Datadog | None | — | — | — | — |
| Sentry | `https://mcp.sentry.dev/mcp` | HTTP | OAuth2 | No | Yes |

### `--mcp-config` Flag Capabilities

- Accepts file path or inline JSON — fully dynamic, different config per invocation
- `--strict-mcp-config` disables user-scope servers for clean isolation
- Config format: `{ "mcpServers": { "<name>": { "type": "http", "url": "...", "headers": {...} } } }`
- Environment variable expansion (`${VAR}`) supported in url/headers fields

---

## Decision

**Adopt MCP for agent-facing integrations only. Scheduler integrations remain hardcoded.**

### Why scheduler integrations cannot be replaced

`src/linear/client.ts` drives the scheduler's core lifecycle: webhook ingestion, full sync, state write-back, conflict resolution, and polling fallback. Linear's official MCP server uses OAuth2 (interactive browser flow) — not suitable for headless server operation. This integration must remain as native TypeScript.

`src/github/index.ts` handles PR merge, CI polling, and deploy monitoring — all running *between* agent sessions as scheduler infrastructure. These calls happen outside any Claude session context, so MCP servers (which only exist within a session) cannot replace them.

### What MCP enables

MCP is additive for agent sessions. Within a Claude Code session, agents can use MCP tools to access richer context and perform actions with structured APIs rather than raw CLI commands.

Three concrete capabilities become possible:

1. **Runner `--mcp-config` injection** (EMI-380): infrastructure change to pass per-session MCP config when spawning Claude. Enables everything below.

2. **Orca-state MCP server** (EMI-381): expose Orca's own DB state (task metadata, invocation history, cost data) to agents. Agents can query what task they're implementing, review history, check budget. This is a novel capability that doesn't exist in any external MCP ecosystem.

3. **GitHub MCP in agent sessions** (EMI-382): structured GitHub API tools for agents (create PRs, read CI status, review diffs) without raw `gh` CLI dependency. Scoped to agent sessions only — scheduler-side `gh` CLI stays.

---

## Consequences

### Adopted

- MCP becomes the extension point for agent-session integrations
- New integrations (Notion, Sentry, custom tools) can be added without modifying Orca's scheduler code
- `--strict-mcp-config` prevents user-installed MCP servers from leaking into Orca sessions

### Not changed

- `src/linear/client.ts` — scheduler sync, webhook, write-back remain native TypeScript
- `src/github/index.ts` — scheduler-side PR/CI/deploy operations remain native TypeScript
- `src/runner/index.ts` session spawning — unchanged except for `--mcp-config` flag addition (EMI-380)

### Follow-up issues

- **EMI-380**: Migrate runner to pass `--mcp-config` per-session
- **EMI-381**: Build Orca-state MCP server (expose DB to agents)
- **EMI-382**: Add GitHub MCP server to agent sessions (replace `gh` CLI in-session)
