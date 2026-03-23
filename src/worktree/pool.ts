// ---------------------------------------------------------------------------
// WorktreePoolService — pre-warmed worktree pool for near-instant dispatch
//
// Creates pool reserves on startup so the implement phase doesn't block on
// git fetch + npm install at dispatch time. Each reserve is a git worktree
// branched from origin/main with node_modules pre-installed.
//
// Reserve naming:
//   Branch:  orca/pool-<8char-uuid>
//   Dir:     <repoDir>-pool-<8char-uuid>
//
// At claim time the reserve is renamed to the task worktree path and
// rebranched to the task's orca/<taskId>-inv-<invocationId> branch.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { gitAsync } from "../git.js";
import { removeWorktreeAsync } from "./index.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);

const logger = createLogger("worktree-pool");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PoolReserve {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers (inline from worktree/index.ts — those are not exported)
// ---------------------------------------------------------------------------

function copyEnvFiles(srcDir: string, destDir: string): void {
  try {
    const entries = readdirSync(srcDir);
    for (const entry of entries) {
      if (entry.startsWith(".env")) {
        copyFileSync(join(srcDir, entry), join(destDir, entry));
      }
    }
  } catch {
    // Best-effort: silently ignore if srcDir is unreadable
  }
}

async function npmInstallAsync(cwd: string): Promise<void> {
  try {
    await execFileAsync("npm", ["install"], {
      encoding: "utf-8",
      cwd,
      shell: true,
    });
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const stderr = execErr.stderr?.trim() ?? "";
    const detail = stderr || execErr.message || "unknown error";
    throw new Error(`npm install failed in ${cwd}\n${detail}`);
  }
}

function generatePoolId(): string {
  return randomBytes(4).toString("hex"); // 8 hex chars
}

// ---------------------------------------------------------------------------
// WorktreePoolService
// ---------------------------------------------------------------------------

export class WorktreePoolService {
  /** Per-repo list of warm reserves. */
  private reserves = new Map<string, PoolReserve[]>();
  /** Per-repo filling lock — prevents concurrent fill operations. */
  private filling = new Set<string>();
  /** Max reserves to maintain per repo. */
  private poolSize: number;
  /** Age threshold for stale reserve refresh (1 hour). */
  private readonly STALE_AGE_MS = 60 * 60 * 1000;

  constructor(poolSize: number) {
    this.poolSize = poolSize;
  }

  /**
   * Kick off background pool fill for the given repo paths. Non-blocking.
   */
  startFilling(repoPaths: string[]): void {
    for (const repoPath of repoPaths) {
      if (!this.reserves.has(repoPath)) {
        this.reserves.set(repoPath, []);
      }
      void this.fillRepo(repoPath).catch((err) => {
        logger.warn(`[orca/worktree-pool] fill failed for ${repoPath}: ${err}`);
      });
    }
  }

  /**
   * Claim a reserve for the given task. Returns the new worktree path and
   * branch name on success, or null if no reserve is available (caller falls
   * back to synchronous createWorktree).
   */
  async claim(
    repoPath: string,
    taskId: string,
    invocationId: number,
  ): Promise<{ worktreePath: string; branchName: string } | null> {
    const reserves = this.reserves.get(repoPath);
    if (!reserves || reserves.length === 0) {
      logger.info(
        `[orca/worktree-pool] no reserve available for ${repoPath} — falling back`,
      );
      return null;
    }

    const reserve = reserves.shift()!;

    const repoDirname = basename(repoPath);
    const parentDir = dirname(repoPath);
    const taskPath = join(parentDir, `${repoDirname}-${taskId}`);
    const newBranch = `orca/${taskId}-inv-${invocationId}`;

    // If target path already exists (retry scenario), return null
    if (existsSync(taskPath)) {
      logger.info(
        `[orca/worktree-pool] target path already exists: ${taskPath} — falling back`,
      );
      // Put reserve back (it's still usable)
      reserves.unshift(reserve);
      return null;
    }

    try {
      // Move the worktree directory (git handles metadata update)
      await gitAsync(["worktree", "move", reserve.worktreePath, taskPath], {
        cwd: repoPath,
      });

      // Create new branch from current HEAD (origin/main)
      await gitAsync(["checkout", "-b", newBranch], { cwd: taskPath });

      // Delete the pool branch (no longer needed)
      await gitAsync(["branch", "-D", reserve.branchName], { cwd: taskPath });

      logger.info(
        `[orca/worktree-pool] claimed reserve ${reserve.worktreePath} -> ${taskPath} (branch: ${newBranch})`,
      );

      // Trigger background replenishment
      void this.fillRepo(repoPath).catch((err) => {
        logger.warn(
          `[orca/worktree-pool] replenish failed for ${repoPath}: ${err}`,
        );
      });

      return { worktreePath: taskPath, branchName: newBranch };
    } catch (err) {
      // Claim failed — discard the reserve async, trigger fill, return null
      logger.warn(
        `[orca/worktree-pool] claim failed for ${reserve.worktreePath}: ${err} — discarding reserve`,
      );
      void removeWorktreeAsync(reserve.worktreePath).catch(() => {});
      void this.fillRepo(repoPath).catch(() => {});
      return null;
    }
  }

  /**
   * Refresh reserves older than 1 hour by rebasing them to origin/main.
   */
  async refreshStale(): Promise<void> {
    const now = Date.now();

    for (const [_repoPath, reserves] of this.reserves) {
      const staleIndices: number[] = [];

      for (let i = 0; i < reserves.length; i++) {
        if (now - reserves[i]!.createdAt > this.STALE_AGE_MS) {
          staleIndices.push(i);
        }
      }

      // Process in reverse so splice indices remain valid
      for (const i of staleIndices.reverse()) {
        const reserve = reserves[i]!;
        try {
          await gitAsync(["fetch", "origin"], {
            cwd: reserve.worktreePath,
          });
          await gitAsync(["reset", "--hard", "origin/main"], {
            cwd: reserve.worktreePath,
          });
          reserve.createdAt = Date.now();
          logger.info(
            `[orca/worktree-pool] refreshed stale reserve: ${reserve.worktreePath}`,
          );
        } catch (err) {
          logger.warn(
            `[orca/worktree-pool] failed to refresh reserve ${reserve.worktreePath}: ${err} — removing`,
          );
          reserves.splice(i, 1);
          void removeWorktreeAsync(reserve.worktreePath).catch(() => {});
        }
      }
    }
  }

  /**
   * Return the set of all reserve worktree paths (for cleanup exclusion).
   */
  getReservePaths(): Set<string> {
    const paths = new Set<string>();
    for (const reserves of this.reserves.values()) {
      for (const r of reserves) {
        paths.add(r.worktreePath);
      }
    }
    return paths;
  }

  /**
   * Remove all reserves (for graceful shutdown).
   */
  async destroy(): Promise<void> {
    for (const reserves of this.reserves.values()) {
      for (const reserve of reserves) {
        try {
          await removeWorktreeAsync(reserve.worktreePath);
        } catch {
          // Best-effort
        }
      }
    }
    this.reserves.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fillRepo(repoPath: string): Promise<void> {
    // Only one fill per repo at a time
    if (this.filling.has(repoPath)) return;
    this.filling.add(repoPath);

    try {
      const reserves = this.reserves.get(repoPath) ?? [];
      const needed = this.poolSize - reserves.length;

      if (needed <= 0) return;

      logger.info(
        `[orca/worktree-pool] filling ${needed} reserve(s) for ${repoPath}`,
      );

      // Create reserves one at a time to avoid git lock contention
      for (let i = 0; i < needed; i++) {
        try {
          const reserve = await this.createReserve(repoPath);
          reserves.push(reserve);
          this.reserves.set(repoPath, reserves);
          logger.info(
            `[orca/worktree-pool] created reserve: ${reserve.worktreePath}`,
          );
        } catch (err) {
          logger.warn(
            `[orca/worktree-pool] failed to create reserve for ${repoPath}: ${err}`,
          );
          // Stop on error to avoid spamming
          break;
        }
      }
    } finally {
      this.filling.delete(repoPath);
    }
  }

  private async createReserve(repoPath: string): Promise<PoolReserve> {
    const poolId = generatePoolId();
    const branchName = `orca/pool-${poolId}`;
    const repoDirname = basename(repoPath);
    const parentDir = dirname(repoPath);
    const worktreePath = join(parentDir, `${repoDirname}-pool-${poolId}`);

    // Fetch latest from origin
    await gitAsync(["fetch", "origin"], { cwd: repoPath });

    // Create worktree branched from origin/main
    await gitAsync(
      ["worktree", "add", "-b", branchName, worktreePath, "origin/main"],
      { cwd: repoPath },
    );

    // Copy .env files from base repo
    copyEnvFiles(repoPath, worktreePath);

    // Run npm install for root package.json
    if (existsSync(join(worktreePath, "package.json"))) {
      await npmInstallAsync(worktreePath);
    }

    // Install nested package.json files (same logic as createWorktree)
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
      let entries: { isDirectory(): boolean; name: string }[] = [];
      try {
        entries = readdirSync(worktreePath, { withFileTypes: true });
      } catch {
        // Ignore if worktree dir is unreadable
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        const subPath = join(worktreePath, entry.name);
        if (existsSync(join(subPath, "package.json"))) {
          await npmInstallAsync(subPath);
        }
      }
    }

    return {
      repoPath,
      worktreePath,
      branchName,
      createdAt: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _pool: WorktreePoolService | null = null;

/**
 * Initialize the worktree pool singleton. Call once at startup.
 * Returns the created service instance.
 */
export function initWorktreePool(poolSize: number): WorktreePoolService {
  _pool = new WorktreePoolService(poolSize);
  return _pool;
}

/**
 * Get the worktree pool singleton. Returns null if not initialized
 * (pool disabled or startup hasn't run yet).
 */
export function getWorktreePool(): WorktreePoolService | null {
  return _pool;
}
