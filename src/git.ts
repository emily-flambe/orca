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
 * Currently detects:
 * - Windows exit code 3221225794 (STATUS_DLL_INIT_FAILED / 0xC0000142)
 * - Process killed by signal (e.g. SIGKILL, SIGTERM)
 */
export function isTransientGitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const execErr = err as ExecError;

  // Windows DLL init failure
  if (execErr.status === WIN_DLL_INIT_FAILED) return true;

  // Also check the message for the exit code (our git() formats it as "exit: <code>")
  if (err.message.includes(`exit: ${WIN_DLL_INIT_FAILED}`)) return true;

  // Signal-killed process (OOM killer, etc.)
  if (execErr.signal) return true;
  if (err.message.includes("signal: SIG")) return true;

  return false;
}

/**
 * Wraps git() with retry logic for transient errors.
 *
 * Retries up to `maxAttempts` times with synchronous backoff (2s, 4s)
 * for errors classified as transient by isTransientGitError().
 * Non-transient errors are thrown immediately.
 */
export function gitWithRetry(
  args: string[],
  options?: { cwd?: string },
  maxAttempts = 3,
): string {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return git(args, options);
    } catch (err: unknown) {
      if (!isTransientGitError(err) || attempt === maxAttempts) {
        throw err;
      }
      const waitMs = attempt * 2000;
      console.warn(
        `[orca/git] transient error on "git ${args.join(" ")}" ` +
          `(attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms`,
      );
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* spin */
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
