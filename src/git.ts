// Verified working: 2026-03-03
import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Windows STATUS_DLL_INIT_FAILED exit code (0xC0000142 unsigned). */
const WIN_DLL_INIT_FAILED = 3221225794;
/** Signed 32-bit representation of the same exit code. */
const WIN_DLL_INIT_FAILED_SIGNED = -1073741502;

/** Max retries for DLL_INIT errors within git(). */
const DLL_RETRY_MAX = 3;
/** Delays between DLL_INIT retries: 5s, 15s, 30s. */
const DLL_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

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

/** Check if an execFileSync error has a DLL_INIT exit code. */
function isDllExitCode(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as ExecError).status;
  return (
    status === WIN_DLL_INIT_FAILED || status === WIN_DLL_INIT_FAILED_SIGNED
  );
}

/**
 * Execute a git command synchronously and return trimmed stdout.
 * Uses execFileSync with argument array to avoid shell injection.
 * Retries up to 3 times on Windows DLL_INIT_FAILED errors (desktop heap exhaustion).
 * Throws with a descriptive message including stderr on failure.
 */
export function git(args: string[], options?: { cwd?: string }): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("git", args, {
        encoding: "utf-8",
        cwd: options?.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err: unknown) {
      // Retry DLL_INIT errors with backoff before falling through to error handling
      if (isDllExitCode(err) && attempt < DLL_RETRY_MAX) {
        const delayMs = DLL_RETRY_DELAYS_MS[attempt];
        console.warn(
          `[orca/git] DLL_INIT_FAILED on "git ${args.join(" ")}" — retry ${attempt + 1}/${DLL_RETRY_MAX} after ${delayMs / 1000}s`,
        );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        continue;
      }

      const execErr = err as ExecError;
      const stderr = execErr.stderr?.trim() ?? "";
      const parts = [`git command failed: git ${args.join(" ")}`];
      if (execErr.code) parts.push(`code: ${execErr.code}`);
      if (execErr.status != null) parts.push(`exit: ${execErr.status}`);
      if (execErr.signal) parts.push(`signal: ${execErr.signal}`);
      if (stderr) parts.push(stderr);
      if (!stderr && execErr.message) parts.push(execErr.message);
      if (options?.cwd) parts.push(`cwd: ${options.cwd}`);
      const error = Object.assign(new Error(parts.join("\n")), {
        status: execErr.status,
        signal: execErr.signal,
      });
      throw error;
    }
  }
}

/**
 * Probe whether the system can spawn git processes without DLL_INIT errors.
 * Runs `git --version` with no retry and a 5-second timeout.
 * Returns true if git succeeds or fails with a non-DLL error.
 * Returns false only on DLL_INIT failure.
 */
export function probeDllHealth(): boolean {
  try {
    execFileSync("git", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err: unknown) {
    if (isDllExitCode(err)) return false;
    // Non-DLL error (e.g. git not found) — system is not in DLL_INIT state
    return true;
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
 * - Network/auth failures (DNS, connection, SSL, remote hangup)
 * - Windows EPERM from file locking during worktree operations
 */
export function isTransientGitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const execErr = err as ExecError;

  // Windows DLL init failure — transient resource exhaustion
  // Check both unsigned and signed representations of 0xC0000142
  if (
    execErr.status === WIN_DLL_INIT_FAILED ||
    execErr.status === WIN_DLL_INIT_FAILED_SIGNED
  )
    return true;

  // Signal-killed process (OOM killer, etc.)
  if (execErr.signal) return true;
  if (err.message.includes("signal: SIG")) return true;

  // Network/auth transient errors — DNS, connection, SSL, remote hangup
  const networkPatterns = [
    "Could not resolve host",
    "Connection timed out",
    "Connection refused",
    "fatal: unable to access",
    "SSL_connect",
    "The remote end hung up unexpectedly",
    "Failed to connect",
    "Connection reset by peer",
    "unable to look up",
    "Could not read from remote repository",
  ];
  if (networkPatterns.some((p) => err.message.includes(p))) return true;

  // Windows EPERM — file locking during worktree creation/removal
  if (
    err.message.includes("EPERM") ||
    (execErr as NodeJS.ErrnoException).code === "EPERM"
  )
    return true;

  return false;
}

/**
 * Returns true if the error is specifically a Windows DLL init failure.
 * Used to apply longer backoffs than other transient errors.
 */
export function isDllInitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as ExecError).status;
  return (
    status === WIN_DLL_INIT_FAILED || status === WIN_DLL_INIT_FAILED_SIGNED
  );
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
      console.warn(
        `[orca/git] removed stale lock file: ${lockPath} (age: ${Math.round(age / 1000)}s)`,
      );
    }
  } catch (err) {
    console.warn(`[orca/git] failed to clean lock file ${lockPath}: ${err}`);
  }
}
