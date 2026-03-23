import { execFileSync, execSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { platform } from "node:os";
import { git, gitAsync, cleanStaleLockFiles } from "../git.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);

const logger = createLogger("worktree");

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
 * rmSync with retry for Windows EPERM/EBUSY errors.
 *
 * On Windows, antivirus / indexing services can hold brief locks on files,
 * causing EPERM or EBUSY when deleting a directory tree. Retry up to 5 times
 * with exponential backoff (2s → 4s → 8s → 16s, ~30s total).
 */
export function rmSyncWithRetry(dirPath: string, maxAttempts = 5): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s, 16s
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

/**
 * Async version of rmSyncWithRetry — uses fs/promises.rm and setTimeout
 * instead of rmSync and Atomics.wait. Does not block the event loop.
 */
export async function rmWithRetry(
  dirPath: string,
  maxAttempts = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s, 16s
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
 * Check whether a branch exists locally (refs/heads only).
 */
function localBranchExists(repoPath: string, branchName: string): boolean {
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
  let worktreePath = join(parentDir, `${repoDirname}-${taskId}`);
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
    logger.warn(`prune failed (non-fatal): ${pruneErr}`);
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
        logger.warn(
          `reset to origin/${baseRef} failed, falling back to origin/main`,
        );
        git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
      }
    } else {
      resetWorktree(worktreePath);
    }
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
        // Path is locked by an external process (antivirus, indexer, etc.).
        // Use an alternate path instead of blocking the task.
        for (let alt = 1; alt <= 3; alt++) {
          const altPath = `${worktreePath}-retry-${alt}`;
          if (!existsSync(altPath)) {
            logger.warn(
              `worktree path locked (${code}), using alternate: ${altPath}`,
            );
            worktreePath = altPath;
            break;
          }
          // Alt path also exists — try to remove it
          try {
            killProcessesInDirectory(altPath);
            rmSyncWithRetry(altPath);
            logger.warn(
              `worktree path locked (${code}), using alternate: ${altPath}`,
            );
            worktreePath = altPath;
            break;
          } catch {
            if (alt === 3) throw new WorktreeLockedError(worktreePath, err);
          }
        }
      } else {
        throw err;
      }
    }
  }

  if (baseRef) {
    // Use the same branch name as the PR branch so pushes update the existing PR
    // instead of creating a new remote branch.
    if (localBranchExists(repoPath, baseRef)) {
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
      logger.warn(
        `remote ref origin/${baseRef} not found, falling back to origin/main`,
      );
      git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"], {
        cwd: repoPath,
      });
    }
  } else {
    // If branch exists locally, delete it so we can create fresh from origin/main.
    // We only delete local branches here; remote-tracking refs are handled below.
    try {
      git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
        cwd: repoPath,
      });
      // Local branch exists — delete it
      git(["branch", "-D", branchName], { cwd: repoPath });
    } catch {
      // No local branch to delete
    }
    // Create worktree with new branch based on origin/main.
    // If -b fails because the branch name conflicts with a remote-tracking ref
    // (e.g., from a previous invocation that was pushed to origin), recover by
    // creating the local branch explicitly at origin/main and checking it out.
    try {
      git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"], {
        cwd: repoPath,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("already exists")) {
        logger.warn(
          `git worktree add -b failed (branch already exists on remote), recovering: ${branchName}`,
        );
        // Create local branch at origin/main (ignoring remote-tracking ref content),
        // then checkout in the worktree.
        git(["branch", branchName, "origin/main"], { cwd: repoPath });
        git(["worktree", "add", worktreePath, branchName], { cwd: repoPath });
      } else {
        throw err;
      }
    }
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

  // Detect and resolve merge conflicts (e.g. from a prior failed rebase)
  const conflictedFiles = hasConflictMarkers(worktreePath);
  if (conflictedFiles.length > 0) {
    logger.warn(
      `merge conflicts detected in ${worktreePath} (${conflictedFiles.join(", ")}) — resetting to origin/main`,
    );
    git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
  }

  return { worktreePath, branchName };
}

/**
 * Check whether tracked files in the worktree contain merge conflict markers.
 *
 * Runs `git diff --check` which detects conflict markers (`<<<<<<<`, `=======`,
 * `>>>>>>>`). Returns the list of file names that have conflicts, or an empty
 * array if the worktree is clean. Errors are caught and treated as clean
 * (non-fatal).
 */
function hasConflictMarkers(worktreePath: string): string[] {
  try {
    execFileSync("git", ["diff", "--check"], {
      encoding: "utf-8",
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Exit 0 means no issues — no conflict markers
    return [];
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; status?: number | null };
    // git diff --check exits non-zero when it finds issues
    if (execErr.status && execErr.stdout) {
      const files = new Set<string>();
      for (const line of execErr.stdout.split("\n")) {
        // Output format: "filename:linenum: leftover conflict marker"
        const match = line.match(/^(.+?):\d+:/);
        if (match) {
          files.add(match[1]);
        }
      }
      return [...files];
    }
    // Some other error (e.g. git not found, not a repo) — treat as clean
    return [];
  }
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
      logger.warn(
        `rev-parse failed for ${worktreePath}, derived repo root: ${repoRoot}`,
      );
    }
  }

  // Try git worktree remove if we have a repo root
  if (repoRoot) {
    try {
      git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
      return;
    } catch (removeErr) {
      logger.warn(
        `git worktree remove failed for ${worktreePath}: ${removeErr}`,
      );
      // Fall through to level 3
    }
  }

  // Level 3: brute-force removal + prune
  logger.warn(`falling back to rmSync + prune for ${worktreePath}`);
  if (existsSync(worktreePath)) {
    try {
      rmSyncWithRetry(worktreePath);
    } catch (rmErr) {
      // Last resort: rename to .trash so the original path is unblocked
      const trashPath = `${worktreePath}.trash-${Date.now()}`;
      try {
        renameSync(worktreePath, trashPath);
        logger.warn(
          `renamed stuck directory to ${trashPath} — manual cleanup needed`,
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
      logger.warn(`prune after rmSync failed: ${pruneErr}`);
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
 * Async version of killProcessesInDirectory — uses execFile (promise-based)
 * instead of execSync. Best-effort: errors are silently ignored.
 */
async function killProcessesInDirectoryAsync(dirPath: string): Promise<void> {
  if (platform() !== "win32") return;
  try {
    const winPath = dirPath.replace(/\//g, "\\").replace(/'/g, "''");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process | ` +
          `Where-Object { $_.CommandLine -ne $null -and $_.CommandLine.Contains('${winPath}') } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { timeout: 10_000 },
    );
  } catch {
    // Best-effort: ignore errors (process may have already exited)
  }
}

/**
 * Async version of removeWorktree — uses gitAsync, rmWithRetry, and
 * killProcessesInDirectoryAsync. Does not block the event loop.
 *
 * Same three-level fallback chain as the sync version:
 * 1. Resolve repo root via git rev-parse, then git worktree remove
 * 2. Derive repo root from path pattern, then git worktree remove
 * 3. Fall back to rm + git worktree prune
 */
export async function removeWorktreeAsync(worktreePath: string): Promise<void> {
  // Pre-deletion: kill processes that may hold file handles in the worktree.
  await killProcessesInDirectoryAsync(worktreePath);

  // Pre-deletion: remove node_modules trees first — they are the primary
  // source of EPERM on Windows (deeply nested paths + antivirus locks).
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
        await rm(candidate, { recursive: true, force: true });
      } catch {
        // Best-effort: will retry in the full removal below
      }
    }
  }

  // Capture branch name before the directory is removed
  let worktreeBranchName: string | null = null;
  try {
    const branchRef = (
      await gitAsync(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: worktreePath,
      })
    ).trim();
    if (branchRef && branchRef !== "HEAD") {
      worktreeBranchName = branchRef;
    }
  } catch {
    // Worktree may already be in a broken state; proceed without branch name
  }

  let repoRoot: string | undefined;

  // Level 1: resolve repo root via git
  try {
    const mainWorktree = await gitAsync(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: worktreePath },
    );
    repoRoot = dirname(mainWorktree);
  } catch {
    // Level 2: derive repo root from worktree path pattern
    repoRoot = deriveRepoRoot(worktreePath);
    if (repoRoot) {
      logger.warn(
        `rev-parse failed for ${worktreePath}, derived repo root: ${repoRoot}`,
      );
    }
  }

  // Try git worktree remove if we have a repo root
  if (repoRoot) {
    try {
      await gitAsync(["worktree", "remove", "--force", worktreePath], {
        cwd: repoRoot,
      });
      return;
    } catch (removeErr) {
      logger.warn(
        `git worktree remove failed for ${worktreePath}: ${removeErr}`,
      );
      // Fall through to level 3
    }
  }

  // Level 3: brute-force removal + prune
  logger.warn(`falling back to rm + prune for ${worktreePath}`);
  if (existsSync(worktreePath)) {
    try {
      await rmWithRetry(worktreePath);
    } catch (rmErr) {
      // Last resort: rename to .trash so the original path is unblocked
      const trashPath = `${worktreePath}.trash-${Date.now()}`;
      try {
        renameSync(worktreePath, trashPath);
        logger.warn(
          `renamed stuck directory to ${trashPath} — manual cleanup needed`,
        );
      } catch {
        throw rmErr;
      }
    }
  }
  if (repoRoot) {
    try {
      await gitAsync(["worktree", "prune"], { cwd: repoRoot });
    } catch (pruneErr) {
      logger.warn(`prune after rm failed: ${pruneErr}`);
    }

    // Bug 3: After prune, force-delete any ghost branch reference.
    if (worktreeBranchName) {
      try {
        await gitAsync(
          ["update-ref", "-d", `refs/heads/${worktreeBranchName}`],
          { cwd: repoRoot },
        );
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

/**
 * Write Claude Code hook configuration into the worktree's
 * `.claude/settings.local.json` so that Claude Code sends structured
 * hook events (Notification, Stop) back to Orca via HTTP webhook.
 *
 * Must be called after the worktree is created and before the Claude
 * session is spawned. The invocationId is required because the hook
 * URL embeds it for per-invocation routing.
 *
 * The `.claude/settings.local.json` file will be removed automatically
 * when the worktree directory is deleted during cleanup — no explicit
 * teardown is needed.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param hookUrl - Full URL that Claude Code hooks should POST to
 */
export function writeHookConfig(
  worktreePath: string,
  hookUrl: string,
): void {
  try {
    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const curlCommand = `curl -s -X POST -H 'Content-Type: application/json' -d @- '${hookUrl}' || true`;

    const config = {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: curlCommand,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: curlCommand,
              },
            ],
          },
        ],
      },
    };

    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(config, null, 2),
    );
  } catch (err) {
    // Best-effort: hook config is supplemental. Log and continue.
    logger.warn(`writeHookConfig failed (non-fatal): ${err}`);
  }
}
