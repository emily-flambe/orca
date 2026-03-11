import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { EventEmitter } from "node:events";

import { invocationLogs } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a completed shell command. */
export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Live handle to a running shell command. */
export interface ShellHandle {
  process: ChildProcess;
  invocationId: number;
  done: Promise<ShellResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUFFER_BYTES = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureLogsDir(projectRoot: string): string {
  const logsDir = join(projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

/**
 * Concatenate raw Buffers and decode to a UTF-8 string, enforcing a byte cap.
 *
 * Two problems are addressed:
 *
 * 1. Incomplete tail sequence: OS chunks that split a multi-byte UTF-8
 *    sequence at the very end of the collected bytes would cause
 *    Buffer.toString() to insert U+FFFD replacement characters.  The tail
 *    scan trims any such incomplete sequence.
 *
 * 2. Invalid mid-stream sequences: When chunk boundaries split a multi-byte
 *    sequence and only some bytes are stored (due to the cap), the resulting
 *    raw buffer may contain isolated start or continuation bytes that are
 *    invalid UTF-8.  Buffer.toString() replaces each invalid byte with
 *    U+FFFD (3 UTF-8 bytes), silently inflating the decoded string beyond
 *    maxBytes.  After decoding we re-enforce the cap on the string's UTF-8
 *    byte length.
 */
function concatChunksToString(chunks: Buffer[], maxBytes: number): string {
  const buf = Buffer.concat(chunks);
  // Scan the last 3 bytes for a multi-byte sequence start byte whose sequence
  // extends beyond the buffer end.
  const end = buf.length;
  let trimEnd = end;
  for (let i = Math.max(0, end - 3); i < end; i++) {
    const b = buf[i]!;
    if ((b & 0x80) === 0) continue; // ASCII — always complete
    // Skip continuation bytes; only act on start bytes.
    if ((b & 0xc0) === 0x80) continue;
    let seqLen: number;
    if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    else continue; // Unrecognised high byte — leave to toString()
    if (i + seqLen > end) {
      // Incomplete sequence at tail — trim it.
      trimEnd = i;
      break;
    }
  }

  const str = buf.subarray(0, trimEnd).toString();

  // Second cap: replacement characters from invalid mid-stream bytes may
  // inflate the re-encoded UTF-8 byte length above maxBytes.  Enforce the
  // cap on the decoded string.
  if (Buffer.byteLength(str, "utf8") <= maxBytes) {
    return str;
  }
  // Re-encode and find the last UTF-8 sequence boundary at or before maxBytes.
  const enc = Buffer.from(str, "utf8");
  let cut = maxBytes;
  while (cut > 0 && (enc[cut]! & 0xc0) === 0x80) cut--;
  return enc.subarray(0, cut).toString("utf8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn an arbitrary shell command and return a live handle.
 *
 * stdout and stderr are captured into string buffers (capped at 1 MB each)
 * and also written as NDJSON lines to `<projectRoot>/logs/<invocationId>.ndjson`
 * for SSE streaming compatibility.
 *
 * @param command     - The shell command string to execute.
 * @param invocationId - Numeric invocation ID (used for log file naming).
 * @param projectRoot  - Absolute path to the project root (for the `logs/` dir).
 * @param timeoutMs    - Optional hard timeout in milliseconds. Undefined = no limit.
 * @returns A {@link ShellHandle} for monitoring and optionally killing the command.
 */
export function spawnShellCommand(
  command: string,
  invocationId: number,
  projectRoot: string,
  timeoutMs?: number,
): ShellHandle {
  const logsDir = ensureLogsDir(projectRoot);
  const logPath = join(logsDir, `${invocationId}.ndjson`);
  const logStream = createWriteStream(logPath, { flags: "w" });

  // Register in-memory log state for SSE streaming (same shape as index.ts).
  const logState = {
    buffer: [] as string[],
    emitter: new EventEmitter(),
    done: false,
  };
  logState.emitter.setMaxListeners(0);
  // Only register if this invocationId is not already tracked; duplicate IDs
  // are unexpected in normal operation (sequential DB IDs) but this guard
  // prevents silently orphaning SSE clients subscribed to an earlier entry.
  if (!invocationLogs.has(invocationId)) {
    invocationLogs.set(invocationId, logState);
  }

  function writeLine(line: string): void {
    logStream.write(line + "\n");
    logState.buffer.push(line);
    if (logState.buffer.length > 100) logState.buffer.shift();
    logState.emitter.emit("line", line);
  }

  const proc = spawn(command, [], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Create a new process group on Unix so we can kill the entire tree
    // (shell + any child processes it spawns) with process.kill(-pid, signal).
    // Without this, killing the shell leaves child processes alive holding the
    // stdout/stderr pipe open, which prevents the 'close' event from firing.
    ...(platform() !== "win32" ? { detached: true } : {}),
  });

  // Mutable capture state.
  // Collect raw Buffers and concatenate at the end to avoid UTF-8 replacement
  // character inflation that occurs when calling chunk.toString() on buffers
  // that split multi-byte sequences at chunk boundaries.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Placeholder — replaced immediately below.
  const handle: ShellHandle = {
    process: proc,
    invocationId,
    done: undefined as unknown as Promise<ShellResult>,
  };

  handle.done = new Promise<ShellResult>((resolve) => {
    // ------------------------------------------------------------------
    // stdout — collect raw Buffers; convert to string once on close
    // ------------------------------------------------------------------
    proc.stdout!.on("data", (chunk: Buffer) => {
      // Cap at 1 MB (byte-aware). Accumulate raw Buffers so multi-byte
      // UTF-8 sequences split across chunks are decoded correctly in one
      // pass via Buffer.concat().toString() at the end.
      const remaining = MAX_BUFFER_BYTES - stdoutBytes;
      if (remaining > 0) {
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          // Find a valid UTF-8 start byte at or before the byte cap so we
          // don't cut a multi-byte sequence in half.
          let cut = remaining;
          while (cut > 0 && (chunk[cut]! & 0xc0) === 0x80) cut--;
          if (cut > 0) {
            stdoutChunks.push(chunk.subarray(0, cut));
            stdoutBytes += cut;
          }
        }
      }

      const entry = JSON.stringify({
        type: "stdout",
        timestamp: new Date().toISOString(),
        text: chunk.toString(),
      });
      writeLine(entry);
    });

    // ------------------------------------------------------------------
    // stderr — same pattern as stdout
    // ------------------------------------------------------------------
    proc.stderr!.on("data", (chunk: Buffer) => {
      const remaining = MAX_BUFFER_BYTES - stderrBytes;
      if (remaining > 0) {
        if (chunk.length <= remaining) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          let cut = remaining;
          while (cut > 0 && (chunk[cut]! & 0xc0) === 0x80) cut--;
          if (cut > 0) {
            stderrChunks.push(chunk.subarray(0, cut));
            stderrBytes += cut;
          }
        }
      }

      const entry = JSON.stringify({
        type: "stderr",
        timestamp: new Date().toISOString(),
        text: chunk.toString(),
      });
      writeLine(entry);
    });

    // ------------------------------------------------------------------
    // Timeout
    // ------------------------------------------------------------------
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        process.stderr.write(
          `[orca/shell] timeout after ${timeoutMs}ms for invocation ${invocationId}, killing\n`,
        );
        killShellProcess(handle);
      }, timeoutMs);
      timeoutHandle.unref();
    }

    // ------------------------------------------------------------------
    // Process exit — use 'close' (not 'exit') so all buffered stdout/stderr
    // data has been delivered before we read stdoutBuf/stderrBuf.
    // ------------------------------------------------------------------
    proc.on("close", (code: number | null) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }

      const exitEntry = JSON.stringify({
        type: "process_exit",
        timestamp: new Date().toISOString(),
        code,
        signal: null,
      });
      writeLine(exitEntry);

      const result: ShellResult = {
        exitCode: code,
        stdout: concatChunksToString(stdoutChunks, MAX_BUFFER_BYTES),
        stderr: concatChunksToString(stderrChunks, MAX_BUFFER_BYTES),
        timedOut,
      };

      logStream.end(() => {
        if (!logState.done) {
          logState.done = true;
          logState.emitter.emit("done");
        }
        setTimeout(() => {
          if (invocationLogs.get(invocationId) === logState) {
            invocationLogs.delete(invocationId);
          }
        }, 60_000).unref();
        resolve(result);
      });
    });

    // ------------------------------------------------------------------
    // Spawn errors (executable not found, etc.)
    // ------------------------------------------------------------------
    proc.on("error", (err: Error) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      process.stderr.write(
        `[orca/shell] spawn error for invocation ${invocationId}: ${err.message}\n`,
      );
      const result: ShellResult = {
        exitCode: null,
        stdout: concatChunksToString(stdoutChunks, MAX_BUFFER_BYTES),
        stderr: concatChunksToString(stderrChunks, MAX_BUFFER_BYTES),
        timedOut,
      };
      logStream.end(() => {
        if (!logState.done) {
          logState.done = true;
          logState.emitter.emit("done");
        }
        setTimeout(() => {
          if (invocationLogs.get(invocationId) === logState) {
            invocationLogs.delete(invocationId);
          }
        }, 60_000).unref();
        resolve(result);
      });
    });

    // Log stream errors — don't hang SSE clients or the done promise.
    logStream.on("error", (err: Error) => {
      process.stderr.write(
        `[orca/shell] log stream error for invocation ${invocationId}: ${err.message}\n`,
      );
      if (!logState.done) {
        logState.done = true;
        logState.emitter.emit("done");
        setTimeout(() => {
          if (invocationLogs.get(invocationId) === logState) {
            invocationLogs.delete(invocationId);
          }
        }, 60_000).unref();
        // Resolve the done promise so the scheduler is not left hanging.
        resolve({
          exitCode: proc.exitCode,
          stdout: concatChunksToString(stdoutChunks, MAX_BUFFER_BYTES),
          stderr: concatChunksToString(stderrChunks, MAX_BUFFER_BYTES),
          timedOut,
        });
      }
    });
  });

  return handle;
}

/**
 * Kill a running shell command.
 *
 * On Windows: uses `taskkill /PID <pid> /T /F` to kill the entire process tree.
 * On Unix: sends SIGTERM, waits 5 seconds, then escalates to SIGKILL.
 *
 * @param handle - The shell handle returned by {@link spawnShellCommand}.
 * @returns The final {@link ShellResult} (same as `handle.done`).
 */
export async function killShellProcess(
  handle: ShellHandle,
): Promise<ShellResult> {
  const proc = handle.process;

  if (proc.exitCode !== null || proc.killed) {
    return handle.done;
  }

  if (platform() === "win32") {
    if (proc.pid !== undefined) {
      try {
        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" });
      } catch {
        proc.kill("SIGKILL");
      }
    } else {
      proc.kill("SIGKILL");
    }
    return handle.done;
  }

  // Unix: SIGTERM → wait 5s → SIGKILL
  // Send signal to the entire process group (negative PID) so child processes
  // spawned by the shell also receive the signal and release their pipe handles.
  // Falls back to proc.kill() if the PID is unavailable.
  const killGroup = (signal: NodeJS.Signals): void => {
    if (proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        proc.kill(signal);
      }
    } else {
      proc.kill(signal);
    }
  };

  killGroup("SIGTERM");

  let killTimerId: ReturnType<typeof setTimeout> | undefined;
  const killTimer = new Promise<"timeout">((resolve) => {
    killTimerId = setTimeout(() => resolve("timeout"), 5_000);
    killTimerId.unref();
  });

  const raceResult = await Promise.race([
    handle.done.then(() => "exited" as const),
    killTimer,
  ]);

  if (raceResult === "timeout") {
    killGroup("SIGKILL");
  } else {
    clearTimeout(killTimerId);
  }

  return handle.done;
}
