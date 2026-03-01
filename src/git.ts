import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Windows STATUS_DLL_INIT_FAILED exit code (0xC0000142 as signed i32). */
const WIN_DLL_INIT_FAILED = 3221225794;

/**
 * Type for the error shape thrown by execFileSync.
 */
export interface ExecError {
  stderr?: string;
  stdout?: string;
  message?: string;
  code?: string;
  status?: number | null;
  signal?: string | null;
}

/**
 * Execute a git command synchronously and return trimmed stdout.
 * Uses execFileSync with argument array to avoid shell injection.
 * Throws with a descriptive message including stderr on failure.
 */
export function git(args: string[], options?: { cwd?: string }): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const execErr = err as ExecError;
    const stderr = execErr.stderr?.trim() ?? "";
    const parts = [`git command failed: git ${args.join(" ")}`];
    if (execErr.code) parts.push(`code: ${execErr.code}`);
    if (execErr.status != null) parts.push(`exit: ${execErr.status}`);
    if (execErr.signal) parts.push(`signal: ${execErr.signal}`);
    if (stderr) parts.push(stderr);
    if (!stderr && execErr.message) parts.push(execErr.message);
    if (options?.cwd) parts.push(`cwd: ${options.cwd}`);
    const error = new Error(parts.join("\n"));
    (error as any).status = execErr.status;
    (error as any).signal = execErr.signal;
    throw error;
  }
}

/**
 * Returns true if the error is a transient OS/infrastructure failure
 * that is worth retrying (not a git-level error like bad ref).
 *
 * NOTE: Windows STATUS_DLL_INIT_FAILED (0xC0000142) is NOT classified
 * as transient — it indicates system-level resource exhaustion that
 * won't resolve via retry and just wastes cycles spinning.
 *
 * Currently detects:
 * - Process killed by signal (e.g. SIGKILL, SIGTERM)
 */
export function isTransientGitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const execErr = err as ExecError;

  // Signal-killed process (OOM killer, etc.)
  if (execErr.signal) return true;
  if (err.message.includes("signal: SIG")) return true;

  return false;
}

/**
 * Tracks global consecutive transient failures across all git operations.
 * When this exceeds GLOBAL_PAUSE_THRESHOLD, gitWithRetry adds a long
 * cooldown to reduce system pressure from persistent OS-level errors.
 */
let globalTransientFailureCount = 0;
const GLOBAL_PAUSE_THRESHOLD = 6;
const GLOBAL_COOLDOWN_MS = 30_000;

/**
 * Synchronous sleep using Atomics.wait (does NOT busy-spin the CPU).
 * Falls back to a busy-wait only if SharedArrayBuffer is unavailable.
 */
function sleepSync(ms: number): void {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* fallback spin */
    }
  }
}

/**
 * Wraps git() with retry logic for transient errors.
 *
 * Retries up to `maxAttempts` times with backoff (2s, 4s) for errors
 * classified as transient by isTransientGitError().
 * Non-transient errors are thrown immediately.
 *
 * Tracks global transient failure count — if the system is in a persistent
 * failure state (e.g. Windows DLL init exhaustion), adds a longer cooldown
 * to reduce pressure instead of hammering the OS.
 */
export function gitWithRetry(
  args: string[],
  options?: { cwd?: string },
  maxAttempts = 3,
): string {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = git(args, options);
      // Success — reset global failure counter
      if (globalTransientFailureCount > 0) {
        console.warn(
          `[orca/git] global transient failure counter reset (was ${globalTransientFailureCount})`,
        );
        globalTransientFailureCount = 0;
      }
      return result;
    } catch (err: unknown) {
      if (!isTransientGitError(err) || attempt === maxAttempts) {
        throw err;
      }

      globalTransientFailureCount++;

      // If the system is in a persistent failure state, add a long cooldown
      if (globalTransientFailureCount >= GLOBAL_PAUSE_THRESHOLD) {
        console.warn(
          `[orca/git] ${globalTransientFailureCount} consecutive global transient failures — ` +
            `cooling down for ${GLOBAL_COOLDOWN_MS / 1000}s to reduce system pressure`,
        );
        sleepSync(GLOBAL_COOLDOWN_MS);
      } else {
        const waitMs = attempt * 2000;
        console.warn(
          `[orca/git] transient error on "git ${args.join(" ")}" ` +
            `(attempt ${attempt}/${maxAttempts}, global: ${globalTransientFailureCount}), ` +
            `retrying in ${waitMs}ms`,
        );
        sleepSync(waitMs);
      }
    }
  }
  // Unreachable, but satisfies TypeScript
  throw new Error("gitWithRetry: unreachable");
}

/**
 * Remove stale .git/index.lock files that are older than `maxAgeMs`.
 *
 * Git leaves index.lock behind when a process is killed mid-operation.
 * Best-effort: errors are logged but never thrown.
 */
export function cleanStaleLockFiles(repoPath: string, maxAgeMs = 60_000): void {
  const lockPath = join(repoPath, ".git", "index.lock");
  try {
    if (!existsSync(lockPath)) return;
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > maxAgeMs) {
      unlinkSync(lockPath);
      console.warn(`[orca/git] removed stale lock file: ${lockPath} (age: ${Math.round(age / 1000)}s)`);
    }
  } catch (err) {
    console.warn(`[orca/git] failed to clean lock file ${lockPath}: ${err}`);
  }
}
