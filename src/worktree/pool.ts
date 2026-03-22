import { createWorktree, resetWorktree, removeWorktree } from "./index.js";
import { git } from "../git.js";
import { createLogger } from "../logger.js";
import { existsSync } from "node:fs";

const logger = createLogger("worktree/pool");

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

interface PoolEntry {
  worktreePath: string;
  branchName: string;
  repoPath: string;
  createdAt: number;
}

export class WorktreePoolService {
  private readonly poolSize: number;
  private pool: Map<string, PoolEntry[]> = new Map();
  private inFlight: Map<string, number> = new Map();
  private creationQueue: Array<() => void> = [];
  private queueRunning = false;

  constructor(poolSize: number) {
    this.poolSize = poolSize;
  }

  /** Start pool pre-creation for the given repo paths. Non-blocking. */
  start(repoPaths: string[]): void {
    for (const repoPath of repoPaths) {
      if (!this.pool.has(repoPath)) {
        this.pool.set(repoPath, []);
      }
    }
    for (const repoPath of repoPaths) {
      this._scheduleReplenishment(repoPath);
    }
  }

  /**
   * Claim a pre-created worktree from the pool.
   * Renames the pool branch to orca/<taskId>-inv-<invocationId>.
   * Returns null if pool is empty — caller must fall back to createWorktree().
   */
  claim(
    repoPath: string,
    taskId: string,
    invocationId: number | string,
  ): { worktreePath: string; branchName: string } | null {
    const entries = this.pool.get(repoPath);
    if (!entries || entries.length === 0) {
      logger.info(`pool miss for ${repoPath} — pool empty`);
      return null;
    }

    const entry = entries.shift()!;
    const newBranchName = `orca/${taskId}-inv-${invocationId}`;

    // Rename pool branch to task branch
    let actualBranchName = entry.branchName;
    try {
      git(["branch", "-m", entry.branchName, newBranchName], {
        cwd: entry.repoPath,
      });
      actualBranchName = newBranchName;
      logger.info(
        `pool hit: ${entry.worktreePath} → branch ${newBranchName} (pool size after: ${entries.length}/${this.poolSize})`,
      );
    } catch (err) {
      logger.warn(
        `claim: branch rename failed ${entry.branchName} → ${newBranchName}: ${err}`,
      );
      // Return with original branch name — worktree is still usable
    }

    // Replenish after claim
    this._scheduleReplenishment(repoPath);

    return {
      worktreePath: entry.worktreePath,
      branchName: actualBranchName,
    };
  }

  /**
   * Get all currently pooled worktree paths.
   * Used by cleanup to protect pool worktrees from removal.
   */
  getPooledPaths(): Set<string> {
    const paths = new Set<string>();
    for (const entries of this.pool.values()) {
      for (const entry of entries) {
        paths.add(entry.worktreePath);
      }
    }
    return paths;
  }

  /**
   * Refresh stale pool entries by rebasing against origin/main.
   * Called by the cleanup cron. Entries older than 1 hour are refreshed or removed.
   */
  refresh(): void {
    const now = Date.now();
    for (const [repoPath, entries] of this.pool.entries()) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (now - entry.createdAt <= STALE_THRESHOLD_MS) continue;

        if (!existsSync(entry.worktreePath)) {
          entries.splice(i, 1);
          this._scheduleReplenishment(repoPath);
          continue;
        }

        try {
          resetWorktree(entry.worktreePath);
          entry.createdAt = now;
          logger.info(`refreshed stale pool entry: ${entry.worktreePath}`);
        } catch (err) {
          logger.warn(
            `failed to refresh pool entry ${entry.worktreePath}: ${err}`,
          );
          entries.splice(i, 1);
          try {
            removeWorktree(entry.worktreePath);
          } catch {
            // best-effort
          }
          this._scheduleReplenishment(repoPath);
        }
      }
    }
  }

  private _scheduleReplenishment(repoPath: string): void {
    const entries = this.pool.get(repoPath) ?? [];
    const inFlight = this.inFlight.get(repoPath) ?? 0;
    const needed = this.poolSize - entries.length - inFlight;
    for (let i = 0; i < needed; i++) {
      this._enqueueCreation(repoPath);
    }
  }

  private _enqueueCreation(repoPath: string): void {
    // Increment in-flight count immediately (before async execution)
    this.inFlight.set(repoPath, (this.inFlight.get(repoPath) ?? 0) + 1);

    this.creationQueue.push(() => {
      this._createEntry(repoPath);
    });

    if (!this.queueRunning) {
      this._drainQueue();
    }
  }

  private _drainQueue(): void {
    const task = this.creationQueue.shift();
    if (!task) {
      this.queueRunning = false;
      return;
    }
    this.queueRunning = true;
    setImmediate(() => {
      task();
      this._drainQueue();
    });
  }

  private _createEntry(repoPath: string): void {
    const shortId = Math.random().toString(36).slice(2, 10);
    try {
      const result = createWorktree(repoPath, `pool-${shortId}`, 0);
      const entries = this.pool.get(repoPath);
      if (entries) {
        entries.push({
          worktreePath: result.worktreePath,
          branchName: result.branchName,
          repoPath,
          createdAt: Date.now(),
        });
        logger.info(
          `pool: created ${result.worktreePath} for ${repoPath} (pool: ${entries.length}/${this.poolSize})`,
        );
      } else {
        // Pool map entry was removed (e.g. unexpected shutdown path) — clean up the
        // worktree we just created to avoid an untracked disk leak.
        logger.warn(
          `pool: repo ${repoPath} no longer in pool map — removing created worktree ${result.worktreePath}`,
        );
        try {
          removeWorktree(result.worktreePath);
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      logger.warn(`pool: failed to create entry for ${repoPath}: ${err}`);
    } finally {
      const current = this.inFlight.get(repoPath) ?? 1;
      this.inFlight.set(repoPath, Math.max(0, current - 1));
    }
  }
}
