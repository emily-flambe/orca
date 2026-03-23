# MCP Architecture Decision

**Status:** Adopted (partial) — see [EMI-349](https://linear.app/emily-cogsdill/issue/EMI-349)

## Decision

Adopt MCP for **agent-facing integrations only**. Scheduler-side integrations remain hardcoded TypeScript.

## What stays hardcoded

| Integration | Reason not replaceable by MCP |
|---|---|
| `src/linear/client.ts` | Runs outside agent sessions (sync, webhooks, write-back). Linear MCP uses OAuth2 (interactive). |
| `src/github/index.ts` | Scheduler-driven (PR merge, CI polling, deploy monitoring). Runs between agent sessions. |

## What MCP enables

| Issue | Description |
|---|---|
| [EMI-380](https://linear.app/emily-cogsdill/issue/EMI-380) | Runner: pass `--mcp-config` per-session — enabling infrastructure for all MCP integrations |
| [EMI-381](https://linear.app/emily-cogsdill/issue/EMI-381) | Orca-state MCP server — expose DB state (task metadata, invocation history) to agents |
| [EMI-382](https://linear.app/emily-cogsdill/issue/EMI-382) | GitHub MCP in agent sessions — structured GitHub API tools for agents |

## MCP Ecosystem Summary

| Server | URL | Auth | Notes |
|---|---|---|---|
| Linear (official) | `https://mcp.linear.app/mcp` | OAuth2 | Agent read-only use only |
| GitHub (official) | `https://api.githubcopilot.com/mcp/` | PAT via header | Works headlessly — suitable for agent sessions |
| Notion (official) | `https://mcp.notion.com/mcp` | OAuth2 | Available if needed |
| Datadog | None | — | No official MCP server exists |

## `--mcp-config` Flag

- Per-invocation, accepts file path or inline JSON
- `--strict-mcp-config` disables user-scope servers for clean isolation
- Config format: `{ "mcpServers": { "<name>": { "type": "http", "url": "...", "headers": {...} } } }`
- Environment variable expansion (`${VAR}`) supported in url/headers

## Discovery Source

[EMI-128](https://linear.app/emily-cogsdill/issue/EMI-128) — surveyed MCP ecosystem, verified `--mcp-config` per-invocation behavior, assessed replaceability of existing integrations.
