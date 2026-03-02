import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

export interface FileLoggerConfig {
  logPath: string;
  maxSizeBytes: number;
}

/** Unique symbol used to detect if process.stdout.write is already our patch. */
const PATCHED = Symbol("orca-logger-patched");

function maybeRotate(logPath: string, maxSizeBytes: number): void {
  try {
    if (existsSync(logPath) && statSync(logPath).size >= maxSizeBytes) {
      const backup = logPath + ".1";
      try {
        if (existsSync(backup)) {
          // Remove old backup before renaming (required on Windows)
          unlinkSync(backup);
        }
      } catch {
        // Non-fatal — if we can't remove the old backup, renameSync may still
        // succeed on POSIX (overwrites), or fail on Windows; either way
        // the main write will still proceed below.
      }
      renameSync(logPath, backup);
    }
  } catch {
    // Rotation errors are non-fatal
  }
}

/** Prefix each non-empty line with an ISO timestamp. */
function addTimestamps(text: string): string {
  const ts = new Date().toISOString();
  const lines = text.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // The final empty segment after a trailing newline gets no prefix.
    if (line === "" && i === lines.length - 1) {
      result.push("");
    } else if (line === "") {
      // Blank lines within the text: preserve as-is.
      result.push("");
    } else {
      result.push(`${ts} ${line}`);
    }
  }
  return result.join("\n");
}

/**
 * Initialise file logging. Monkey-patches process.stdout.write and
 * process.stderr.write to tee output to logPath with size-based rotation.
 *
 * Idempotent: subsequent calls are no-ops if the current process.stdout.write
 * is already the patched version (detected via a Symbol marker).
 */
export function initFileLogger(config: FileLoggerConfig): void {
  // Guard against double-init. The PATCHED symbol is set on the patched
  // function itself, so if tests restore the original write (which does NOT
  // have the symbol), this guard resets automatically between tests.
  if ((process.stdout.write as unknown as Record<symbol, unknown>)[PATCHED]) {
    return;
  }

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  function writeToFile(data: string | Uint8Array): void {
    try {
      maybeRotate(config.logPath, config.maxSizeBytes);
      const text =
        typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      appendFileSync(config.logPath, addTimestamps(text));
    } catch {
      // File write errors are non-fatal
    }
  }

  const patchedStdout = function (
    data: string | Uint8Array,
    ...rest: unknown[]
  ) {
    writeToFile(data);
    return (origStdout as Function)(data, ...rest);
  } as typeof process.stdout.write;
  (patchedStdout as unknown as Record<symbol, boolean>)[PATCHED] = true;

  const patchedStderr = function (
    data: string | Uint8Array,
    ...rest: unknown[]
  ) {
    writeToFile(data);
    return (origStderr as Function)(data, ...rest);
  } as typeof process.stderr.write;
  (patchedStderr as unknown as Record<symbol, boolean>)[PATCHED] = true;

  process.stdout.write = patchedStdout;
  process.stderr.write = patchedStderr;
}
