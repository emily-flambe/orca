// ---------------------------------------------------------------------------
// Structured file logger with size-based rotation
// ---------------------------------------------------------------------------

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let logPath = "./logs/orca.log";
let maxSizeBytes = 10 * 1024 * 1024;
let initialized = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the file logger. Call once at startup with config values.
 * Must be called before any createLogger() output will write to files.
 */
export function initLogger(opts: {
  logPath?: string;
  maxSizeMb?: number;
}): void {
  if (opts.logPath !== undefined) {
    logPath = opts.logPath;
  }
  if (opts.maxSizeMb !== undefined) {
    // Floor at 1 KB to prevent rotation-on-every-write with zero/negative values
    maxSizeBytes = Math.max(opts.maxSizeMb * 1024 * 1024, 1024);
  }

  // Create parent directory if missing
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // Never crash the app due to log failure
  }

  initialized = true;
}

// ---------------------------------------------------------------------------
// File rotation
// ---------------------------------------------------------------------------

/**
 * Check if the log file exceeds maxSizeBytes. If so, rotate it to .1.
 */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(logPath)) return;
    const stats = statSync(logPath);
    if (stats.size >= maxSizeBytes) {
      renameSync(logPath, logPath + ".1");
    }
  } catch {
    // Never crash the app due to log failure
  }
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Write a formatted line to the log file.
 */
function writeToFile(line: string): void {
  if (!initialized) return;

  try {
    rotateIfNeeded();
    appendFileSync(logPath, line + "\n");
  } catch {
    // Never crash the app due to log failure
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Create a logger for a specific module.
 *
 * Console output preserves the existing format: `[orca/module] message`
 * File output adds timestamp + level: `2024-01-15T10:30:00.000Z INFO  [orca/module] message`
 */
export function createLogger(module: string): Logger {
  const prefix = `[orca/${module}]`;

  return {
    info(message: string): void {
      console.log(`${prefix} ${message}`);
      const safe = message.replace(/\n/g, "\\n");
      writeToFile(
        `${new Date().toISOString()} INFO  ${prefix} ${safe}`,
      );
    },

    warn(message: string): void {
      console.warn(`${prefix} ${message}`);
      const safe = message.replace(/\n/g, "\\n");
      writeToFile(
        `${new Date().toISOString()} WARN  ${prefix} ${safe}`,
      );
    },

    error(message: string): void {
      console.error(`${prefix} ${message}`);
      const safe = message.replace(/\n/g, "\\n");
      writeToFile(
        `${new Date().toISOString()} ERROR ${prefix} ${safe}`,
      );
    },
  };
}
