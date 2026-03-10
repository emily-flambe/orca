# INCIDENT: Windows spawn of Claude CLI broken under Node v24

**Date**: 2026-03-08
**Status**: Fixed and verified in live Orca dispatch
**Affected file**: `src/runner/index.ts`

---

## Problem

Orca spawns Claude Code CLI as a child process via `spawn("claude", [...args])`. On Windows, real scheduler dispatches were failing before Claude ever started.

Three separate issues were involved:

### Root cause 1: Windows `.cmd` shim resolution (`ENOENT`)

On Windows, `claude` is installed via npm and lives at:

```text
C:\Users\emily\AppData\Roaming\npm\claude.cmd
```

This is a batch shim, not a real executable. Orca was doing:

```ts
spawn("claude", args, ...)
```

and the child failed immediately with:

```text
spawn error: spawn claude ENOENT
```

This was reproduced directly on this machine:

```js
spawn("claude", ["--version"]) // -> ENOENT
```

while the direct CLI path worked:

```js
spawn(process.execPath, [cliJs, "--version"]) // -> success
```

### Root cause 2: One-shot Claude sessions hung because stdin stayed open

After bypassing the shim, Orca still had a runner bug: one-shot `-p` sessions could hang indefinitely if the child's stdin pipe remained open.

This was reproduced directly:

- `spawn(node, [cliJs, "-p", ...])` with stdin left open -> hangs
- same command with `child.stdin.end()` immediately after spawn -> completes successfully

So fixing Windows shim resolution alone was not sufficient.

### Root cause 3: Nested-session env vars leaked into child Claude processes

Claude Code detects nested sessions via:

- `CLAUDECODE`
- `CLAUDE_CODE_ENTRYPOINT`

When Orca itself runs under Claude Code, these vars can leak into the child process and cause Claude to refuse startup.

The old code only stripped `CLAUDECODE` via:

```ts
const childEnv = { ...process.env };
delete childEnv.CLAUDECODE;
```

That was incomplete and only handled one of the two variables.

---

## Environment

| Component | Value |
|-----------|-------|
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.13.0 |
| node execPath | `C:\Program Files\nodejs\node.exe` |
| claude location | `C:\Users\emily\AppData\Roaming\npm\claude.cmd` |
| cli.js location | `C:\Users\emily\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js` |

### The `.cmd` shim contents

```batch
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
```

The shim just calls `node cli.js %*`. The correct fix is to bypass the shim and spawn `node` directly with `cli.js`.

---

## Fix Implemented

### `resolveClaudeBinary()`

`src/runner/index.ts` now resolves the Windows shim and returns:

```ts
{ command: process.execPath, prefixArgs: [cliJs] }
```

so Orca spawns:

```text
node <absolute-cli.js> ...
```

instead of spawning `claude` directly.

The resolver now also:

- uses `where claude` to locate the shim
- parses the shim to extract the `cli.js` path
- resolves explicit shim paths such as `claude.cmd` or `C:\...\claude.cmd`
- caches per requested command, instead of one global cached value

### Environment filtering

Orca now filters both nested-session vars case-insensitively:

- `CLAUDECODE`
- `CLAUDE_CODE_ENTRYPOINT`

### stdin handling

Orca now closes child stdin by default for one-shot sessions:

```ts
if (!options.allowFollowupPrompts) {
  proc.stdin?.end();
}
```

This prevents Claude `-p` sessions from hanging forever waiting on input.

---

## Verification

### Direct local reproductions

Verified on this machine:

- `spawn("claude", ["--version"])` -> `ENOENT`
- `spawn(process.execPath, [cliJs, "--version"])` -> success
- prompt invocation with nested env vars present -> Claude nested-session refusal
- prompt invocation with stdin left open -> hangs
- prompt invocation with stdin closed -> success

### Type/test verification

Passed:

- `npx tsc --noEmit`
- `npx vitest run test/integration.test.ts`

A regression test was added for Windows `.cmd` shim resolution.

### Real runner verification

A real `spawnSession()` smoke test succeeded after the fix:

```json
{
  "subtype": "success",
  "outputSummary": "ORCA_RUNNER_OK"
}
```

### Live Orca dispatch verification

The fix was verified through the real scheduler path by retrying a recent task that had previously failed with `spawn claude ENOENT`:

- Task: `EMI-151`
- New invocation: `478`

Observed in `orca.log`:

```text
[orca/runner] resolved claude -> node C:\Users\emily\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js
[orca/scheduler] dispatched task EMI-151 as invocation 478 ...
```

Observed in `logs/478.ndjson`:

- `type: "system", subtype: "init"`
- assistant messages
- tool calls
- tool results

This confirms the original failure mode (`spawn claude ENOENT`) is gone in the live Orca scheduler path.

---

## What Was Misleading During Investigation

An earlier theory blamed Git Bash path-with-spaces handling. That was not the core issue.

Clarifications:

- the Windows `claude.cmd` spawn failure was real and independent of Git Bash
- `process.execPath = C:\Program Files\nodejs\node.exe` worked fine once Orca spawned `node cli.js` directly
- the real Orca failures were:
  - spawning the shim directly
  - leaving stdin open for one-shot prompt sessions

Git Bash may have made some ad hoc tests noisier, but it was not the root cause of the scheduler failure.

---

## Remaining Separate Issues

The following still exist, but they are separate from the Claude Windows spawn incident:

- `DEP0190` warnings elsewhere in Orca from other `shell: true` call sites
- intermittent `git` / `gh` failures with exit code `3221225794` (`STATUS_DLL_INIT_FAILED`)
- task/worktree-level issues such as Claude encountering unstaged changes in the worktree during task execution

These can still break individual tasks, but they are not the original `spawn claude ENOENT` problem.

---

## Summary

The actual incident was:

1. Orca tried to spawn the Windows `claude` npm shim directly and got `ENOENT`
2. after bypassing the shim, Orca could still hang because stdin stayed open for one-shot prompt sessions
3. nested Claude session env vars also had to be stripped so child sessions could start

The fix was:

1. resolve Windows shim -> `node cli.js`
2. strip `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
3. close stdin by default for one-shot sessions

Result: verified working in a real Orca scheduler dispatch.
