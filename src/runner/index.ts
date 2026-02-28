import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a completed Claude CLI session. */
export interface SessionResult {
  /** "success" | "error_max_turns" | "error_during_execution" | "process_error" */
  subtype: string;
  /** Total API cost in USD, if reported by the CLI. */
  costUsd: number | null;
  /** Number of agentic turns, if reported by the CLI. */
  numTurns: number | null;
  /** Process exit code (null if killed by signal). */
  exitCode: number | null;
  /** Human-readable summary of the result or error. */
  outputSummary: string;
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
  /** Optional text appended to the system prompt via `--append-system-prompt`. */
  appendSystemPrompt?: string;
  /** Optional list of disallowed tool names via `--disallowedTools`. */
  disallowedTools?: string[];
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
 * Build the argument array for the `claude` CLI invocation.
 */
function buildArgs(opts: SpawnSessionOptions): string[] {
  const args: string[] = [
    "-p",
    opts.agentPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(opts.maxTurns),
    "--dangerously-skip-permissions",
  ];

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...opts.disallowedTools);
  }

  return args;
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
export function spawnSession(options: SpawnSessionOptions): SessionHandle {
  const claudePath = options.claudePath ?? "claude";
  const args = buildArgs(options);

  // Ensure logs directory exists and open the log file for writing.
  const logsDir = ensureLogsDir(options.projectRoot);
  const logPath = join(logsDir, `${options.invocationId}.ndjson`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  // Spawn the claude CLI process.
  // Strip CLAUDECODE env var so child sessions don't think they're nested.
  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;

  const proc = spawn(claudePath, args, {
    cwd: options.worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    // Prevent the child from keeping the parent alive after we're done.
    detached: false,
  });

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

    // Track completion of both the readline close and process exit.
    let exitCode: number | null = null;
    let exitReceived = false;
    let rlClosed = false;

    function tryResolve(): void {
      if (!exitReceived || !rlClosed) return;

      // Close the log stream now that all lines have been written.
      logStream.end();

      if (resultReceived && handle.result) {
        // Attach exit code to the already-parsed result.
        handle.result.exitCode = exitCode;
        resolve(handle.result);
      } else if (exitCode !== 0) {
        // No result message and non-zero exit -> process error.
        const result: SessionResult = {
          subtype: "process_error",
          costUsd: null,
          numTurns: null,
          exitCode,
          outputSummary: `process exited with code ${exitCode ?? "unknown"}`,
        };
        handle.result = result;
        resolve(result);
      } else {
        // Process exited with code 0 but no result message.
        // Unusual, but not necessarily an error -- treat as success with
        // limited information.
        const result: SessionResult = {
          subtype: "success",
          costUsd: null,
          numTurns: null,
          exitCode: 0,
          outputSummary: "process exited cleanly with no result message",
        };
        handle.result = result;
        resolve(result);
      }
    }

    // ------------------------------------------------------------------
    // Stream-json parser (stdout, line by line)
    // ------------------------------------------------------------------
    const rl = createInterface({ input: proc.stdout! });

    rl.on("line", (line: string) => {
      // Tee every raw line to the log file.
      logStream.write(line + "\n");

      // Parse JSON defensively.
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stderr.write(
          `[orca/runner] warning: non-JSON line from claude (invocation ${options.invocationId}): ${line.slice(0, 200)}\n`,
        );
        return;
      }

      const type = msg.type as string | undefined;

      // --- system / init -------------------------------------------------
      if (type === "system" && msg.subtype === "init") {
        if (typeof msg.session_id === "string") {
          handle.sessionId = msg.session_id;
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
        const costUsd =
          typeof costRaw === "number" ? costRaw : null;

        const numTurnsRaw = msg.num_turns ?? null;
        const numTurns =
          typeof numTurnsRaw === "number" ? numTurnsRaw : null;

        // Build a human-readable summary.
        let outputSummary: string;
        if (subtype === "success") {
          const resultText =
            typeof msg.result === "string" ? msg.result : "";
          outputSummary = resultText || "completed successfully";
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
          numTurns,
          exitCode: null, // Will be filled in on exit.
          outputSummary,
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
    // stderr -- forward to parent stderr for visibility
    // ------------------------------------------------------------------
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(
          `[orca/runner][stderr][inv-${options.invocationId}] ${chunk.toString()}`,
        );
      });
    }

    // ------------------------------------------------------------------
    // Process exit handler
    // ------------------------------------------------------------------
    proc.on("exit", (code: number | null, _signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitReceived = true;
      tryResolve();
    });

    // Handle spawn errors (e.g. executable not found).
    proc.on("error", (err: Error) => {
      logStream.end();
      const result: SessionResult = {
        subtype: "process_error",
        costUsd: null,
        numTurns: null,
        exitCode: null,
        outputSummary: `spawn error: ${err.message}`,
      };
      handle.result = result;
      resolve(result);
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
export async function killSession(handle: SessionHandle): Promise<SessionResult> {
  const proc = handle.process;

  // If already exited, just return the result.
  if (proc.exitCode !== null || proc.killed) {
    return handle.done;
  }

  // Send SIGTERM.
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
