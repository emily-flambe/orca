import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { git, gitAsync, isTransientGitError } from "../git.js";
import {
  removeWorktree,
  removeWorktreeAsync,
  rmSyncWithRetry,
  rmWithRetry,
} from "../worktree/index.js";
import { getWorktreePool } from "../worktree/pool.js";
import { listOpenPrBranches, closeOrphanedPrs } from "../github/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { OrcaDb } from "../db/index.js";
import {
  getAllTasks,
  getInvocation,
  getLastMaxTurnsInvocation,
  getRunningInvocations,
} from "../db/queries.js";
import { createLogger } from "../logger.js";

/** Track consecutive failed removal attempts per directory path. */
const failedRemovalAttempts = new Map<string, number>();
const MAX_REMOVAL_ATTEMPTS = 5;

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

const logger = createLogger("cleanup");

function log(message: string): void {
  logger.info(message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the commit date of the latest commit on a branch, in ms since epoch.
 * Returns null if the branch or log command fails.
 */
function getBranchLastCommitMs(branchName: string, cwd: string): number | null {
  try {
    const dateStr = git(["log", "-1", "--format=%ci", branchName], { cwd });
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
 * - Never deletes branches younger than 60 minutes
 */
export function cleanupStaleResources(deps: CleanupDeps): void {
  const { db } = deps;

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

  // Branches referenced by tasks where a workflow is actively using the PR.
  // Tasks in backlog/ready/done/failed have no workflow watching their PR,
  // so those PRs are eligible for orphan cleanup.
  const PR_ACTIVE_STATUSES = new Set([
    "running",
    "in_review",
    "changes_requested",
    "awaiting_ci",
    "deploying",
  ]);
  const activeBranches = new Set(
    allTasks
      .filter((t) => PR_ACTIVE_STATUSES.has(t.orcaStatus))
      .map((t) => t.prBranchName)
      .filter((b): b is string => b != null),
  );

  // Build set of worktree paths preserved for resume (max-turns on "ready" tasks)
  const preservedWorktreePaths = new Set<string>();
  const readyTasks = allTasks.filter((t) => t.orcaStatus === "ready");
  for (const t of readyTasks) {
    const inv = getLastMaxTurnsInvocation(db, t.linearIssueId);
    if (inv?.worktreePath) {
      preservedWorktreePaths.add(inv.worktreePath);
    }
  }

  const now = Date.now();
  const CLEANUP_BRANCH_MAX_AGE_MIN = 60;
  const maxAgeMs = CLEANUP_BRANCH_MAX_AGE_MIN * 60 * 1000;

  for (const repoPath of repoPaths) {
    try {
      cleanupRepo(repoPath, {
        runningBranches,
        runningWorktreePaths,
        preservedWorktreePaths,
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
    preservedWorktreePaths: Set<string>;
    activeBranches: Set<string>;
    now: number;
    maxAgeMs: number;
  },
): void {
  // --- Worktree cleanup ---
  try {
    git(["worktree", "prune"], { cwd: repoPath });
  } catch (err) {
    const detail = isTransientGitError(err)
      ? " (transient, will retry next cycle)"
      : "";
    logger.warn(`worktree prune failed for ${repoPath}${detail}: ${err}`);
  }

  const repoDirname = basename(repoPath);
  const parentDir = dirname(repoPath);

  // Remove registered worktrees matching the <repo>-<taskId> pattern.
  //
  // Two normalization levels:
  //   normalizePath  — slashes + lowercase, used ONLY for comparisons/set lookups.
  //                    Handles Windows vs git path format mismatches (git returns
  //                    forward slashes; paths may differ in case, e.g. "GitHub"
  //                    vs "Github").
  //   normalizeSlashes — slashes only, used for the worktreePaths array so that
  //                    the original casing is preserved when passed to removeWorktree()
  //                    and to fs/git commands (which may be case-sensitive).
  const normalizePath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const normalizeSlashes = (p: string) => p.replace(/\\/g, "/");
  const worktreePaths = listWorktreePaths(repoPath).map(normalizeSlashes);
  // Pre-built set for O(1) membership tests — lowercase for case-insensitive matching.
  const normalizedWorktreePathSet = new Set(worktreePaths.map(normalizePath));
  const normalizedRepoPath = normalizePath(repoPath);
  const normalizedRepoDirname = normalizePath(repoDirname);
  const normalizedRunningWtPaths = new Set(
    [...ctx.runningWorktreePaths].map(normalizePath),
  );
  const normalizedPreservedWtPaths = new Set(
    [...ctx.preservedWorktreePaths].map(normalizePath),
  );

  // Never remove pool reserve worktrees — build the set once outside loops
  const pool = getWorktreePool();
  const normalizedPoolPaths = pool
    ? new Set([...pool.getReservePaths()].map(normalizePath))
    : new Set<string>();

  for (const wtPath of worktreePaths) {
    // Skip the main worktree (the repo itself)
    if (normalizePath(wtPath) === normalizedRepoPath) continue;

    // Only clean up worktrees that match our naming pattern
    const normalizedBasename = basename(normalizePath(wtPath));
    if (!normalizedBasename.startsWith(`${normalizedRepoDirname}-`)) continue;

    // Never remove worktrees with running invocations
    if (normalizedRunningWtPaths.has(normalizePath(wtPath))) continue;

    // Never remove worktrees preserved for session resume
    if (normalizedPreservedWtPaths.has(normalizePath(wtPath))) continue;

    // Never remove pool reserve worktrees
    if (normalizedPoolPaths.has(normalizePath(wtPath))) continue;

    // Skip directories that have failed too many times
    const wtAttempts = failedRemovalAttempts.get(wtPath) ?? 0;
    if (wtAttempts >= MAX_REMOVAL_ATTEMPTS) continue;

    try {
      removeWorktree(wtPath);
      failedRemovalAttempts.delete(wtPath);
      log(`removed worktree: ${wtPath}`);
    } catch (err) {
      const newAttempts = wtAttempts + 1;
      failedRemovalAttempts.set(wtPath, newAttempts);
      if (newAttempts >= MAX_REMOVAL_ATTEMPTS) {
        log(
          `permanently skipping worktree ${wtPath} after ${newAttempts} failed attempts — manual removal required`,
        );
      } else {
        log(`failed to remove worktree ${wtPath}: ${err}`);
      }
    }
  }

  // Also clean up unregistered directories matching the pattern
  // (e.g. leftover from crashes where git worktree remove was never called)
  try {
    const siblings = readdirSync(parentDir);
    for (const entry of siblings) {
      if (!normalizePath(entry).startsWith(`${normalizedRepoDirname}-`))
        continue;
      // Skip the base repo itself
      if (normalizePath(entry) === normalizedRepoDirname) continue;

      const fullPath = join(parentDir, entry);

      // Skip if this is a registered worktree (already handled above)
      if (normalizedWorktreePathSet.has(normalizePath(fullPath))) continue;

      // Skip if running
      if (normalizedRunningWtPaths.has(normalizePath(fullPath))) continue;

      // Skip if preserved for session resume
      if (normalizedPreservedWtPaths.has(normalizePath(fullPath))) continue;

      // Skip if pool reserve
      if (normalizedPoolPaths.has(normalizePath(fullPath))) continue;

      // Check it's a directory
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Skip directories that have failed too many times
      const attempts = failedRemovalAttempts.get(fullPath) ?? 0;
      if (attempts >= MAX_REMOVAL_ATTEMPTS) continue;

      try {
        rmSyncWithRetry(fullPath);
        failedRemovalAttempts.delete(fullPath);
        log(`removed orphaned worktree directory: ${fullPath}`);
      } catch (err) {
        const newAttempts = attempts + 1;
        failedRemovalAttempts.set(fullPath, newAttempts);
        if (newAttempts >= MAX_REMOVAL_ATTEMPTS) {
          log(
            `permanently skipping orphaned directory ${fullPath} after ${newAttempts} failed attempts — manual removal required`,
          );
        } else {
          log(`failed to remove orphaned directory ${fullPath}: ${err}`);
        }
      }
    }
  } catch {
    // Parent dir read failed — skip orphan cleanup for this repo
  }

  // --- Branch cleanup ---

  // Close orphaned PRs first — this removes the open-PR protection so the
  // branch cleanup loop below can delete those branches on the same cycle.
  // Also run before listOrcaBranches so that any local branches deleted by
  // `gh pr close --delete-branch` are already gone.
  try {
    const closedCount = closeOrphanedPrs(repoPath, {
      runningBranches: ctx.runningBranches,
      activeBranches: ctx.activeBranches,
      maxAgeMs: ctx.maxAgeMs,
      now: ctx.now,
    });
    if (closedCount > 0) {
      log(`closed ${closedCount} orphaned PR(s) in ${repoPath}`);
    }
  } catch (err) {
    log(`failed to close orphaned PRs in ${repoPath}: ${err}`);
  }

  const orcaBranches = listOrcaBranches(repoPath);
  if (orcaBranches.length === 0) return;

  // Fetch open PR branches once per repo (after closing orphans)
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
// Async helpers (non-blocking equivalents)
// ---------------------------------------------------------------------------

async function getBranchLastCommitMsAsync(
  branchName: string,
  cwd: string,
): Promise<number | null> {
  try {
    const dateStr = await gitAsync(["log", "-1", "--format=%ci", branchName], {
      cwd,
    });
    if (!dateStr) return null;
    const ms = new Date(dateStr).getTime();
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

async function listOrcaBranchesAsync(cwd: string): Promise<string[]> {
  try {
    const output = await gitAsync(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/orca/"],
      { cwd },
    );
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function listWorktreePathsAsync(cwd: string): Promise<string[]> {
  try {
    const output = await gitAsync(["worktree", "list", "--porcelain"], {
      cwd,
    });
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
// Async core cleanup
// ---------------------------------------------------------------------------

/**
 * Async version of cleanupStaleResources — uses non-blocking git/worktree
 * operations and yields to the event loop between iterations.
 */
export async function cleanupStaleResourcesAsync(
  deps: CleanupDeps,
): Promise<void> {
  const { db } = deps;

  const allTasks = getAllTasks(db);
  const repoPaths = [...new Set(allTasks.map((t) => t.repoPath))];

  if (repoPaths.length === 0) return;

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

  const PR_ACTIVE_STATUSES = new Set([
    "running",
    "in_review",
    "changes_requested",
    "awaiting_ci",
    "deploying",
  ]);
  const activeBranches = new Set(
    allTasks
      .filter((t) => PR_ACTIVE_STATUSES.has(t.orcaStatus))
      .map((t) => t.prBranchName)
      .filter((b): b is string => b != null),
  );

  const preservedWorktreePaths = new Set<string>();
  const readyTasks = allTasks.filter((t) => t.orcaStatus === "ready");
  for (const t of readyTasks) {
    const inv = getLastMaxTurnsInvocation(db, t.linearIssueId);
    if (inv?.worktreePath) {
      preservedWorktreePaths.add(inv.worktreePath);
    }
  }

  const now = Date.now();
  const CLEANUP_BRANCH_MAX_AGE_MIN = 60;
  const maxAgeMs = CLEANUP_BRANCH_MAX_AGE_MIN * 60 * 1000;

  for (const repoPath of repoPaths) {
    try {
      await cleanupRepoAsync(repoPath, {
        runningBranches,
        runningWorktreePaths,
        preservedWorktreePaths,
        activeBranches,
        now,
        maxAgeMs,
      });
    } catch (err) {
      log(`error cleaning up repo ${repoPath}: ${err}`);
    }
    // Yield to event loop between repos
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function cleanupRepoAsync(
  repoPath: string,
  ctx: {
    runningBranches: Set<string>;
    runningWorktreePaths: Set<string>;
    preservedWorktreePaths: Set<string>;
    activeBranches: Set<string>;
    now: number;
    maxAgeMs: number;
  },
): Promise<void> {
  // --- Worktree cleanup ---
  try {
    await gitAsync(["worktree", "prune"], { cwd: repoPath });
  } catch (err) {
    const detail = isTransientGitError(err)
      ? " (transient, will retry next cycle)"
      : "";
    logger.warn(`worktree prune failed for ${repoPath}${detail}: ${err}`);
  }

  const repoDirname = basename(repoPath);
  const parentDir = dirname(repoPath);

  const normalizePath = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const normalizeSlashes = (p: string) => p.replace(/\\/g, "/");
  const worktreePaths = (await listWorktreePathsAsync(repoPath)).map(
    normalizeSlashes,
  );
  const normalizedWorktreePathSet = new Set(worktreePaths.map(normalizePath));
  const normalizedRepoPath = normalizePath(repoPath);
  const normalizedRepoDirname = normalizePath(repoDirname);
  const normalizedRunningWtPaths = new Set(
    [...ctx.runningWorktreePaths].map(normalizePath),
  );
  const normalizedPreservedWtPaths = new Set(
    [...ctx.preservedWorktreePaths].map(normalizePath),
  );

  // Never remove pool reserve worktrees — build the set once outside loops
  const poolAsync = getWorktreePool();
  const normalizedPoolPathsAsync = poolAsync
    ? new Set([...poolAsync.getReservePaths()].map(normalizePath))
    : new Set<string>();

  for (const wtPath of worktreePaths) {
    if (normalizePath(wtPath) === normalizedRepoPath) continue;

    const normalizedBasename = basename(normalizePath(wtPath));
    if (!normalizedBasename.startsWith(`${normalizedRepoDirname}-`)) continue;

    if (normalizedRunningWtPaths.has(normalizePath(wtPath))) continue;
    if (normalizedPreservedWtPaths.has(normalizePath(wtPath))) continue;
    if (normalizedPoolPathsAsync.has(normalizePath(wtPath))) continue;

    const wtAttempts = failedRemovalAttempts.get(wtPath) ?? 0;
    if (wtAttempts >= MAX_REMOVAL_ATTEMPTS) continue;

    try {
      await removeWorktreeAsync(wtPath);
      failedRemovalAttempts.delete(wtPath);
      log(`removed worktree: ${wtPath}`);
    } catch (err) {
      const newAttempts = wtAttempts + 1;
      failedRemovalAttempts.set(wtPath, newAttempts);
      if (newAttempts >= MAX_REMOVAL_ATTEMPTS) {
        log(
          `permanently skipping worktree ${wtPath} after ${newAttempts} failed attempts — manual removal required`,
        );
      } else {
        log(`failed to remove worktree ${wtPath}: ${err}`);
      }
    }

    // Yield to event loop between worktree removals
    await new Promise((resolve) => setImmediate(resolve));
  }

  // Also clean up unregistered directories matching the pattern
  try {
    const siblings = readdirSync(parentDir);
    for (const entry of siblings) {
      if (!normalizePath(entry).startsWith(`${normalizedRepoDirname}-`))
        continue;
      if (normalizePath(entry) === normalizedRepoDirname) continue;

      const fullPath = join(parentDir, entry);

      if (normalizedWorktreePathSet.has(normalizePath(fullPath))) continue;
      if (normalizedRunningWtPaths.has(normalizePath(fullPath))) continue;
      if (normalizedPreservedWtPaths.has(normalizePath(fullPath))) continue;
      if (normalizedPoolPathsAsync.has(normalizePath(fullPath))) continue;

      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const attempts = failedRemovalAttempts.get(fullPath) ?? 0;
      if (attempts >= MAX_REMOVAL_ATTEMPTS) continue;

      try {
        await rmWithRetry(fullPath);
        failedRemovalAttempts.delete(fullPath);
        log(`removed orphaned worktree directory: ${fullPath}`);
      } catch (err) {
        const newAttempts = attempts + 1;
        failedRemovalAttempts.set(fullPath, newAttempts);
        if (newAttempts >= MAX_REMOVAL_ATTEMPTS) {
          log(
            `permanently skipping orphaned directory ${fullPath} after ${newAttempts} failed attempts — manual removal required`,
          );
        } else {
          log(`failed to remove orphaned directory ${fullPath}: ${err}`);
        }
      }

      // Yield to event loop between directory removals
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch {
    // Parent dir read failed — skip orphan cleanup for this repo
  }

  // --- Branch cleanup ---

  // closeOrphanedPrs and listOpenPrBranches remain sync (github module scope)
  try {
    const closedCount = closeOrphanedPrs(repoPath, {
      runningBranches: ctx.runningBranches,
      activeBranches: ctx.activeBranches,
      maxAgeMs: ctx.maxAgeMs,
      now: ctx.now,
    });
    if (closedCount > 0) {
      log(`closed ${closedCount} orphaned PR(s) in ${repoPath}`);
    }
  } catch (err) {
    log(`failed to close orphaned PRs in ${repoPath}: ${err}`);
  }

  const orcaBranches = await listOrcaBranchesAsync(repoPath);
  if (orcaBranches.length === 0) return;

  const openPrBranches = listOpenPrBranches(repoPath);

  for (const branch of orcaBranches) {
    if (ctx.runningBranches.has(branch)) continue;
    if (ctx.activeBranches.has(branch)) continue;
    if (openPrBranches.has(branch)) continue;

    const commitMs = await getBranchLastCommitMsAsync(branch, repoPath);
    if (commitMs === null || ctx.now - commitMs < ctx.maxAgeMs) continue;

    try {
      await gitAsync(["branch", "-D", branch], { cwd: repoPath });
      log(`deleted stale branch: ${branch}`);
    } catch (err) {
      log(`failed to delete branch ${branch}: ${err}`);
    }

    // Yield to event loop between branch deletions
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Invocation log retention cleanup
// ---------------------------------------------------------------------------

/**
 * Delete NDJSON invocation log files older than the configured retention window.
 * Only deletes logs for invocations in terminal states (completed/failed).
 * Logs for running/in-progress invocations are never deleted.
 * Unknown/unmatched files are deleted only if older than 2x the retention window.
 */
export function cleanupOldInvocationLogs(deps: CleanupDeps): void {
  const { db } = deps;
  const INVOCATION_LOG_RETENTION_HOURS = 168;
  const retentionMs = INVOCATION_LOG_RETENTION_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  let files: string[];
  try {
    files = readdirSync("logs/").filter((f) => f.endsWith(".ndjson"));
  } catch {
    // logs/ directory doesn't exist yet — nothing to clean
    return;
  }

  for (const filename of files) {
    const filepath = `logs/${filename}`;
    let mtime: number;
    try {
      mtime = statSync(filepath).mtimeMs;
    } catch {
      continue;
    }

    const ageMs = now - mtime;

    // Parse invocation ID from filename (format: <id>.ndjson)
    const idStr = filename.slice(0, -".ndjson".length);
    // Require purely numeric filename to avoid partial parseInt matches (e.g. "1abc" → 1)
    const id = /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;

    if (Number.isNaN(id)) {
      // Can't parse ID — use conservative 2x retention window
      if (ageMs < retentionMs * 2) continue;
      try {
        unlinkSync(filepath);
        log(
          `deleted stale invocation log: ${filename} (age: ${Math.round(ageMs / 3600000)}h)`,
        );
      } catch (err) {
        log(`failed to delete invocation log ${filename}: ${err}`);
      }
      continue;
    }

    // Check if old enough
    if (ageMs < retentionMs) continue;

    // Verify terminal state in DB
    const invocation = getInvocation(db, id);
    if (!invocation) {
      // Not in DB — use conservative 2x retention window
      if (ageMs < retentionMs * 2) continue;
      try {
        unlinkSync(filepath);
        log(
          `deleted stale invocation log: ${filename} (age: ${Math.round(ageMs / 3600000)}h)`,
        );
      } catch (err) {
        log(`failed to delete invocation log ${filename}: ${err}`);
      }
      continue;
    }

    const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out"]);
    if (!TERMINAL_STATUSES.has(invocation.status)) {
      // Running or in-progress — never delete
      continue;
    }

    try {
      unlinkSync(filepath);
      log(
        `deleted stale invocation log: ${filename} (age: ${Math.round(ageMs / 3600000)}h)`,
      );
    } catch (err) {
      log(`failed to delete invocation log ${filename}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron task retention cleanup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { listOrcaBranches, getBranchLastCommitMs };
