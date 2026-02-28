import { execFileSync } from "node:child_process";

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
    const execErr = err as {
      stderr?: string;
      stdout?: string;
      message?: string;
      code?: string;
      status?: number | null;
      signal?: string | null;
    };
    const stderr = execErr.stderr?.trim() ?? "";
    const parts = [`git command failed: git ${args.join(" ")}`];
    if (execErr.code) parts.push(`code: ${execErr.code}`);
    if (execErr.status != null) parts.push(`exit: ${execErr.status}`);
    if (execErr.signal) parts.push(`signal: ${execErr.signal}`);
    if (stderr) parts.push(stderr);
    if (!stderr && execErr.message) parts.push(execErr.message);
    if (options?.cwd) parts.push(`cwd: ${options.cwd}`);
    throw new Error(parts.join("\n"));
  }
}
