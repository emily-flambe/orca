import {
  spawn,
  execFileSync,
  execSync,
  type ChildProcess,
} from "node:child_process";
import { createInterface } from "node:readline";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { EventEmitter } from "node:events";
import { writeHookConfig } from "../worktree/index.js";

// ---------------------------------------------------------------------------
// In-memory per-invocation log state for SSE streaming
// ---------------------------------------------------------------------------

interface InvocationLogState {
  buffer: string[]; // raw NDJSON lines (last 100)
  emitter: EventEmitter;
  done: boolean;
}

export const invocationLogs = new Map<number, InvocationLogState>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a completed Claude CLI session. */
export interface SessionResult {
  /** "success" | "error_max_turns" | "error_during_execution" | "process_error" | "rate_limited" */
  subtype: string;
  /** Total API cost in USD, if reported by the CLI. */
  costUsd: number | null;
  /** Total input tokens (input + cache creation + cache read). */
  inputTokens: number | null;
  /** Total output tokens. */
  outputTokens: number | null;
  /** Number of agentic turns, if reported by the CLI. */
  numTurns: number | null;
  /** Process exit code (null if killed by signal). */
  exitCode: number | null;
  /** Signal that killed the process (e.g. "SIGTERM"), or null if exited normally. */
  exitSignal: string | null;
  /** Human-readable summary of the result or error. */
  outputSummary: string;
  /** ISO timestamp when the rate limit resets, if subtype is "rate_limited". */
  rateLimitResetsAt?: string;
  /** True when --resume was used but the session ID was not found by the CLI. */
  isResumeNotFound: boolean;
}

/** Live handle to a running Claude CLI session. */
export interface SessionHandle {
  /** The underlying child process. */
  process: ChildProcess;
  /** Caller-supplied invocation identifier (used for log file naming). */
  invocationId: number;
  /** Session ID extracted from the stream-json `system/init` message, or null if not yet received. */
  sessionId: string | null;
  /** Parsed result once the CLI emits a `type: "result"` message, or null while still running. */
  result: SessionResult | null;
  /** Resolves when the process exits (normally or via kill). */
  done: Promise<SessionResult>;
}

/** MCP server configuration for per-session injection via --mcp-config. */
export type McpServerConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** Options accepted by {@link spawnSession}. */
export interface SpawnSessionOptions {
  /** The agent prompt to send via `-p`. */
  agentPrompt: string;
  /** Absolute path to the worktree the CLI should operate in. */
  worktreePath: string;
  /** Maximum agentic turns before the CLI stops. */
  maxTurns: number;
  /** Numeric invocation ID (used for log file naming). */
  invocationId: number;
  /** Absolute path to the project root (used to locate the `logs/` directory). */
  projectRoot: string;
  /** Path or name of the `claude` executable. Defaults to `"claude"`. */
  claudePath?: string;
  /** Extra arguments prepended before the built-in CLI flags (e.g. a script path when claudePath is `node`). */
  claudeArgs?: string[];
  /** Optional text appended to the system prompt via `--append-system-prompt`. */
  appendSystemPrompt?: string;
  /** Optional list of disallowed tool names via `--disallowedTools`. */
  disallowedTools?: string[];
  /** Session ID from a previous invocation to resume via `--resume`. */
  resumeSessionId?: string;
  /** Absolute path to the base git repository (used to clean stale Claude project dirs). */
  repoPath?: string;
  /** Model to use for this session (e.g. "opus", "sonnet", "haiku", or a full model ID). */
  model?: string;
  /** Optional MCP server configurations to inject per-session via --mcp-config. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Optional URL that Claude Code hooks should POST to for this session. */
  hookUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the `logs/` directory exists under the project root.
 * Uses `recursive: true` so it is a no-op if the directory already exists.
 */
function ensureLogsDir(projectRoot: string): string {
  const logsDir = join(projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

/**
 * Map of known Windows NTSTATUS exit codes to human-readable names.
 * These appear as unsigned 32-bit values from Node's child_process.
 */
const WINDOWS_EXIT_CODES: Record<number, string> = {
  3221225477: "STATUS_ACCESS_VIOLATION (0xC0000005)",
  3221225725: "STATUS_CONTROL_C_EXIT (0xC000013A)",
  3221225786: "STATUS_CONTROL_C_EXIT (0xC000013A)", // alternate
  3221225794: "STATUS_DLL_INIT_FAILED (0xC0000142)",
  3221225495: "STATUS_STACK_OVERFLOW (0xC00000FD)",
  3221226505: "STATUS_STACK_BUFFER_OVERRUN (0xC0000409)",
  3221225501: "STATUS_BAD_INITIAL_STACK (0xC0000103)",
  3221225559: "STATUS_GDI_HANDLE_LEAK (0xC0000117)",
};

/** Signed 32-bit equivalents (Node sometimes reports signed values). */
const WINDOWS_EXIT_CODES_SIGNED: Record<number, string> = {};
for (const [code, name] of Object.entries(WINDOWS_EXIT_CODES)) {
  const signed = Number(code) | 0; // Convert to signed 32-bit
  if (signed < 0) WINDOWS_EXIT_CODES_SIGNED[signed] = name;
}

/**
 * Translate a process exit code to a human-readable description.
 * Returns null if the code is not a recognized special value.
 */
function describeExitCode(code: number | null): string | null {
  if (code === null) return null;
  return WINDOWS_EXIT_CODES[code] ?? WINDOWS_EXIT_CODES_SIGNED[code] ?? null;
}

/**
 * Build the argument array for the `claude` CLI invocation.
 */
function buildArgs(opts: SpawnSessionOptions): string[] {
  const args: string[] = opts.claudeArgs ? [...opts.claudeArgs] : [];

  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }

  args.push(
    "-p",
    opts.agentPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(opts.maxTurns),
    "--dangerously-skip-permissions",
  );

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...opts.disallowedTools);
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  return args;
}

/**
 * Remove Claude Code project settings dirs for ALL worktrees and the main
 * repo of the same repository.
 *
 * Claude Code resolves projects by git repo identity (the common .git dir).
 * All worktrees share the same repo identity, so Claude maps them all to
 * whichever path it first saw — causing cross-contamination between tasks.
 *
 * The only reliable fix is to delete ALL Claude project dirs for this repo
 * (main + every worktree) before each spawn. This forces Claude to create
 * a fresh project dir keyed to the *current* worktree path.
 *
 * This deletes conversation transcripts (jsonl files) for the main repo too,
 * but that's acceptable — agent sessions are ephemeral.
 */
function cleanStaleClaudeProjectDirs(worktreePath: string): void {
  try {
    const projectsDir = join(homedir(), ".claude", "projects");

    // Compute Claude's key for this specific worktree path.
    // Claude replaces all : \ / with - to form the directory name.
    const worktreeKey = worktreePath
      .split("\\")
      .join("-")
      .split("/")
      .join("-")
      .split(":")
      .join("-");

    const fullPath = join(projectsDir, worktreeKey);
    if (!existsSync(fullPath)) return;

    rmSync(fullPath, { recursive: true, force: true });
    process.stderr.write(
      `[orca/runner] cleaned stale Claude project dir: ${worktreeKey}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[orca/runner] warning: failed to clean stale Claude project dirs: ${err}\n`,
    );
  }
}

/**
 * Kill a process and its entire child tree.
 *
 * On Windows, `proc.kill("SIGTERM")` only kills the direct Claude Code process.
 * Grandchild processes (e.g. wrangler dev spawning miniflare workers) survive
 * and can hold open file handles in the worktree directory, causing EPERM on
 * subsequent rmSync / git worktree remove attempts.
 *
 * `taskkill /PID <pid> /T /F` kills the entire process tree atomically.
 * On Unix, falls back to a direct SIGKILL on the child process (process group
 * kill requires detached:true which we don't use).
 */
function killProcessTree(pid: number, proc: ChildProcess): void {
  if (platform() === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // taskkill may fail if process already exited; fall back to direct kill
      proc.kill("SIGKILL");
    }
  } else {
    proc.kill("SIGKILL");
  }
}

/**
 * Expand `$VAR` and `${VAR}` references in a string using `process.env`.
 * Unset variables are replaced with an empty string.
 */
function expandEnvVars(value: string): string {
  return value
    .replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, name: string) => process.env[name] ?? "",
    );
}

/**
 * Return a copy of the mcpServers map with env var references expanded in
 * HTTP url/header values and stdio env values.
 */
function expandMcpEnvVars(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if ("type" in cfg && cfg.type === "http") {
      result[name] = {
        ...cfg,
        url: expandEnvVars(cfg.url),
        headers: cfg.headers
          ? Object.fromEntries(
              Object.entries(cfg.headers).map(([k, v]) => [
                k,
                expandEnvVars(v),
              ]),
            )
          : undefined,
      };
    } else if ("command" in cfg) {
      result[name] = {
        ...cfg,
        env: cfg.env
          ? Object.fromEntries(
              Object.entries(cfg.env).map(([k, v]) => [k, expandEnvVars(v)]),
            )
          : undefined,
      };
    } else {
      result[name] = cfg;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code CLI session as a child process and return a live handle.
 *
 * The handle exposes a `done` promise that resolves with a {@link SessionResult}
 * once the process exits (whether normally, due to an error, or after being
 * killed via {@link killSession}).
 *
 * Every line of stdout (stream-json) is tee'd to `<projectRoot>/logs/<invocationId>.ndjson`.
 *
 * @param options - Configuration for the CLI invocation.
 * @returns A {@link SessionHandle} for monitoring and controlling the session.
 */
/**
 * Resolve the claude CLI to a directly-spawnable [command, prefixArgs] pair.
 *
 * On Windows the `claude` command is an npm `.cmd` shim that just calls
 * `node …/cli.js %*`.  Spawning `.cmd` shims requires either `shell: true`
 * (broken by Node v24 DEP0190) or manual resolution.  We parse the shim,
 * extract the cli.js path, and spawn `node cli.js` directly — no shell needed.
 *
 * Cached after first call so we don't shell out to `where` on every dispatch.
 */
const resolvedClaudeCache = new Map<
  string,
  { command: string; prefixArgs: string[] }
>();

function isWindowsBatchShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}

function resolveClaudeCliFromShim(
  shimPath: string,
): { command: string; prefixArgs: string[] } | null {
  try {
    const shim = readFileSync(shimPath, "utf8");
    const match = shim.match(
      /"%dp0%\\([^"]*node_modules\\@anthropic-ai\\claude-code\\cli\.js)"/i,
    );
    if (!match) return null;

    const cliJs = resolve(dirname(shimPath), match[1]);
    if (!existsSync(cliJs)) return null;

    process.stderr.write(`[orca/runner] resolved claude -> node ${cliJs}\n`);
    return { command: process.execPath, prefixArgs: [cliJs] };
  } catch {
    return null;
  }
}

export function resolveClaudeBinary(requested: string): {
  command: string;
  prefixArgs: string[];
} {
  const cacheKey = platform() === "win32" ? requested.toLowerCase() : requested;
  const cached = resolvedClaudeCache.get(cacheKey);
  if (cached) return cached;

  if (platform() !== "win32") {
    const direct = { command: requested, prefixArgs: [] };
    resolvedClaudeCache.set(cacheKey, direct);
    return direct;
  }

  try {
    const explicitShimPath =
      requested === "claude" || requested === "claude.cmd"
        ? null
        : isWindowsBatchShim(requested)
          ? requested
          : null;

    if (explicitShimPath) {
      const resolved = resolveClaudeCliFromShim(explicitShimPath);
      if (resolved) {
        resolvedClaudeCache.set(cacheKey, resolved);
        return resolved;
      }
    }

    if (requested === "claude" || requested === "claude.cmd") {
      const whereOut = execFileSync("where", ["claude"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      const cmdPath = whereOut
        .split(/\r?\n/)
        .find((p) => p.toLowerCase().endsWith(".cmd"));
      if (cmdPath) {
        const resolved = resolveClaudeCliFromShim(cmdPath);
        if (resolved) {
          resolvedClaudeCache.set(cacheKey, resolved);
          return resolved;
        }
      }
    }
  } catch {
    // Fall through and try the requested command directly.
  }

  const direct = { command: requested, prefixArgs: [] };
  resolvedClaudeCache.set(cacheKey, direct);
  return direct;
}

export function spawnSession(options: SpawnSessionOptions): SessionHandle {
  const requested = options.claudePath ?? "claude";
  const { command: spawnCmd, prefixArgs } = resolveClaudeBinary(requested);

  // Ensure logs directory exists and open the log file for writing.
  const logsDir = ensureLogsDir(options.projectRoot);
  const logPath = join(logsDir, `${options.invocationId}.ndjson`);

  // Write MCP config temp file if mcpServers are provided.
  // Expand $VAR and ${VAR} references in url/header/env values before writing.
  let mcpConfigPath: string | null = null;
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    mcpConfigPath = join(logsDir, `${options.invocationId}-mcp.json`);
    const expandedServers = expandMcpEnvVars(options.mcpServers);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: expandedServers }, null, 2),
    );
  }

  const args = [...prefixArgs, ...buildArgs(options)];
  // Append MCP config args if a temp file was written.
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }

  const logStream = createWriteStream(logPath, { flags: "w" });

  // Create in-memory log state for SSE streaming.
  const logState: InvocationLogState = {
    buffer: [],
    emitter: new EventEmitter(),
    done: false,
  };
  // Unlimited listeners so multiple browser tabs don't trigger Node's warning.
  logState.emitter.setMaxListeners(0);
  invocationLogs.set(options.invocationId, logState);

  // Clean stale Claude Code project dirs for other worktrees of the same repo.
  // Claude Code identifies projects by path, but resolves git worktrees to the
  // first-seen path — causing sessions to run in the wrong directory. Removing
  // stale project dirs forces Claude to create a fresh one for this worktree.
  cleanStaleClaudeProjectDirs(options.worktreePath);

  // Write Claude Code hook config so the agent sends structured events back
  // to Orca via HTTP. Best-effort: failure does not block the session.
  if (options.hookUrl) {
    writeHookConfig(options.worktreePath, options.hookUrl);
  }

  // Strip env vars that should not leak into agent sessions:
  //  - Claude nesting-detection vars (prevent "already running" refusal)
  //  - Orca-internal secrets (Cloudflare tunnel, Inngest, Linear, GitHub webhook)
  //    These are Orca's own credentials. Repos that need deploy tokens should
  //    provide them via their own .env files (copied to worktrees automatically).
  const STRIP_VARS = new Set([
    "claudecode",
    "claude_code_entrypoint",
    // Orca's Cloudflare tunnel/deploy tokens — NOT for agent use
    "cloudflare_api_token",
    "cloudflare_account_id",
    "cloudflare_tunnel_id",
    // Orca's own config — agents don't need these
    "orca_linear_api_key",
    "orca_linear_webhook_secret",
    "orca_github_webhook_secret",
    "orca_tunnel_token",
    "inngest_event_key",
    "inngest_signing_key",
  ]);
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !STRIP_VARS.has(key.toLowerCase()),
    ),
  );

  const proc = spawn(spawnCmd, args, {
    cwd: options.worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    detached: false,
  });

  // Attach a no-op error handler on stdin to prevent unhandled 'error' events
  // (e.g. EPIPE) from crashing the server if the child closes its stdin end
  // while the process is still alive.
  proc.stdin?.on("error", () => {});

  // Claude one-shot `-p` sessions hang if stdin stays open; close it immediately.
  proc.stdin?.end();

  // Clean up the MCP config temp file if one was written.
  function cleanupMcpConfig(): void {
    if (mcpConfigPath) {
      try {
        rmSync(mcpConfigPath, { force: true });
      } catch {
        // ignore
      }
      mcpConfigPath = null;
    }
  }

  // Mutable handle state — mutated by the stream parser and exit handler.
  const handle: SessionHandle = {
    process: proc,
    invocationId: options.invocationId,
    sessionId: null,
    result: null,
    // Placeholder — replaced immediately below.
    done: undefined as unknown as Promise<SessionResult>,
  };

  // The `done` promise is resolved once both:
  //   1. The readline interface has closed (all buffered lines processed).
  //   2. The child process has exited.
  // This avoids the race where `exit` fires before readline flushes.
  handle.done = new Promise<SessionResult>((resolve) => {
    // Track whether we received a result message from the CLI.
    let resultReceived = false;

    // Track whether --resume failed because the session ID was not found.
    let resumeNotFound = false;

    // Track rate limiting detected from the ndjson stream.
    let rateLimitDetected = false;
    let rateLimitType: string | null = null;
    let rateLimitResetsAt: string | null = null;

    // Track completion of both the readline close and process exit.
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exitReceived = false;
    let rlClosed = false;
    let resolved = false;

    function tryResolve(): void {
      if (resolved || !exitReceived || !rlClosed) return;
      resolved = true;

      // Build the final result before closing the log stream.
      let finalResult: SessionResult;

      if (resultReceived && handle.result) {
        // Attach exit code and signal to the already-parsed result.
        handle.result.exitCode = exitCode;
        handle.result.exitSignal = exitSignal?.toString() ?? null;
        handle.result.isResumeNotFound = resumeNotFound;
        finalResult = handle.result;
      } else if (exitCode !== 0 || exitSignal) {
        // No result message and non-zero exit or signal -> process error.
        // Check first if a rate_limit_event was detected in the stream.
        if (rateLimitDetected) {
          const limitTypeStr = rateLimitType ?? "unknown";
          const resetsAtStr = rateLimitResetsAt ?? "unknown";
          finalResult = {
            subtype: "rate_limited",
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
            numTurns: null,
            exitCode,
            exitSignal: exitSignal?.toString() ?? null,
            outputSummary: `rate limited: ${limitTypeStr} quota exceeded, resets at ${resetsAtStr}`,
            rateLimitResetsAt: rateLimitResetsAt ?? undefined,
            isResumeNotFound: resumeNotFound,
          };
          handle.result = finalResult;
        } else {
          // Build a descriptive summary with as much info as possible.
          const parts: string[] = ["process exited"];
          if (exitSignal) {
            parts.push(`by signal ${exitSignal}`);
          }
          if (exitCode !== null) {
            const desc = describeExitCode(exitCode);
            parts.push(`with code ${exitCode}${desc ? ` (${desc})` : ""}`);
          } else if (!exitSignal) {
            parts.push("with code unknown");
          }

          finalResult = {
            subtype: "process_error",
            costUsd: null,
            inputTokens: null,
            outputTokens: null,
            numTurns: null,
            exitCode,
            exitSignal: exitSignal?.toString() ?? null,
            outputSummary: parts.join(" "),
            isResumeNotFound: resumeNotFound,
          };
          handle.result = finalResult;
        }
      } else {
        // Process exited with code 0 but no result message.
        // Unusual, but not necessarily an error -- treat as success with
        // limited information.
        finalResult = {
          subtype: "success",
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          numTurns: null,
          exitCode: 0,
          exitSignal: null,
          outputSummary: "process exited cleanly with no result message",
          isResumeNotFound: resumeNotFound,
        };
        handle.result = finalResult;
      }

      // Wait for the log stream to flush before resolving so callers
      // can rely on the log file existing on disk after `await handle.done`.
      logStream.end(() => {
        if (!logState.done) {
          logState.done = true;
          logState.emitter.emit("done");
        }
        // Only delete if this invocation's state is still in the map
        // (guards against ID reuse before the timer fires).
        setTimeout(() => {
          if (invocationLogs.get(options.invocationId) === logState) {
            invocationLogs.delete(options.invocationId);
          }
        }, 60_000).unref();
        cleanupMcpConfig();
        resolve(finalResult);
      });
    }

    // ------------------------------------------------------------------
    // Stream-json parser (stdout, line by line)
    // ------------------------------------------------------------------
    const rl = createInterface({ input: proc.stdout! });

    rl.on("line", (line: string) => {
      // Parse JSON defensively first so we can inject a timestamp.
      let msg: Record<string, unknown>;
      let logLine: string;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
        // Inject wall-clock timestamp so the log viewer can display it.
        if (!msg.timestamp) {
          msg.timestamp = new Date().toISOString();
        }
        logLine = JSON.stringify(msg);
      } catch {
        process.stderr.write(
          `[orca/runner] warning: non-JSON line from claude (invocation ${options.invocationId}): ${line.slice(0, 200)}\n`,
        );
        // Write the raw line and continue; nothing else to extract.
        logStream.write(line + "\n");
        logState.buffer.push(line);
        if (logState.buffer.length > 100) logState.buffer.shift();
        logState.emitter.emit("line", line);
        return;
      }

      // Tee the timestamped line to the log file.
      logStream.write(logLine + "\n");

      // Buffer and emit for SSE streaming.
      logState.buffer.push(logLine);
      if (logState.buffer.length > 100) logState.buffer.shift();
      logState.emitter.emit("line", logLine);

      const type = msg.type as string | undefined;

      // --- system / init -------------------------------------------------
      if (type === "system" && msg.subtype === "init") {
        if (typeof msg.session_id === "string") {
          handle.sessionId = msg.session_id;
        }
        return;
      }

      // --- rate_limit_event ----------------------------------------------
      if (type === "rate_limit_event") {
        if (msg.overageStatus === "rejected") {
          rateLimitDetected = true;
          rateLimitType =
            typeof msg.rateLimitType === "string" ? msg.rateLimitType : null;
          rateLimitResetsAt =
            typeof msg.resetsAt === "string" ? msg.resetsAt : null;
        }
        return;
      }

      // --- assistant (informational) -------------------------------------
      if (type === "assistant") {
        // Nothing to extract beyond logging (already tee'd above).
        return;
      }

      // --- result --------------------------------------------------------
      if (type === "result") {
        resultReceived = true;

        const subtype =
          typeof msg.subtype === "string" ? msg.subtype : "success";

        // The SDK uses `total_cost_usd`; older CLI versions used `cost_usd`.
        const costRaw = msg.total_cost_usd ?? msg.cost_usd ?? null;
        const costUsd = typeof costRaw === "number" ? costRaw : null;

        const numTurnsRaw = msg.num_turns ?? null;
        const numTurns = typeof numTurnsRaw === "number" ? numTurnsRaw : null;

        const usage = msg.usage as Record<string, unknown> | undefined;
        const inputTokens =
          usage && typeof usage === "object"
            ? (Number(usage.input_tokens) || 0) +
              (Number(usage.cache_creation_input_tokens) || 0) +
              (Number(usage.cache_read_input_tokens) || 0)
            : null;
        const outputTokens =
          usage && typeof usage === "object"
            ? Number(usage.output_tokens) || 0
            : null;

        // Build a human-readable summary.
        let outputSummary: string;
        if (subtype === "success") {
          const resultText = typeof msg.result === "string" ? msg.result : "";
          // Extract PR URL before truncation so Gate 2 fallback can find it.
          const prUrlMatch = resultText.match(
            /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/,
          );
          const truncated = resultText
            ? resultText.slice(0, 500)
            : "completed successfully";
          outputSummary = truncated;
          if (prUrlMatch && !outputSummary.includes(prUrlMatch[0])) {
            outputSummary = `${prUrlMatch[0]}\n\n${outputSummary}`;
          }
        } else if (subtype === "error_max_turns") {
          outputSummary = "max turns reached";
        } else if (subtype === "error_during_execution") {
          const errors = Array.isArray(msg.errors)
            ? (msg.errors as string[]).join("; ")
            : "execution error";
          outputSummary = errors;
        } else {
          outputSummary = `result subtype: ${subtype}`;
        }

        handle.result = {
          subtype,
          costUsd,
          inputTokens,
          outputTokens,
          numTurns,
          exitCode: null, // Will be filled in on exit.
          exitSignal: null, // Will be filled in on exit.
          outputSummary,
          isResumeNotFound: false, // Will be updated in tryResolve if stderr detected it.
        };
        return;
      }

      // Other message types (tool_progress, stream_event, etc.) are
      // already tee'd to the log file; nothing else to extract.
    });

    rl.on("close", () => {
      rlClosed = true;
      tryResolve();
    });

    // ------------------------------------------------------------------
    // stderr -- forward to parent stderr AND write to log file
    // ------------------------------------------------------------------
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(
          `[orca/runner][stderr][inv-${options.invocationId}] ${text}`,
        );
        if (
          options.resumeSessionId &&
          text.includes("No conversation found with session ID")
        ) {
          resumeNotFound = true;
        }
        // Write stderr to the log file as a structured JSON line so it's
        // preserved for post-mortem analysis.
        const stderrEntry = JSON.stringify({
          type: "stderr",
          timestamp: new Date().toISOString(),
          text: text.trimEnd(),
        });
        logStream.write(stderrEntry + "\n");
      });
    }

    // ------------------------------------------------------------------
    // Process exit handler
    // ------------------------------------------------------------------
    proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal;
      exitReceived = true;

      // Log exit details to the log file for post-mortem analysis.
      const exitEntry = JSON.stringify({
        type: "process_exit",
        timestamp: new Date().toISOString(),
        code,
        signal: signal?.toString() ?? null,
        codeDescription: code !== null ? describeExitCode(code) : null,
      });
      logStream.write(exitEntry + "\n");

      tryResolve();

      // Safety timeout: if readline hasn't closed within 10 seconds of
      // process exit, force it closed. This prevents handle.done from
      // hanging forever on Windows edge cases where the readline "close"
      // event never fires after the child process exits.
      if (!rlClosed) {
        const safetyTimer = setTimeout(() => {
          if (!rlClosed) {
            process.stderr.write(
              `[orca/runner] warning: readline did not close within 10s of exit ` +
                `for invocation ${options.invocationId}, forcing resolution\n`,
            );
            rlClosed = true;
            rl.close();
            tryResolve();
          }
        }, 10_000);
        // Don't let this timer keep the process alive.
        safetyTimer.unref();
      }
    });

    // Handle write errors on the log stream (e.g. disk full). Mark done so
    // SSE clients are not left hanging waiting for an event that never arrives.
    logStream.on("error", (err: Error) => {
      process.stderr.write(
        `[orca/runner] warning: log stream error for invocation ${options.invocationId}: ${err.message}\n`,
      );
      if (!logState.done) {
        logState.done = true;
        logState.emitter.emit("done");
        setTimeout(() => {
          if (invocationLogs.get(options.invocationId) === logState) {
            invocationLogs.delete(options.invocationId);
          }
        }, 60_000).unref();
      }
    });

    // Handle spawn errors (e.g. executable not found).
    proc.on("error", (err: Error) => {
      const result: SessionResult = {
        subtype: "process_error",
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        numTurns: null,
        exitCode: null,
        exitSignal: null,
        outputSummary: `spawn error: ${err.message}`,
        isResumeNotFound: resumeNotFound,
      };
      handle.result = result;
      logStream.end(() => {
        if (!logState.done) {
          logState.done = true;
          logState.emitter.emit("done");
        }
        setTimeout(() => {
          if (invocationLogs.get(options.invocationId) === logState) {
            invocationLogs.delete(options.invocationId);
          }
        }, 60_000).unref();
        cleanupMcpConfig();
        resolve(result);
      });
    });
  });

  return handle;
}

/**
 * Kill a running Claude CLI session.
 *
 * Sends SIGTERM first, then waits up to 5 seconds for the process to exit.
 * If still running after the grace period, sends SIGKILL.
 *
 * The returned promise resolves once the process has actually exited (i.e.
 * once `handle.done` resolves).
 *
 * @param handle - The session handle returned by {@link spawnSession}.
 * @returns The final {@link SessionResult}.
 */
export async function killSession(
  handle: SessionHandle,
): Promise<SessionResult> {
  const proc = handle.process;

  // If already exited, just return the result.
  if (proc.exitCode !== null || proc.killed) {
    return handle.done;
  }

  if (platform() === "win32") {
    // On Windows, kill the entire process tree immediately using taskkill /T /F.
    // proc.kill("SIGTERM") only kills the direct Claude Code process; grandchild
    // processes (e.g. wrangler dev spawning miniflare workers) survive and hold
    // open file handles in the worktree directory, causing EPERM on cleanup.
    if (proc.pid !== undefined) {
      killProcessTree(proc.pid, proc);
    } else {
      proc.kill("SIGKILL");
    }
    return handle.done;
  }

  // On Unix: send SIGTERM first, then escalate to SIGKILL after 5 seconds.
  proc.kill("SIGTERM");

  // Race: either the process exits within 5 s, or we escalate to SIGKILL.
  let killTimerId: ReturnType<typeof setTimeout> | undefined;
  const killTimer = new Promise<"timeout">((resolve) => {
    killTimerId = setTimeout(() => resolve("timeout"), 5_000);
  });

  const raceResult = await Promise.race([
    handle.done.then(() => "exited" as const),
    killTimer,
  ]);

  if (raceResult === "timeout") {
    // Still alive after 5 seconds -- force kill.
    proc.kill("SIGKILL");
  } else {
    // Process exited before timeout -- clear the pending timer so it
    // does not keep the event loop alive unnecessarily.
    clearTimeout(killTimerId);
  }

  return handle.done;
}
