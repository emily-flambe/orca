import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { git } from "../git.js";

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
    console.warn(`[orca/worktree] prune failed (non-fatal): ${pruneErr}`);
  }

  // Fetch origin
  git(["fetch", "origin"], { cwd: repoPath });

  // If worktree already exists at target path, reuse it (retry scenario)
  if (existsSync(worktreePath) && worktreeExistsAtPath(repoPath, worktreePath)) {
    if (baseRef) {
      // For review/fix phases, reset to the remote tracking branch
      git(["fetch", "origin"], { cwd: worktreePath });
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
 * Remove a git worktree at the given path.
 *
 * Runs `git worktree remove <path>`. The associated branch is preserved
 * in the repository for future reference.
 *
 * The cwd for the git command is set to the main repository (resolved via
 * `git rev-parse --show-toplevel` from the worktree) to avoid holding a
 * file handle on the worktree directory during removal (Windows issue).
 *
 * @param worktreePath - Absolute path to the worktree directory to remove
 * @throws Error if the git worktree remove command fails
 */
export function removeWorktree(worktreePath: string): void {
  // Resolve the main worktree (repo root) so we don't use the
  // worktree-being-removed as cwd (problematic on Windows).
  const mainWorktree = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: worktreePath },
  );
  // --git-common-dir returns the .git directory (e.g. /repo/.git).
  // We need the repo root, which is its parent.
  const repoRoot = dirname(mainWorktree);
  git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
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
