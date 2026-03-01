// ---------------------------------------------------------------------------
// Centralized logger with file rotation
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let logFilePath: string = "./orca.log";
let maxSizeBytes: number = 10 * 1024 * 1024; // 10 MB
let initialized = false;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the file logger. Call once at startup (in `orca start`).
 * If never called, createLogger() still works but only writes to console.
 */
export function initLogger(opts: { logPath?: string; maxSizeMb?: number }): void {
  if (opts.logPath !== undefined) {
    logFilePath = opts.logPath;
  }
  if (opts.maxSizeMb !== undefined) {
    maxSizeBytes = Math.max(opts.maxSizeMb, 1) * 1024 * 1024;
  }

  // Ensure parent directory exists
  const dir = dirname(logFilePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }

  initialized = true;
}

// ---------------------------------------------------------------------------
// File rotation
// ---------------------------------------------------------------------------

function rotateIfNeeded(): void {
  try {
    if (!existsSync(logFilePath)) return;
    const stats = statSync(logFilePath);
    if (stats.size < maxSizeBytes) return;

    const rotatedPath = logFilePath + ".1";

    // Delete old rotated file if it exists
    if (existsSync(rotatedPath)) {
      unlinkSync(rotatedPath);
    }

    // Rename current log to .1
    renameSync(logFilePath, rotatedPath);
  } catch {
    // Best-effort rotation — don't crash the process over log rotation
  }
}

// ---------------------------------------------------------------------------
// File writing
// ---------------------------------------------------------------------------

function writeToFile(level: string, prefix: string, message: string): void {
  if (!initialized) return;

  try {
    rotateIfNeeded();
    const timestamp = new Date().toISOString();
    const sanitized = message.replace(/\n/g, "\\n");
    const line = `${timestamp} [${level}] ${prefix} ${sanitized}\n`;
    appendFileSync(logFilePath, line);
  } catch {
    // Best-effort file logging — never crash the process
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a logger instance for a module. The module name is used as the
 * `[orca/<module>]` prefix in all output.
 *
 * If {@link initLogger} has not been called, the logger still works but
 * only writes to console (no file output). This supports one-shot CLI
 * commands like `orca add` and `orca status`.
 */
export function createLogger(module: string): Logger {
  const prefix = `[orca/${module}]`;

  return {
    info(message: string): void {
      console.log(`${prefix} ${message}`);
      writeToFile("INFO", prefix, message);
    },
    warn(message: string): void {
      console.warn(`${prefix} ${message}`);
      writeToFile("WARN", prefix, message);
    },
    error(message: string): void {
      console.error(`${prefix} ${message}`);
      writeToFile("ERROR", prefix, message);
    },
  };
}
