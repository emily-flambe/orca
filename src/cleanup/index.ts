import { rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { git } from "../git.js";
import { removeWorktree } from "../worktree/index.js";
import { listOpenPrBranches } from "../github/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import { getAllTasks, getRunningInvocations } from "../db/queries.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupDeps {
  db: OrcaDb;
  config: OrcaConfig;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/cleanup] ${message}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the commit date of the latest commit on a branch, in ms since epoch.
 * Returns null if the branch or log command fails.
 */
function getBranchLastCommitMs(
  branchName: string,
  cwd: string,
): number | null {
  try {
    const dateStr = git(
      ["log", "-1", "--format=%ci", branchName],
      { cwd },
    );
    if (!dateStr) return null;
    const ms = new Date(dateStr).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * List local branches matching the `orca/*` prefix.
 * Returns an array of full branch names (e.g. "orca/TASK-1-inv-2").
 */
function listOrcaBranches(cwd: string): string[] {
  try {
    const output = git(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/orca/"],
      { cwd },
    );
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List registered git worktrees and return their paths.
 */
function listWorktreePaths(cwd: string): string[] {
  try {
    const output = git(["worktree", "list", "--porcelain"], { cwd });
    const paths: string[] = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.push(line.slice("worktree ".length));
      }
    }
    return paths;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up stale `orca/*` branches and orphaned worktrees across all
 * unique repo paths from the tasks table.
 *
 * Safety filters:
 * - Never deletes branches used by running invocations
 * - Never deletes branches referenced by tasks in active states
 * - Never deletes branches with open PRs
 * - Never deletes branches younger than `cleanupBranchMaxAgeMin`
 */
export function cleanupStaleResources(deps: CleanupDeps): void {
  const { db, config } = deps;

  // Collect unique repo paths from all tasks
  const allTasks = getAllTasks(db);
  const repoPaths = [...new Set(allTasks.map((t) => t.repoPath))];

  if (repoPaths.length === 0) return;

  // Build protection sets from DB state
  const runningInvocations = getRunningInvocations(db);
  const runningBranches = new Set(
    runningInvocations
      .map((inv) => inv.branchName)
      .filter((b): b is string => b != null),
  );
  const runningWorktreePaths = new Set(
    runningInvocations
      .map((inv) => inv.worktreePath)
      .filter((p): p is string => p != null),
  );

  // Branches referenced by tasks not in terminal states
  const TERMINAL_STATUSES = new Set(["done", "failed"]);
  const activeBranches = new Set(
    allTasks
      .filter((t) => !TERMINAL_STATUSES.has(t.orcaStatus))
      .map((t) => t.prBranchName)
      .filter((b): b is string => b != null),
  );

  const now = Date.now();
  const maxAgeMs = config.cleanupBranchMaxAgeMin * 60 * 1000;

  for (const repoPath of repoPaths) {
    try {
      cleanupRepo(repoPath, {
        runningBranches,
        runningWorktreePaths,
        activeBranches,
        now,
        maxAgeMs,
      });
    } catch (err) {
      log(`error cleaning up repo ${repoPath}: ${err}`);
    }
  }
}

function cleanupRepo(
  repoPath: string,
  ctx: {
    runningBranches: Set<string>;
    runningWorktreePaths: Set<string>;
    activeBranches: Set<string>;
    now: number;
    maxAgeMs: number;
  },
): void {
  // --- Worktree cleanup ---
  try {
    git(["worktree", "prune"], { cwd: repoPath });
  } catch (err) {
    log(`worktree prune failed for ${repoPath}: ${err}`);
  }

  const repoDirname = basename(repoPath);
  const parentDir = dirname(repoPath);

  // Remove registered worktrees matching the <repo>-<taskId> pattern.
  // Normalize path separators to handle Windows vs git path format mismatches.
  const normalizePath = (p: string) => p.replace(/\\/g, "/");
  const worktreePaths = listWorktreePaths(repoPath).map(normalizePath);
  const normalizedRepoPath = normalizePath(repoPath);
  const normalizedRunningWtPaths = new Set(
    [...ctx.runningWorktreePaths].map(normalizePath),
  );

  for (const wtPath of worktreePaths) {
    // Skip the main worktree (the repo itself)
    if (wtPath === normalizedRepoPath) continue;

    // Only clean up worktrees that match our naming pattern
    const wtBasename = basename(wtPath);
    if (!wtBasename.startsWith(`${repoDirname}-`)) continue;

    // Never remove worktrees with running invocations
    if (normalizedRunningWtPaths.has(wtPath)) continue;

    try {
      removeWorktree(wtPath);
      log(`removed worktree: ${wtPath}`);
    } catch (err) {
      log(`failed to remove worktree ${wtPath}: ${err}`);
    }
  }

  // Also clean up unregistered directories matching the pattern
  // (e.g. leftover from crashes where git worktree remove was never called)
  try {
    const siblings = readdirSync(parentDir);
    for (const entry of siblings) {
      if (!entry.startsWith(`${repoDirname}-`)) continue;
      // Skip the base repo itself
      if (entry === repoDirname) continue;

      const fullPath = join(parentDir, entry);

      // Skip if this is a registered worktree (already handled above)
      if (worktreePaths.includes(normalizePath(fullPath))) continue;

      // Skip if running
      if (normalizedRunningWtPaths.has(normalizePath(fullPath))) continue;

      // Check it's a directory
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        rmSync(fullPath, { recursive: true, force: true });
        log(`removed orphaned worktree directory: ${fullPath}`);
      } catch (err) {
        log(`failed to remove orphaned directory ${fullPath}: ${err}`);
      }
    }
  } catch {
    // Parent dir read failed — skip orphan cleanup for this repo
  }

  // --- Branch cleanup ---
  const orcaBranches = listOrcaBranches(repoPath);
  if (orcaBranches.length === 0) return;

  // Fetch open PR branches once per repo
  const openPrBranches = listOpenPrBranches(repoPath);

  for (const branch of orcaBranches) {
    // Safety: never delete branches with running invocations
    if (ctx.runningBranches.has(branch)) continue;

    // Safety: never delete branches referenced by active tasks
    if (ctx.activeBranches.has(branch)) continue;

    // Safety: never delete branches with open PRs
    if (openPrBranches.has(branch)) continue;

    // Age gate: skip branches with unknown age (fail-safe) or younger than max age
    const commitMs = getBranchLastCommitMs(branch, repoPath);
    if (commitMs === null || ctx.now - commitMs < ctx.maxAgeMs) continue;

    // Safe to delete
    try {
      git(["branch", "-D", branch], { cwd: repoPath });
      log(`deleted stale branch: ${branch}`);
    } catch (err) {
      log(`failed to delete branch ${branch}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { listOrcaBranches, getBranchLastCommitMs };
