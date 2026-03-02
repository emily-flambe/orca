import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

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
  /** Signal that killed the process (e.g. "SIGTERM"), or null if exited normally. */
  exitSignal: string | null;
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
  const signed = (Number(code) | 0); // Convert to signed 32-bit
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
function cleanStaleClaudeProjectDirs(worktreePath: string, repoPath?: string): void {
  try {
    const projectsDir = join(homedir(), ".claude", "projects");

    if (!repoPath) {
      process.stderr.write(
        `[orca/runner] warning: no repoPath provided, skipping stale Claude project dir cleanup\n`,
      );
      return;
    }

    const repoName = basename(repoPath);

    // Claude's key format: replace all : \ / with -
    // The parent dir of worktrees is the same as the parent dir of the repo.
    const repoParentPath = join(repoPath, "..");
    const parentKey = repoParentPath.replace(/[:\\/]/g, "-") + "-";

    // Match: <parentKey><repoName> (exact = main repo)
    // Match: <parentKey><repoName>-* (worktree dirs like orca-EMI-88)
    const mainRepoKey = parentKey + repoName;

    const entries = readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Match the main repo dir exactly OR any worktree dir (has - suffix)
      if (entry.name !== mainRepoKey && !entry.name.startsWith(mainRepoKey + "-")) continue;

      const fullPath = join(projectsDir, entry.name);
      rmSync(fullPath, { recursive: true, force: true });
      process.stderr.write(
        `[orca/runner] cleaned stale Claude project dir: ${entry.name}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[orca/runner] warning: failed to clean stale Claude project dirs: ${err}\n`,
    );
  }
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

  // Clean stale Claude Code project dirs for other worktrees of the same repo.
  // Claude Code identifies projects by path, but resolves git worktrees to the
  // first-seen path — causing sessions to run in the wrong directory. Removing
  // stale project dirs forces Claude to create a fresh one for this worktree.
  cleanStaleClaudeProjectDirs(options.worktreePath, options.repoPath);

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
        finalResult = handle.result;
      } else if (exitCode !== 0 || exitSignal) {
        // No result message and non-zero exit or signal -> process error.
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
          numTurns: null,
          exitCode,
          exitSignal: exitSignal?.toString() ?? null,
          outputSummary: parts.join(" "),
        };
        handle.result = finalResult;
      } else {
        // Process exited with code 0 but no result message.
        // Unusual, but not necessarily an error -- treat as success with
        // limited information.
        finalResult = {
          subtype: "success",
          costUsd: null,
          numTurns: null,
          exitCode: 0,
          exitSignal: null,
          outputSummary: "process exited cleanly with no result message",
        };
        handle.result = finalResult;
      }

      // Wait for the log stream to flush before resolving so callers
      // can rely on the log file existing on disk after `await handle.done`.
      logStream.end(() => resolve(finalResult));
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
          // Extract REVIEW_RESULT marker before truncation — the scheduler
          // parses it from outputSummary and it's often at the end of long reviews.
          const markerMatch = resultText.match(/REVIEW_RESULT:(APPROVED|CHANGES_REQUESTED)/);
          const truncated = resultText
            ? resultText.slice(0, 500)
            : "completed successfully";
          outputSummary = markerMatch && !truncated.includes(markerMatch[0])
            ? `${markerMatch[0]}\n\n${truncated}`
            : truncated;
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
          exitSignal: null, // Will be filled in on exit.
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
    // stderr -- forward to parent stderr AND write to log file
    // ------------------------------------------------------------------
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(
          `[orca/runner][stderr][inv-${options.invocationId}] ${text}`,
        );
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

    // Handle spawn errors (e.g. executable not found).
    proc.on("error", (err: Error) => {
      logStream.end();
      const result: SessionResult = {
        subtype: "process_error",
        costUsd: null,
        numTurns: null,
        exitCode: null,
        exitSignal: null,
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
