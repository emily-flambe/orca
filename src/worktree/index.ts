import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { platform } from "node:os";
import { git, cleanStaleLockFiles } from "../git.js";

/**
 * Thrown when a worktree directory cannot be removed because a process
 * still holds file handles, even after attempting to kill such processes.
 * The scheduler should skip the task for this tick and retry later.
 */
export class WorktreeLockedError extends Error {
  constructor(worktreePath: string, cause: unknown) {
    super(
      `Worktree directory is locked (processes killed but EPERM persists): ${worktreePath}`,
    );
    this.name = "WorktreeLockedError";
    this.cause = cause;
  }
}

/**
 * Run npm install synchronously in the given directory.
 * Throws with stderr on failure.
 */
function npmInstall(cwd: string): void {
  try {
    execFileSync("npm", ["install"], {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const stderr = execErr.stderr?.trim() ?? "";
    const detail = stderr || execErr.message || "unknown error";
    throw new Error(`npm install failed in ${cwd}\n${detail}`);
  }
}

/**
 * rmSync with retry for Windows EPERM errors.
 *
 * On Windows, antivirus / indexing services can hold brief locks on files,
 * causing EPERM when deleting a directory tree. Retry up to 3 times with
 * a 2-second synchronous pause between attempts.
 */
function rmSyncWithRetry(dirPath: string, maxAttempts = 3): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" || attempt === maxAttempts) {
        throw err;
      }
      // Synchronous sleep via Atomics.wait — avoids spinning the CPU
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
}

/**
 * Normalize a path for case-insensitive, slash-direction-agnostic comparison.
 *
 * On Windows, git returns paths with forward slashes and may differ in drive
 * letter casing (e.g. "C:/Users/emily/Documents/GitHub/..." vs
 * "C:\Users\emily\Documents\Github\..."). Normalizing both sides before
 * comparison ensures the "reuse existing worktree" path in createWorktree()
 * actually matches and avoids the delete-and-recreate path that triggers EPERM.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/**
 * Kill any processes that may hold file handles inside `dirPath`.
 *
 * On Windows, grandchild processes (e.g. wrangler dev spawning miniflare)
 * can survive a session kill and hold open handles in the worktree directory,
 * causing EPERM on subsequent rmSync / git worktree remove attempts.
 *
 * Uses PowerShell to find processes whose command line references the directory
 * and forcefully terminates them. Best-effort: errors are silently ignored.
 */
function killProcessesInDirectory(dirPath: string): void {
  if (platform() !== "win32") return;
  try {
    // Normalize to backslashes for matching against Windows command lines.
    // Escape single quotes for use in a PowerShell single-quoted string.
    const winPath = dirPath.replace(/\//g, "\\").replace(/'/g, "''");
    execSync(
      `powershell.exe -NoProfile -NonInteractive -Command ` +
        `"Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.CommandLine -ne $null -and $_.CommandLine.Contains('${winPath}') } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore", timeout: 10_000 },
    );
  } catch {
    // Best-effort: ignore errors (process may have already exited)
  }
}

/**
 * Detect and resolve merge conflicts in a worktree.
 *
 * Runs `git diff --check` to detect conflict markers in the working tree.
 * If any are found, logs a warning with the affected file names and
 * hard-resets to `origin/main` to give the agent a clean starting point.
 *
 * @param worktreePath - Absolute path to the worktree directory
 */
function detectAndResolveConflicts(worktreePath: string): void {
  try {
    git(["diff", "--check"], { cwd: worktreePath });
  } catch {
    // git diff --check exits non-zero when conflict markers are found.
    // Get conflicted file names for the warning via git grep.
    let conflictedFiles: string[] = [];
    try {
      const grepOut = git(["grep", "-l", "^<<<<<<< "], { cwd: worktreePath });
      conflictedFiles = grepOut.split("\n").filter(Boolean);
    } catch {
      // grep exited non-zero (no matches or error) — file list unknown
    }
    console.warn(
      `[orca/worktree] conflict markers detected in ${worktreePath} — ` +
        `resetting to origin/main. Conflicted files: ${conflictedFiles.join(", ") || "(unknown)"}`,
    );
    git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
  }
}

/**
 * Check whether a git worktree is already registered at the given path.
 */
function worktreeExistsAtPath(repoPath: string, worktreePath: string): boolean {
  const output = git(["worktree", "list", "--porcelain"], { cwd: repoPath });
  const normalizedTarget = normalizePath(worktreePath);
  // Each worktree block starts with "worktree <absolute-path>"
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      // Normalize both sides: git may return forward slashes with different
      // drive-letter casing than the path we constructed.
      const gitPath = normalizePath(line.slice("worktree ".length));
      if (gitPath === normalizedTarget) return true;
    }
  }
  return false;
}

/**
 * Check whether a local branch exists in the repo.
 */
function branchExists(repoPath: string, branchName: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a branch exists on the remote (origin).
 */
function remoteRefExists(repoPath: string, branchName: string): boolean {
  try {
    const output = git(["ls-remote", "--heads", "origin", branchName], {
      cwd: repoPath,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy all `.env*` files from the source directory to the destination.
 * Silently succeeds if no `.env*` files exist.
 */
function copyEnvFiles(srcDir: string, destDir: string): void {
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    if (entry.startsWith(".env")) {
      copyFileSync(join(srcDir, entry), join(destDir, entry));
    }
  }
}

/**
 * Create a git worktree for a task invocation.
 *
 * - Fetches origin in the base repo
 * - Creates branch `orca/<taskId>-inv-<invocationId>` from `origin/main`
 * - Creates worktree as sibling directory `<repoDirname>-<taskId>`
 * - Copies `.env*` files from the base repo (if any)
 * - Runs `npm install` if `package.json` exists in the worktree
 *
 * If the worktree already exists at the target path (retry scenario),
 * it is reset to `origin/main` instead of being recreated.
 *
 * If the branch already exists (e.g. review/fix phase reusing the implement branch),
 * it is checked out directly and reset to origin instead of being deleted and recreated.
 *
 * @param repoPath - Absolute path to the base git repository
 * @param taskId - Task identifier (e.g. "ORC-12")
 * @param invocationId - Invocation identifier (e.g. 7)
 * @param options - Optional settings: `baseRef` to check out an existing remote branch
 *   instead of creating a new branch from origin/main (used for review/fix phases)
 * @returns Object with `worktreePath` and `branchName`
 * @throws Error if `repoPath` does not exist or git operations fail
 */
export function createWorktree(
  repoPath: string,
  taskId: string,
  invocationId: number | string,
  options?: { baseRef?: string },
): { worktreePath: string; branchName: string } {
  // Validate repo path exists
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const repoDirname = basename(repoPath);
  const parentDir = dirname(repoPath);
  const worktreePath = join(parentDir, `${repoDirname}-${taskId}`);
  const baseRef = options?.baseRef;
  const branchName = baseRef ?? `orca/${taskId}-inv-${invocationId}`;

  // Prune stale worktree references (directory removed but git still
  // tracks it) before anything else — this must run before fetch so that
  // a transient network error doesn't leave stale references blocking
  // future worktree creation.
  // Best-effort: a transient OS error (e.g. Windows 0xC0000142) should
  // not prevent the worktree add attempt.
  try {
    git(["worktree", "prune"], { cwd: repoPath });
  } catch (pruneErr) {
    // Log but don't throw — worktree add may still succeed
    console.warn(`[orca/worktree] prune failed (non-fatal): ${pruneErr}`);
  }

  // Clean stale lock files before fetch (best-effort)
  cleanStaleLockFiles(repoPath);

  // Fetch origin (with retry for transient OS errors)
  git(["fetch", "origin"], { cwd: repoPath });

  // If worktree already exists at target path, reuse it (retry scenario)
  if (
    existsSync(worktreePath) &&
    worktreeExistsAtPath(repoPath, worktreePath)
  ) {
    if (baseRef) {
      // For review/fix phases, reset to the remote tracking branch
      try {
        git(["fetch", "origin"], { cwd: worktreePath });
        git(["reset", "--hard", `origin/${baseRef}`], { cwd: worktreePath });
      } catch {
        console.warn(
          `[orca/worktree] reset to origin/${baseRef} failed, falling back to origin/main`,
        );
        git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
      }
    } else {
      resetWorktree(worktreePath);
    }
    detectAndResolveConflicts(worktreePath);
    return { worktreePath, branchName };
  }

  // If directory exists but isn't a registered worktree (e.g. stale from a
  // previous failed run), remove it so git worktree add can succeed.
  if (existsSync(worktreePath)) {
    // Kill processes that may hold file handles before attempting removal.
    // On Windows, node/wrangler/miniflare survivors from a previous session
    // can cause EPERM on rmSync.
    killProcessesInDirectory(worktreePath);
    try {
      rmSyncWithRetry(worktreePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY") {
        throw new WorktreeLockedError(worktreePath, err);
      }
      throw err;
    }
  }

  if (baseRef) {
    // Use the same branch name as the PR branch so pushes update the existing PR
    // instead of creating a new remote branch.
    if (branchExists(repoPath, baseRef)) {
      // Branch already exists locally — check it out directly (no -b) to avoid
      // "branch is checked out" errors, then sync to origin.
      git(["worktree", "add", worktreePath, baseRef], { cwd: repoPath });
      git(["reset", "--hard", `origin/${baseRef}`], { cwd: worktreePath });
    } else if (remoteRefExists(repoPath, baseRef)) {
      // Branch exists on remote — create tracking branch
      git(
        ["worktree", "add", "-b", baseRef, worktreePath, `origin/${baseRef}`],
        {
          cwd: repoPath,
        },
      );
    } else {
      // Remote ref gone (branch deleted or name mismatch) — fall back to origin/main
      console.warn(
        `[orca/worktree] remote ref origin/${baseRef} not found, falling back to origin/main`,
      );
      git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"], {
        cwd: repoPath,
      });
    }
  } else {
    // If branch already exists, delete it first
    if (branchExists(repoPath, branchName)) {
      git(["branch", "-D", branchName], { cwd: repoPath });
    }
    // Create worktree with new branch based on origin/main
    git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"], {
      cwd: repoPath,
    });
  }

  // Copy .env* files from base repo
  copyEnvFiles(repoPath, worktreePath);

  // Run npm install if package.json exists
  if (existsSync(join(worktreePath, "package.json"))) {
    npmInstall(worktreePath);
  }

  // Install nested package.json files.
  // If ORCA_EXTRA_INSTALL_DIRS is set (comma-separated), install only those dirs.
  // Otherwise, auto-discover by walking one level of subdirectories.
  const extraInstallDirs = process.env.ORCA_EXTRA_INSTALL_DIRS
    ? process.env.ORCA_EXTRA_INSTALL_DIRS.split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : null;

  if (extraInstallDirs) {
    for (const subdir of extraInstallDirs) {
      const subPath = join(worktreePath, subdir);
      if (existsSync(join(subPath, "package.json"))) {
        npmInstall(subPath);
      }
    }
  } else {
    const entries = readdirSync(worktreePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const subPath = join(worktreePath, entry.name);
      if (existsSync(join(subPath, "package.json"))) {
        npmInstall(subPath);
      }
    }
  }

  detectAndResolveConflicts(worktreePath);
  return { worktreePath, branchName };
}

/**
 * Derive the base repo root from a worktree path by stripping the task-ID
 * suffix. Worktree dirs are named `<repoDirname>-<taskId>`, e.g.
 * `orca-EMI-29`. We test progressively shorter hyphen-separated prefixes
 * against existing directories.
 *
 * Returns `undefined` if no candidate directory exists.
 */
export function deriveRepoRoot(worktreePath: string): string | undefined {
  const parentDir = dirname(worktreePath);
  const dirName = basename(worktreePath);
  const parts = dirName.split("-");

  // Try progressively shorter prefixes (at least 1 part)
  for (let len = parts.length - 1; len >= 1; len--) {
    const candidate = join(parentDir, parts.slice(0, len).join("-"));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Remove a git worktree at the given path.
 *
 * Uses a three-level fallback chain:
 * 1. Resolve repo root via `git rev-parse --git-common-dir`, then `git worktree remove`
 * 2. If rev-parse fails (corrupt worktree), derive repo root from path pattern,
 *    then `git worktree remove`
 * 3. If git worktree remove also fails, fall back to rmSync + git worktree prune
 *
 * The associated branch is preserved in the repository for future reference.
 *
 * @param worktreePath - Absolute path to the worktree directory to remove
 */
export function removeWorktree(worktreePath: string): void {
  // Pre-deletion: kill processes that may hold file handles in the worktree.
  // On Windows, grandchild processes (wrangler, miniflare, etc.) can survive
  // after the parent session is killed and hold open handles, causing EPERM.
  killProcessesInDirectory(worktreePath);

  // Pre-deletion: remove node_modules trees first — they are the primary
  // source of EPERM on Windows (deeply nested paths + antivirus locks).
  // Best-effort: errors are logged but don't block the main removal flow.
  if (platform() === "win32" && existsSync(worktreePath)) {
    for (const candidate of [
      join(worktreePath, "node_modules"),
      ...(() => {
        try {
          return readdirSync(worktreePath, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name !== "node_modules")
            .map((e) => join(worktreePath, e.name, "node_modules"))
            .filter((p) => existsSync(p));
        } catch {
          return [];
        }
      })(),
    ]) {
      try {
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // Best-effort: will retry in the full removal below
      }
    }
  }

  // Capture branch name before the directory is removed (needed for Bug 3
  // ghost-ref cleanup below). Detached HEAD or missing worktree returns null.
  let worktreeBranchName: string | null = null;
  try {
    const branchRef = git(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: worktreePath,
    }).trim();
    if (branchRef && branchRef !== "HEAD") {
      worktreeBranchName = branchRef;
    }
  } catch {
    // Worktree may already be in a broken state; proceed without branch name
  }

  let repoRoot: string | undefined;

  // Level 1: resolve repo root via git
  try {
    const mainWorktree = git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreePath },
    );
    // --git-common-dir returns the .git directory (e.g. /repo/.git).
    // We need the repo root, which is its parent.
    repoRoot = dirname(mainWorktree);
  } catch {
    // Level 2: derive repo root from worktree path pattern
    repoRoot = deriveRepoRoot(worktreePath);
    if (repoRoot) {
      console.warn(
        `[orca/worktree] rev-parse failed for ${worktreePath}, derived repo root: ${repoRoot}`,
      );
    }
  }

  // Try git worktree remove if we have a repo root
  if (repoRoot) {
    try {
      git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
      return;
    } catch (removeErr) {
      console.warn(
        `[orca/worktree] git worktree remove failed for ${worktreePath}: ${removeErr}`,
      );
      // Fall through to level 3
    }
  }

  // Level 3: brute-force removal + prune
  console.warn(
    `[orca/worktree] falling back to rmSync + prune for ${worktreePath}`,
  );
  if (existsSync(worktreePath)) {
    try {
      rmSyncWithRetry(worktreePath);
    } catch (rmErr) {
      // Last resort: rename to .trash so the original path is unblocked
      const trashPath = `${worktreePath}.trash-${Date.now()}`;
      try {
        renameSync(worktreePath, trashPath);
        console.warn(
          `[orca/worktree] renamed stuck directory to ${trashPath} — manual cleanup needed`,
        );
      } catch {
        throw rmErr;
      }
    }
  }
  if (repoRoot) {
    try {
      git(["worktree", "prune"], { cwd: repoRoot });
    } catch (pruneErr) {
      console.warn(`[orca/worktree] prune after rmSync failed: ${pruneErr}`);
    }

    // Bug 3: After prune, force-delete any ghost branch reference.
    // When rmSyncWithRetry removes the directory but git still has the branch
    // ref pointing there (as "checked out"), git branch -D fails with "branch
    // is checked out in worktree". git update-ref -d bypasses that check.
    if (worktreeBranchName) {
      try {
        git(["update-ref", "-d", `refs/heads/${worktreeBranchName}`], {
          cwd: repoRoot,
        });
      } catch {
        // Branch may not exist or was already cleaned up by worktree prune
      }
    }
  }
}

/**
 * Reset a worktree to origin/main.
 *
 * Fetches the latest from origin, then hard-resets the worktree
 * to `origin/main`. Used for retry scenarios where the worktree
 * already exists and needs a clean slate.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @throws Error if the git fetch or reset commands fail
 */
export function resetWorktree(worktreePath: string): void {
  git(["fetch", "origin"], { cwd: worktreePath });
  git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
}
