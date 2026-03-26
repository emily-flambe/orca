# Agent-MCP Knowledge Graph

Agent-MCP runs as a local background service at `http://localhost:8080/mcp`. It maintains a persistent knowledge graph (SQLite at `C:\Users\emily\Documents\Github\.agent\mcp_state.db`) that Claude Code sessions can query without re-reading the codebase from scratch.

## Seeded Context Keys

Four high-level context entries are stored under the `orca/` prefix:

| Key | Contents |
|-----|----------|
| `orca/architecture` | Tech stack, module roles, deployment model, database schema overview |
| `orca/modules` | Per-directory purpose for all of `src/` and `web/` |
| `orca/conventions` | ESM imports, naming, DB access rules, Inngest invariants, session bridge pattern |
| `orca/task-lifecycle` | Full state machine, Inngest events, Gate 2, retry logic, Linear write-back |

## Querying in a Session

```typescript
// Retrieve a specific entry
view_project_context({ token: "...", context_key: "orca/architecture" })

// Search across all entries
view_project_context({ token: "...", search_query: "inngest" })

// Vector search (requires server restart with Ollama config — see below)
ask_project_rag("how does Orca dispatch tasks to Claude Code agents?")
```

## Re-seeding

Run from the repo root (server must be running):

```bash
node scripts/seed-agent-mcp.js
# Env overrides:
AGENT_MCP_URL=http://localhost:8080/mcp AGENT_MCP_TOKEN=<token> node scripts/seed-agent-mcp.js
```

## Agent-MCP Server Config

Location: `C:\Users\emily\Documents\GitHub\Agent-MCP\agent-mcp-node\`

Key `.env` settings:
```
EMBEDDING_PROVIDER=ollama
OLLAMA_MODEL=qwen3-embedding:0.6b
OLLAMA_URL=http://localhost:11434
OPENAI_API_KEY=ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=1024
MCP_PROJECT_DIR=C:\Users\emily\Documents\Github
```

Start command: `cd C:\Users\emily\Documents\GitHub\Agent-MCP\agent-mcp-node && npm run start -- --no-tui --port 8080 --project-dir "C:\Users\emily\Documents\Github"`

## RAG Indexing

The server auto-indexes all markdown files under `MCP_PROJECT_DIR` every 5 minutes. This includes Orca's `docs/` folder. After the server restarts with the updated `.env`, `ask_project_rag` will use Ollama (via its OpenAI-compatible API at `/v1`) for both indexing and query embeddings.

The `view_project_context` tool works immediately without embeddings — it does direct DB lookups against the manually-seeded entries.

## Auth Token

The admin token is stored in the Agent-MCP database. Get it via:
```
get_token({ name: "admin", show_full: true })
```
