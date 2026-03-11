import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionResult } from "./index.js";

export interface ShellHandle {
  process: ChildProcess;
  invocationId: number;
  done: Promise<SessionResult>;
}

export interface SpawnShellOptions {
  /** Shell command to run. */
  command: string;
  /** Working directory for the command. */
  cwd: string;
  /** Invocation ID for log file naming. */
  invocationId: number;
  /** Project root directory (used to locate the logs/ dir). */
  projectRoot: string;
}

/**
 * Spawn a shell command as a child process and return a ShellHandle.
 *
 * On Windows, uses `cmd /c <command>`.
 * On Unix, uses `/bin/sh -c <command>`.
 *
 * stdout and stderr are written to `<projectRoot>/logs/<invocationId>.ndjson`
 * as NDJSON lines.
 *
 * The `done` promise resolves with a SessionResult when the process exits.
 */
export function spawnShellCommand(opts: SpawnShellOptions): ShellHandle {
  const { command, cwd, invocationId, projectRoot } = opts;

  // Ensure logs directory exists.
  const logsDir = join(projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `${invocationId}.ndjson`);
  const logStream = createWriteStream(logPath, { flags: "w" });

  // Choose shell based on platform.
  let spawnCmd: string;
  let spawnArgs: string[];
  if (process.platform === "win32") {
    spawnCmd = "cmd";
    spawnArgs = ["/c", command];
  } else {
    spawnCmd = "/bin/sh";
    spawnArgs = ["-c", command];
  }

  const proc = spawn(spawnCmd, spawnArgs, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect all output lines for outputSummary.
  const outputLines: string[] = [];

  // Process stdout line by line.
  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line: string) => {
    outputLines.push(line);
    const entry = JSON.stringify({ type: "text", text: line });
    logStream.write(entry + "\n");
  });

  // Process stderr line by line.
  const rlErr = createInterface({ input: proc.stderr! });
  rlErr.on("line", (line: string) => {
    const entry = JSON.stringify({ type: "error", text: line });
    logStream.write(entry + "\n");
  });

  // Track readline close states.
  let stdoutClosed = false;
  let stderrClosed = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let exitReceived = false;
  let resolved = false;

  const done = new Promise<SessionResult>((resolve, reject) => {
    proc.on("error", (err: Error) => {
      logStream.end();
      reject(err);
    });

    function tryResolve(): void {
      if (resolved || !exitReceived || !stdoutClosed || !stderrClosed) return;
      resolved = true;

      const code = exitCode;
      const success = code === 0;

      // Build output summary: last non-empty line or fallback.
      const lastLine = [...outputLines].reverse().find((l) => l.trim() !== "");
      const outputSummary =
        lastLine ??
        `exit code ${code !== null ? code : (exitSignal ?? "unknown")}`;

      const result: SessionResult = {
        subtype: success ? "success" : "error_during_execution",
        costUsd: null,
        numTurns: null,
        exitCode: code,
        exitSignal,
        outputSummary,
      };

      logStream.end(() => {
        resolve(result);
      });
    }

    rl.on("close", () => {
      stdoutClosed = true;
      tryResolve();
    });

    rlErr.on("close", () => {
      stderrClosed = true;
      tryResolve();
    });

    proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code;
      exitSignal = signal?.toString() ?? null;
      exitReceived = true;
      tryResolve();
    });
  });

  return {
    process: proc,
    invocationId,
    done,
  };
}
