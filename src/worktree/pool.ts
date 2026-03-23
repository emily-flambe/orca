import { randomBytes } from "node:crypto";
import { existsSync, copyFileSync, readdirSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { git, gitAsync } from "../git.js";
import { createWorktree, removeWorktreeAsync } from "./index.js";
import { createLogger } from "../logger.js";

const logger = createLogger("worktree/pool");

export interface PoolEntry {
  worktreePath: string; // e.g., .../orca-pool-<uuid>
  branchName: string; // e.g., orca/pool-<uuid>
  repoPath: string;
  createdAt: number; // Date.now()
}

function shortUuid(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Copy all `.env*` files from the source directory to the destination.
 * Silently succeeds if no `.env*` files exist.
 */
function copyEnvFiles(srcDir: string, destDir: string): void {
  try {
    const entries = readdirSync(srcDir);
    for (const entry of entries) {
      if (entry.startsWith(".env")) {
        copyFileSync(join(srcDir, entry), join(destDir, entry));
      }
    }
  } catch {
    // Best-effort
  }
}

/**
 * Run npm install asynchronously in the given directory.
 * Returns true on success, false on failure (non-fatal for pool creation).
 */
async function npmInstallAsync(cwd: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("npm", ["install"], {
      encoding: "utf-8",
      cwd,
      shell: true,
    });
    return true;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const detail = execErr.stderr?.trim() || execErr.message || "unknown error";
    logger.warn(`npm install failed in ${cwd}: ${detail}`);
    return false;
  }
}

/**
 * Run the full post-worktree setup: copy env files, npm install root,
 * npm install nested dirs.
 */
async function runPostWorktreeSetup(
  worktreePath: string,
  repoPath: string,
): Promise<void> {
  // Copy .env* files from base repo
  copyEnvFiles(repoPath, worktreePath);

  // npm install root
  if (existsSync(join(worktreePath, "package.json"))) {
    await npmInstallAsync(worktreePath);
  }

  // Install nested package.json files
  const extraInstallDirs = process.env.ORCA_EXTRA_INSTALL_DIRS
    ? process.env.ORCA_EXTRA_INSTALL_DIRS.split(",")
        .map((d) => d.trim())
        .filter(Boolean)
    : null;

  if (extraInstallDirs) {
    for (const subdir of extraInstallDirs) {
      const subPath = join(worktreePath, subdir);
      if (existsSync(join(subPath, "package.json"))) {
        await npmInstallAsync(subPath);
      }
    }
  } else {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(worktreePath, { withFileTypes: true });
    } catch {
      // Best-effort
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const subPath = join(worktreePath, entry.name as string);
      if (existsSync(join(subPath, "package.json"))) {
        await npmInstallAsync(subPath);
      }
    }
  }
}

export class WorktreePoolService {
  private readonly poolSize: number;
  /** Pool entries keyed by repoPath */
  private readonly pool = new Map<string, PoolEntry[]>();
  /** Whether the pool has been started */
  private started = false;
  /** Track in-progress creation to avoid double-filling */
  private readonly creating = new Map<string, boolean>();

  constructor(poolSize: number) {
    this.poolSize = poolSize;
  }

  /**
   * Start background pre-creation. Non-blocking — uses setTimeout(..., 0).
   */
  start(repoPaths: string[]): void {
    if (this.poolSize <= 0) {
      logger.info("worktree pool disabled (poolSize=0)");
      return;
    }
    this.started = true;
    for (const repoPath of repoPaths) {
      if (!this.pool.has(repoPath)) {
        this.pool.set(repoPath, []);
      }
      // Schedule initial fill
      setTimeout(() => {
        this.fillPool(repoPath).catch((err) => {
          logger.warn(`pool initial fill failed for ${repoPath}: ${err}`);
        });
      }, 0);
    }
    logger.info(
      `worktree pool started: poolSize=${this.poolSize}, repos=${repoPaths.length}`,
    );
  }

  /**
   * Stop the pool. Cancels future replenishment attempts.
   */
  stop(): void {
    this.started = false;
    logger.info("worktree pool stopped");
  }

  /**
   * Claim a ready worktree for a task. Renames branch and moves directory.
   * Falls back to createWorktree() if pool is empty.
   *
   * MUST be synchronous — called from Inngest step.run().
   */
  claim(
    repoPath: string,
    taskId: string,
  ): { worktreePath: string; branchName: string } {
    const entries = this.pool.get(repoPath) ?? [];
    const entry = entries.shift();

    if (!entry) {
      logger.info(
        `pool miss for ${repoPath} (task ${taskId}), falling back to createWorktree`,
      );
      return createWorktree(repoPath, taskId, 0);
    }

    // Compute target paths
    const parentDir = dirname(repoPath);
    const repoDirname = basename(repoPath);
    const taskPath = join(parentDir, `${repoDirname}-${taskId}`);
    const taskBranch = `orca/${taskId}-inv-0`;

    try {
      // Try git worktree move first
      try {
        git(["worktree", "move", entry.worktreePath, taskPath], {
          cwd: repoPath,
        });
      } catch (moveErr) {
        // git worktree move may not exist on old git — fall back to renameSync + repair
        logger.warn(
          `git worktree move failed (${moveErr}), trying renameSync + repair`,
        );
        try {
          renameSync(entry.worktreePath, taskPath);
          git(["worktree", "repair", taskPath], { cwd: repoPath });
        } catch (repairErr) {
          // Both failed — fall back to createWorktree
          logger.warn(
            `worktree move fallback also failed (${repairErr}), falling back to createWorktree`,
          );
          // Replenish asynchronously
          this.scheduleReplenish(repoPath);
          return createWorktree(repoPath, taskId, 0);
        }
      }

      // Rename the branch. If taskBranch already exists locally (prior failed run),
      // delete it first so the rename succeeds.
      try {
        git(["branch", "-m", entry.branchName, taskBranch], { cwd: repoPath });
      } catch (renameErr) {
        // Branch rename failed — likely because taskBranch already exists locally.
        // Delete the conflicting local branch and retry.
        logger.warn(
          `git branch -m failed (${renameErr}), trying to delete conflicting branch ${taskBranch} and retry`,
        );
        try {
          git(["branch", "-D", taskBranch], { cwd: repoPath });
          git(["branch", "-m", entry.branchName, taskBranch], {
            cwd: repoPath,
          });
        } catch (retryErr) {
          // Still failing — move the directory back so createWorktree can recreate it cleanly.
          // Without this, createWorktree finds taskPath exists with wrong registration,
          // triggering rmSyncWithRetry which causes EPERM on Windows.
          logger.warn(
            `branch rename retry failed (${retryErr}), moving directory back before fallback`,
          );
          try {
            renameSync(taskPath, entry.worktreePath);
            git(["worktree", "repair", entry.worktreePath], { cwd: repoPath });
          } catch {
            // Best-effort — if we can't move back, createWorktree will handle the path
          }
          this.scheduleReplenish(repoPath);
          return createWorktree(repoPath, taskId, 0);
        }
      }

      // Sanity check
      if (!existsSync(taskPath)) {
        logger.warn(
          `task path does not exist after move: ${taskPath}, falling back`,
        );
        this.scheduleReplenish(repoPath);
        return createWorktree(repoPath, taskId, 0);
      }

      logger.info(
        `pool hit for ${repoPath} (task ${taskId}): ${entry.worktreePath} → ${taskPath}`,
      );

      // Schedule replenish
      this.scheduleReplenish(repoPath);

      return { worktreePath: taskPath, branchName: taskBranch };
    } catch (err) {
      logger.warn(
        `pool claim failed for task ${taskId}: ${err}, falling back to createWorktree`,
      );
      this.scheduleReplenish(repoPath);
      return createWorktree(repoPath, taskId, 0);
    }
  }

  /**
   * Get all current pool entry paths (used by cleanup to protect from deletion).
   */
  getPoolPaths(): Set<string> {
    const paths = new Set<string>();
    for (const entries of this.pool.values()) {
      for (const entry of entries) {
        paths.add(entry.worktreePath);
      }
    }
    return paths;
  }

  /**
   * Refresh stale entries (fetch + reset --hard origin/main) — for cleanup cron.
   * Best-effort: errors are logged but don't break the pool.
   */
  async refreshStaleEntries(): Promise<void> {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();

    for (const [_repoPath, entries] of this.pool.entries()) {
      for (const entry of entries) {
        if (now - entry.createdAt < ONE_HOUR_MS) continue;

        try {
          await gitAsync(["fetch", "origin"], { cwd: entry.worktreePath });
          await gitAsync(["reset", "--hard", "origin/main"], {
            cwd: entry.worktreePath,
          });
          entry.createdAt = Date.now(); // reset age
          logger.info(`refreshed pool entry: ${entry.worktreePath}`);
        } catch (err) {
          logger.warn(
            `failed to refresh pool entry ${entry.worktreePath}: ${err}`,
          );
        }
      }
    }

    // Also check for entries tracked in pool but whose path no longer exists
    for (const [repoPath, entries] of this.pool.entries()) {
      const valid = entries.filter((e) => existsSync(e.worktreePath));
      if (valid.length !== entries.length) {
        logger.warn(
          `pool for ${repoPath}: ${entries.length - valid.length} entries missing from disk — removing`,
        );
        this.pool.set(repoPath, valid);
        this.scheduleReplenish(repoPath);
      }
    }
  }

  /**
   * Remove pool entries older than maxAgeMs — for cleanup cron.
   */
  async cleanupOrphaned(maxAgeMs: number): Promise<void> {
    const now = Date.now();

    for (const [repoPath, entries] of this.pool.entries()) {
      const toRemove: PoolEntry[] = [];
      const toKeep: PoolEntry[] = [];

      for (const entry of entries) {
        if (now - entry.createdAt > maxAgeMs) {
          toRemove.push(entry);
        } else {
          toKeep.push(entry);
        }
      }

      if (toRemove.length > 0) {
        this.pool.set(repoPath, toKeep);
        for (const entry of toRemove) {
          logger.info(
            `removing orphaned pool entry (age > ${maxAgeMs / 3600000}h): ${entry.worktreePath}`,
          );
          removeWorktreeAsync(entry.worktreePath).catch((err) => {
            logger.warn(
              `failed to remove orphaned pool entry ${entry.worktreePath}: ${err}`,
            );
          });
        }
        // Replenish
        this.scheduleReplenish(repoPath);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleReplenish(repoPath: string): void {
    if (!this.started || this.poolSize <= 0) return;
    setTimeout(() => {
      this.fillPool(repoPath).catch((err) => {
        logger.warn(`pool replenish failed for ${repoPath}: ${err}`);
      });
    }, 0);
  }

  private async fillPool(repoPath: string): Promise<void> {
    if (!this.started || this.poolSize <= 0) return;
    if (this.creating.get(repoPath)) return; // already filling

    const entries = this.pool.get(repoPath) ?? [];
    const needed = this.poolSize - entries.length;
    if (needed <= 0) return;

    this.creating.set(repoPath, true);
    try {
      for (let i = 0; i < needed; i++) {
        if (!this.started) break;

        try {
          const entry = await this.createPoolEntry(repoPath);
          const current = this.pool.get(repoPath) ?? [];
          current.push(entry);
          this.pool.set(repoPath, current);
          logger.info(
            `pool entry created for ${repoPath}: ${entry.worktreePath} (pool size: ${current.length}/${this.poolSize})`,
          );
        } catch (err) {
          logger.warn(`failed to create pool entry for ${repoPath}: ${err}`);
          // Don't retry immediately — next replenish cycle will try again
          break;
        }
      }
    } finally {
      this.creating.set(repoPath, false);
    }
  }

  private async createPoolEntry(repoPath: string): Promise<PoolEntry> {
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }

    const uuid = shortUuid();
    const repoDirname = basename(repoPath);
    const parentDir = dirname(repoPath);
    const worktreePath = join(parentDir, `${repoDirname}-pool-${uuid}`);
    const branchName = `orca/pool-${uuid}`;

    // Fetch origin to get latest main
    await gitAsync(["fetch", "origin"], { cwd: repoPath });

    // Create the worktree
    await gitAsync(
      ["worktree", "add", "-b", branchName, worktreePath, "origin/main"],
      { cwd: repoPath },
    );

    // Run post-setup (env files, npm install)
    await runPostWorktreeSetup(worktreePath, repoPath);

    return {
      worktreePath,
      branchName,
      repoPath,
      createdAt: Date.now(),
    };
  }
}
