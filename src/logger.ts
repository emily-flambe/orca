import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

function isJsonMode(): boolean {
  return process.env.LOG_FORMAT === "json";
}

/**
 * Extracts a fields object from the last argument if it is a plain object
 * (not an Error, not an Array, not null). Returns [remaining args, fields].
 */
function extractFields(
  args: unknown[],
): [unknown[], Record<string, unknown> | undefined] {
  if (args.length === 0) return [args, undefined];
  const last = args[args.length - 1];
  if (
    last !== null &&
    typeof last === "object" &&
    !Array.isArray(last) &&
    !(last instanceof Error)
  ) {
    return [args.slice(0, -1), last as Record<string, unknown>];
  }
  return [args, undefined];
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  module: string,
  baseFields?: Record<string, unknown>,
): Logger {
  const tag = `[orca/${module}]`;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()];
  }

  function formatHuman(level: LogLevel, args: unknown[]): string {
    const msg = args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return String(a);
        return JSON.stringify(a);
      })
      .join(" ");
    return `[${level.toUpperCase()}] ${tag} ${msg}`;
  }

  function emitJson(
    level: LogLevel,
    args: unknown[],
    extraFields?: Record<string, unknown>,
  ): string {
    const [msgArgs, inlineFields] = extractFields(args);
    const message = msgArgs
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return String(a);
        return JSON.stringify(a);
      })
      .join(" ");
    // Reserved keys are placed last so caller fields cannot clobber metadata.
    const entry: Record<string, unknown> = {
      ...baseFields,
      ...inlineFields,
      ...extraFields,
      timestamp: new Date().toISOString(),
      level,
      module: `orca/${module}`,
      message,
    };
    return JSON.stringify(entry);
  }

  return {
    debug(...args: unknown[]) {
      if (!shouldLog("debug")) return;
      if (isJsonMode()) {
        console.log(emitJson("debug", args));
      } else {
        console.log(formatHuman("debug", args));
      }
    },
    info(...args: unknown[]) {
      if (!shouldLog("info")) return;
      if (isJsonMode()) {
        console.log(emitJson("info", args));
      } else {
        console.log(formatHuman("info", args));
      }
    },
    warn(...args: unknown[]) {
      if (!shouldLog("warn")) return;
      if (isJsonMode()) {
        console.warn(emitJson("warn", args));
      } else {
        console.warn(formatHuman("warn", args));
      }
    },
    error(...args: unknown[]) {
      if (!shouldLog("error")) return;
      if (isJsonMode()) {
        console.error(emitJson("error", args));
      } else {
        console.error(formatHuman("error", args));
      }
    },
    child(fields: Record<string, unknown>): Logger {
      return createLogger(module, { ...baseFields, ...fields });
    },
  };
}

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
    return (origStdout as (...args: unknown[]) => boolean)(data, ...rest);
  } as typeof process.stdout.write;
  (patchedStdout as unknown as Record<symbol, boolean>)[PATCHED] = true;

  const patchedStderr = function (
    data: string | Uint8Array,
    ...rest: unknown[]
  ) {
    writeToFile(data);
    return (origStderr as (...args: unknown[]) => boolean)(data, ...rest);
  } as typeof process.stderr.write;
  (patchedStderr as unknown as Record<symbol, boolean>)[PATCHED] = true;

  process.stdout.write = patchedStdout;
  process.stderr.write = patchedStderr;
}
