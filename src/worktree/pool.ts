import { join, dirname, basename } from "node:path";
import { existsSync, readdirSync, copyFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitAsync } from "../git.js";
import { removeWorktreeAsync } from "./index.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);

const logger = createLogger("worktree/pool");

export interface PoolEntry {
  worktreePath: string;
  branchName: string;
  createdAt: number;
  repoPath: string;
}

/**
 * Manages a pool of pre-created git worktrees for near-instant task dispatch.
 *
 * Pool entries are created in the background on `initialize()`. When a task
 * is dispatched, `claim()` synchronously pops a ready entry and renames its
 * branch to match the task. If the pool is empty, `claim()` returns null and
 * the caller falls back to `createWorktree()`.
 */
export class WorktreePoolService {
  private pools = new Map<string, PoolEntry[]>(); // repoPath -> entries
  private replenishing = new Set<string>(); // repoPath currently replenishing
  private poolSize = 2;
  private counter = 0;
  private destroyed = false;

  /**
   * Start background pre-creation of pool entries for each repo path.
   * Non-blocking: fires and forgets.
   */
  initialize(repoPaths: string[], poolSize: number): void {
    this.destroyed = false;
    this.poolSize = poolSize;
    for (const repoPath of repoPaths) {
      if (!this.pools.has(repoPath)) {
        this.pools.set(repoPath, []);
      }
      this.scheduleReplenish(repoPath);
    }
    logger.info(
      `pool initialized for ${repoPaths.length} repo(s), target size ${poolSize}`,
    );
  }

  /**
   * Synchronously claim a pool entry for a task.
   *
   * Pops the oldest ready entry, renames its branch to
   * `orca/<taskId>-inv-<invocationId>`, copies fresh .env files, then
   * triggers background replenishment.
   *
   * Returns null if the pool for repoPath is empty.
   */
  claim(
    repoPath: string,
    taskId: string,
    invocationId: number | string,
  ): { worktreePath: string; branchName: string } | null {
    const pool = this.pools.get(repoPath);
    if (!pool || pool.length === 0) {
      logger.info(`pool empty for ${repoPath}, falling back to createWorktree`);
      return null;
    }

    const entry = pool.shift()!;
    const newBranchName = `orca/${taskId}-inv-${invocationId}`;

    // Rename branch async (fire-and-forget the rename, but we return
    // synchronously with the new branch name so the caller can proceed).
    // Delete the target branch first in case a prior attempt left it behind
    // (retry scenario where orca/<taskId>-inv-0 already exists locally).
    gitAsync(["branch", "-D", newBranchName], { cwd: repoPath })
      .catch(() => {
        /* branch may not exist — OK */
      })
      .then(() =>
        gitAsync(["branch", "-m", entry.branchName, newBranchName], {
          cwd: repoPath,
        }),
      )
      .then(() => {
        // Copy fresh .env files after rename so secrets are up-to-date
        try {
          copyEnvFiles(repoPath, entry.worktreePath);
        } catch (err) {
          logger.warn(
            `pool claim: failed to copy .env files to ${entry.worktreePath}: ${err}`,
          );
        }
      })
      .catch((err) => {
        logger.warn(
          `pool claim: branch rename from ${entry.branchName} to ${newBranchName} failed: ${err}`,
        );
      });

    logger.info(
      `pool claim: ${entry.worktreePath} → branch ${newBranchName} (task ${taskId})`,
    );

    // Trigger background replenishment to refill the pool slot
    this.scheduleReplenish(repoPath);

    return { worktreePath: entry.worktreePath, branchName: newBranchName };
  }

  /**
   * Returns all current pool entry paths (so cleanup doesn't delete them).
   */
  getReservedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const entries of this.pools.values()) {
      for (const entry of entries) {
        paths.add(entry.worktreePath);
      }
    }
    return paths;
  }

  /**
   * Rebase pool entries older than maxAgeMs against origin/main.
   * Removes and replaces entries that fail rebase.
   */
  async refreshStale(repoPath: string, maxAgeMs: number): Promise<void> {
    const pool = this.pools.get(repoPath);
    if (!pool || pool.length === 0) return;

    const now = Date.now();
    const stale = pool.filter((e) => now - e.createdAt > maxAgeMs);
    if (stale.length === 0) return;

    logger.info(`pool refresh: ${stale.length} stale entry(s) for ${repoPath}`);

    for (const entry of stale) {
      // Remove from pool first
      const idx = pool.indexOf(entry);
      if (idx !== -1) pool.splice(idx, 1);

      try {
        await gitAsync(["fetch", "origin"], { cwd: entry.worktreePath });
        await gitAsync(["rebase", "origin/main"], { cwd: entry.worktreePath });
        // Refresh timestamp and add back only if pool still has room
        if (pool.length < this.poolSize) {
          entry.createdAt = Date.now();
          pool.push(entry);
          logger.info(`pool refresh: rebased ${entry.worktreePath}`);
        } else {
          // Pool was refilled by replenishment while rebase was in flight — discard
          logger.info(
            `pool refresh: pool full after rebase, discarding ${entry.worktreePath}`,
          );
          removeWorktreeAsync(entry.worktreePath).catch((e) => {
            logger.warn(
              `pool refresh: failed to remove surplus entry ${entry.worktreePath}: ${e}`,
            );
          });
        }
      } catch (err) {
        logger.warn(
          `pool refresh: rebase failed for ${entry.worktreePath}, removing: ${err}`,
        );
        try {
          await removeWorktreeAsync(entry.worktreePath);
        } catch (removeErr) {
          logger.warn(
            `pool refresh: failed to remove stale entry ${entry.worktreePath}: ${removeErr}`,
          );
        }
        // Trigger replenishment to replace the removed entry
        this.scheduleReplenish(repoPath);
      }
    }
  }

  /**
   * Remove all pool worktrees. Called on shutdown.
   */
  async destroy(): Promise<void> {
    this.destroyed = true; // Prevent in-flight replenish from adding new entries

    const allEntries: PoolEntry[] = [];
    for (const entries of this.pools.values()) {
      allEntries.push(...entries);
    }
    this.pools.clear();

    logger.info(`pool destroy: removing ${allEntries.length} entries`);

    await Promise.allSettled(
      allEntries.map(async (entry) => {
        try {
          await removeWorktreeAsync(entry.worktreePath);
          logger.info(`pool destroy: removed ${entry.worktreePath}`);
        } catch (err) {
          logger.warn(
            `pool destroy: failed to remove ${entry.worktreePath}: ${err}`,
          );
        }
      }),
    );
  }

  private scheduleReplenish(repoPath: string): void {
    if (this.replenishing.has(repoPath)) return;

    const pool = this.pools.get(repoPath);
    if (!pool) return;

    const needed = this.poolSize - pool.length;
    if (needed <= 0) return;

    this.replenishing.add(repoPath);
    // Fire and forget
    this.replenish(repoPath).catch((err) => {
      logger.warn(`pool replenishment failed for ${repoPath}: ${err}`);
    });
  }

  private async replenish(repoPath: string): Promise<void> {
    try {
      const pool = this.pools.get(repoPath);
      if (!pool) return;

      while (!this.destroyed && pool.length < this.poolSize) {
        try {
          const entry = await this.createEntry(repoPath);
          // Re-check after await in case destroy() was called while we waited
          if (this.destroyed) {
            removeWorktreeAsync(entry.worktreePath).catch(() => {});
            break;
          }
          pool.push(entry);
          logger.info(
            `pool replenish: created ${entry.worktreePath} (pool size: ${pool.length}/${this.poolSize})`,
          );
        } catch (err) {
          logger.warn(
            `pool replenish: entry creation failed for ${repoPath}: ${err}`,
          );
          // Don't stop replenishment entirely on a single failure
          break;
        }
      }
    } finally {
      this.replenishing.delete(repoPath);
    }
  }

  private nextCounter(): number {
    return Date.now() * 1000 + (this.counter++ % 1000);
  }

  private async createEntry(repoPath: string): Promise<PoolEntry> {
    const counter = this.nextCounter();
    const repoDirname = basename(repoPath);
    const parentDir = dirname(repoPath);
    const worktreePath = join(parentDir, `${repoDirname}-pool-${counter}`);
    const branchName = `orca/pool-${counter}`;

    // Step 1: fetch origin
    await gitAsync(["fetch", "origin"], { cwd: repoPath });

    // Step 2: create worktree
    await gitAsync(
      ["worktree", "add", "-b", branchName, worktreePath, "origin/main"],
      { cwd: repoPath },
    );

    // Step 3: copy .env files
    try {
      copyEnvFiles(repoPath, worktreePath);
    } catch (err) {
      logger.warn(
        `pool create: failed to copy .env files to ${worktreePath}: ${err}`,
      );
    }

    // Step 4: npm install if package.json exists
    if (existsSync(join(worktreePath, "package.json"))) {
      try {
        await execFileAsync("npm", ["install"], {
          cwd: worktreePath,
          shell: true,
        });
      } catch (err) {
        logger.warn(
          `pool create: npm install failed in ${worktreePath}: ${err}`,
        );
      }
    }

    // Step 5: nested package.json installs
    const extraInstallDirs = process.env.ORCA_EXTRA_INSTALL_DIRS
      ? process.env.ORCA_EXTRA_INSTALL_DIRS.split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : null;

    if (extraInstallDirs) {
      for (const subdir of extraInstallDirs) {
        const subPath = join(worktreePath, subdir);
        if (existsSync(join(subPath, "package.json"))) {
          try {
            await execFileAsync("npm", ["install"], {
              cwd: subPath,
              shell: true,
            });
          } catch (err) {
            logger.warn(
              `pool create: npm install failed in ${subPath}: ${err}`,
            );
          }
        }
      }
    } else {
      try {
        const entries = readdirSync(worktreePath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name === "node_modules") continue;
          const subPath = join(worktreePath, entry.name);
          if (existsSync(join(subPath, "package.json"))) {
            try {
              await execFileAsync("npm", ["install"], {
                cwd: subPath,
                shell: true,
              });
            } catch (err) {
              logger.warn(
                `pool create: npm install failed in ${subPath}: ${err}`,
              );
            }
          }
        }
      } catch {
        // readdir failed — skip nested installs
      }
    }

    return {
      worktreePath,
      branchName,
      createdAt: Date.now(),
      repoPath,
    };
  }
}

/**
 * Copy all `.env*` files from srcDir to destDir.
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
