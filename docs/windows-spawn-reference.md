# Windows Spawn Reference: Claude Code CLI from Node.js

Reference for spawning Claude Code CLI as a child process on Windows. Covers known issues, the current solution, and alternative approaches evaluated during the 2026-03-08 incident.

## Current Solution

Orca uses `resolveClaudeBinary()` in `src/runner/index.ts` to bypass the npm `.cmd` shim and spawn `node cli.js` directly. See `INCIDENT.md` for the full postmortem.

## The Three Windows Spawn Problems

### 1. `.cmd` shim ENOENT

`spawn("claude", args)` fails with ENOENT on Windows because `claude` is an npm `.cmd` batch shim, not an executable. Node's `spawn()` without `shell: true` cannot execute `.cmd` files.

**Fix:** Parse the shim, extract the `cli.js` path, spawn `node cli.js` directly.

### 2. DEP0190 (Node v24+)

Node v24 deprecated passing args to `spawn()` with `shell: true` due to injection risk. This was the old workaround for `.cmd` shims. See [nodejs/node#58763](https://github.com/nodejs/node/issues/58763).

The catch-22: `shell: true` is needed for `.cmd` shims, but `shell: true` with args is deprecated. The only clean solutions are to bypass the shim or use `cross-spawn`.

### 3. Nested session env vars

Claude Code detects nesting via `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`. When Orca runs under Claude Code, these leak to child processes. Strip them case-insensitively:

```ts
const STRIP_VARS = new Set(["claudecode", "claude_code_entrypoint"]);
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !STRIP_VARS.has(key.toLowerCase()),
  ),
);
```

## Alternative Approaches (Evaluated, Not Adopted)

### `cross-spawn` npm package

Drop-in replacement for `child_process.spawn` that handles `.cmd` shim resolution automatically. Used by ~50k packages. Would make `resolveClaudeBinary()` unnecessary.

```ts
import spawn from 'cross-spawn';
// Same API as child_process.spawn, handles .cmd shims on Windows
const child = spawn('claude', args, { env: childEnv });
```

**Why not adopted:** Custom shim parsing was already written and verified. `cross-spawn` is worth considering if `resolveClaudeBinary()` breaks or becomes hard to maintain.

- Repo: https://github.com/moxystudio/node-cross-spawn

### Spawn via `cmd.exe` explicitly

Avoids `shell: true` while still executing `.cmd` files:

```ts
spawn('cmd.exe', ['/d', '/s', '/c', 'claude', ...args], { env: childEnv });
```

Recommended in [DEP0190 discussion](https://github.com/nodejs/node/issues/58763). Simple but passes through the shell layer (injection risk if args aren't controlled).

### Claude Agent SDK (TypeScript)

Official SDK for using Claude Code as a library rather than spawning the CLI.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

**Why not adopted:**
- **Requires an Anthropic API key with per-token billing.** Orca uses Claude Code CLI under a Max/Pro subscription — no per-call cost.
- ~12 second overhead per `query()` call due to subprocess initialization ([anthropics/claude-agent-sdk-typescript#34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34))
- No daemon mode yet ([anthropics/claude-agent-sdk-typescript#33](https://github.com/anthropics/claude-agent-sdk-typescript/issues/33))

**Docs:**
- Overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript reference: https://platform.claude.com/docs/en/agent-sdk/typescript
- V2 preview (simpler session API): https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview

**Worth revisiting if:** Anthropic adds subscription-based SDK access, or if the 12s overhead is resolved via daemon mode.

### tmux-based runtime (agent-orchestrator pattern)

[ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) manages Claude Code sessions via tmux instead of `child_process.spawn()`. Each agent runs in an isolated tmux session.

**Advantages:**
- Completely bypasses Node's spawn issues
- Agents survive orchestrator crashes/restarts
- Agent-agnostic (supports Claude Code, Codex, Aider)
- Plugin architecture for runtime, workspace, tracker, SCM

**Disadvantages:**
- Requires tmux (Linux/WSL2 only)
- Heavier architecture — Orca's direct spawn + stream-json parsing is simpler
- Log streaming and stdin interaction need different plumbing

**Worth revisiting if:** Orca moves to Linux/WSL2, or if Windows spawn issues keep recurring.

### Run Orca on WSL2

Move Orca's runtime from Windows to WSL2 Ubuntu (where Dagster already runs). Eliminates the entire class of Windows `.cmd` shim issues permanently.

**Advantages:**
- No `.cmd` shims on Linux — `claude` is a real executable
- No DEP0190 concerns
- No path-with-spaces issues
- Consistent with the rest of the infrastructure

**Disadvantages:**
- Needs WSL2 setup, port forwarding for dashboard
- File system performance across WSL2/Windows boundary

## Node.js Issues Referenced

| Issue | Description |
|-------|-------------|
| [nodejs/node#58763](https://github.com/nodejs/node/issues/58763) | DEP0190 not fixable when `stdio` option is required |
| [nodejs/node#58735](https://github.com/nodejs/node/issues/58735) | Conflict between child_process API guidance and DEP0190 |
| [nodejs/node#7367](https://github.com/nodejs/node/issues/7367) | spawn fails when both command and argument contain spaces |
| [anthropics/claude-code#4759](https://github.com/anthropics/claude-code/issues/4759) | DEP0190 warning on startup (fixed in v1.0.68) |
