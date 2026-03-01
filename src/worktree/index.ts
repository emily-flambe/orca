import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { git, gitWithRetry, cleanStaleLockFiles } from "../git.js";
import { createLogger } from "../logger.js";

const logger = createLogger("worktree");

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
      // Synchronous busy-wait — acceptable here (see createWorktree jsdoc)
      const waitMs = 2000;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
}

/**
 * Check whether a git worktree is already registered at the given path.
 */
function worktreeExistsAtPath(repoPath: string, worktreePath: string): boolean {
  const output = git(["worktree", "list", "--porcelain"], { cwd: repoPath });
  // Each worktree block starts with "worktree <absolute-path>"
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ") && line.slice("worktree ".length) === worktreePath) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether a local branch exists in the repo.
 */
function branchExists(repoPath: string, branchName: string): boolean {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoPath });
    return true;
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
 * If the branch already exists (e.g. from a previous failed attempt),
 * it is deleted and recreated.
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
    logger.warn(`prune failed (non-fatal): ${pruneErr}`);
  }

  // Clean stale lock files before fetch (best-effort)
  cleanStaleLockFiles(repoPath);

  // Fetch origin (with retry for transient OS errors)
  gitWithRetry(["fetch", "origin"], { cwd: repoPath });

  // If worktree already exists at target path, reuse it (retry scenario)
  if (existsSync(worktreePath) && worktreeExistsAtPath(repoPath, worktreePath)) {
    if (baseRef) {
      // For review/fix phases, reset to the remote tracking branch
      gitWithRetry(["fetch", "origin"], { cwd: worktreePath });
      git(["reset", "--hard", `origin/${baseRef}`], { cwd: worktreePath });
    } else {
      resetWorktree(worktreePath);
    }
    return { worktreePath, branchName };
  }

  // If directory exists but isn't a registered worktree (e.g. stale from a
  // previous failed run), remove it so git worktree add can succeed.
  if (existsSync(worktreePath)) {
    rmSyncWithRetry(worktreePath);
  }

  if (baseRef) {
    // Check out existing remote branch for review/fix phases.
    // Create a local branch tracking the remote branch.
    const localBranch = `orca/${taskId}-inv-${invocationId}`;
    if (branchExists(repoPath, localBranch)) {
      git(["branch", "-D", localBranch], { cwd: repoPath });
    }
    git(["worktree", "add", "-b", localBranch, worktreePath, `origin/${baseRef}`], { cwd: repoPath });
  } else {
    // If branch already exists, delete it first
    if (branchExists(repoPath, branchName)) {
      git(["branch", "-D", branchName], { cwd: repoPath });
    }
    // Create worktree with new branch based on origin/main
    git(["worktree", "add", "-b", branchName, worktreePath, "origin/main"], { cwd: repoPath });
  }

  // Copy .env* files from base repo
  copyEnvFiles(repoPath, worktreePath);

  // Run npm install if package.json exists
  if (existsSync(join(worktreePath, "package.json"))) {
    npmInstall(worktreePath);
  }

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
    rmSyncWithRetry(worktreePath);
  }
  if (repoRoot) {
    try {
      git(["worktree", "prune"], { cwd: repoRoot });
    } catch (pruneErr) {
      logger.warn(`prune after rmSync failed: ${pruneErr}`);
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
  gitWithRetry(["fetch", "origin"], { cwd: worktreePath });
  git(["reset", "--hard", "origin/main"], { cwd: worktreePath });
}
