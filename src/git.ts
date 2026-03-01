import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Windows STATUS_DLL_INIT_FAILED exit code (0xC0000142 unsigned). */
const WIN_DLL_INIT_FAILED = 3221225794;
/** Signed 32-bit representation of the same exit code. */
const WIN_DLL_INIT_FAILED_SIGNED = -1073741502;

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
 * Detects:
 * - Process killed by signal (e.g. SIGKILL, SIGTERM)
 * - Windows STATUS_DLL_INIT_FAILED (0xC0000142) — resource exhaustion
 *   when too many processes spawn concurrently. Transient: resolves
 *   once system resources are freed.
 */
export function isTransientGitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const execErr = err as ExecError;

  // Windows DLL init failure — transient resource exhaustion
  // Check both unsigned and signed representations of 0xC0000142
  if (execErr.status === WIN_DLL_INIT_FAILED || execErr.status === WIN_DLL_INIT_FAILED_SIGNED) return true;

  // Signal-killed process (OOM killer, etc.)
  if (execErr.signal) return true;
  if (err.message.includes("signal: SIG")) return true;

  return false;
}

/**
 * Returns true if the error is specifically a Windows DLL init failure.
 * Used to apply longer backoffs than other transient errors.
 */
export function isDllInitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as ExecError).status;
  return status === WIN_DLL_INIT_FAILED || status === WIN_DLL_INIT_FAILED_SIGNED;
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
 * Retries up to `maxAttempts` times with backoff for errors classified
 * as transient by isTransientGitError(). Non-transient errors throw immediately.
 *
 * DLL init failures (0xC0000142) get longer backoffs (5s, 10s, 15s) because
 * the system needs time to reclaim resources. Other transient errors use
 * shorter backoffs (2s, 4s).
 *
 * Tracks global transient failure count — if the system is in a persistent
 * failure state, adds a longer cooldown to reduce pressure.
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
      const dllInit = isDllInitError(err);

      // If the system is in a persistent failure state, add a long cooldown
      if (globalTransientFailureCount >= GLOBAL_PAUSE_THRESHOLD) {
        console.warn(
          `[orca/git] ${globalTransientFailureCount} consecutive global transient failures — ` +
            `cooling down for ${GLOBAL_COOLDOWN_MS / 1000}s to reduce system pressure`,
        );
        sleepSync(GLOBAL_COOLDOWN_MS);
      } else {
        // DLL init errors need longer backoff — system must reclaim resources
        const waitMs = dllInit ? attempt * 5000 : attempt * 2000;
        console.warn(
          `[orca/git] transient error on "git ${args.join(" ")}" ` +
            `(attempt ${attempt}/${maxAttempts}, global: ${globalTransientFailureCount}` +
            `${dllInit ? ", DLL_INIT" : ""}), ` +
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
