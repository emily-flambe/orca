import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, copyFileSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { gitAsync, git, getDefaultBranchAsync } from "../git.js";
import { createWorktree, removeWorktreeAsync } from "./index.js";
import { createLogger } from "../logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("worktree/pool");

const DEFAULT_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface PoolEntry {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  createdAt: number;
}

/**
 * Run npm install asynchronously in the given directory.
 * Non-blocking — uses execFile instead of execFileSync.
 */
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
    // Best-effort: silently ignore errors
  }
}

/**
 * Run npm install in the pool worktree and any subdirectories, following the
 * same logic as createWorktree(): ORCA_EXTRA_INSTALL_DIRS or auto-discovery.
 */
async function installDepsAsync(worktreePath: string): Promise<void> {
  if (existsSync(join(worktreePath, "package.json"))) {
    await npmInstallAsync(worktreePath);
  }

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
    let entries;
    try {
      entries = readdirSync(worktreePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const subPath = join(worktreePath, entry.name);
      if (existsSync(join(subPath, "package.json"))) {
        await npmInstallAsync(subPath);
      }
    }
  }
}

/**
 * Create a single pool entry for the given repo path.
 * Uses gitAsync and npmInstallAsync so this is fully non-blocking.
 */
async function createPoolEntry(repoPath: string): Promise<PoolEntry> {
  const hex = randomBytes(4).toString("hex");
  const branchName = `orca/pool-${hex}`;
  const repoDirname = basename(repoPath);
  const parentDir = dirname(repoPath);
  const worktreePath = join(parentDir, `${repoDirname}-pool-${hex}`);

  // Fetch origin
  await gitAsync(["fetch", "origin"], { cwd: repoPath });

  // Detect default branch after fetch so refs are up to date
  const defaultBranch = await getDefaultBranchAsync(repoPath);

  // Create worktree with new branch at origin's default branch
  await gitAsync(
    [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      `origin/${defaultBranch}`,
    ],
    { cwd: repoPath },
  );

  // Copy .env* files from repo
  copyEnvFiles(repoPath, worktreePath);

  // Install deps (non-blocking)
  await installDepsAsync(worktreePath);

  return {
    repoPath,
    worktreePath,
    branchName,
    createdAt: Date.now(),
  };
}

export class WorktreePoolService {
  private readonly poolSize: number;
  private readonly freshnessThresholdMs: number;
  private readonly pools: Map<string, PoolEntry[]> = new Map();
  /** Tracks in-flight createPoolEntry() promises per repo to avoid over-creation. */
  private readonly inFlight: Map<string, number> = new Map();
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    poolSize: number,
    freshnessThresholdMs = DEFAULT_FRESHNESS_THRESHOLD_MS,
  ) {
    this.poolSize = poolSize;
    this.freshnessThresholdMs = freshnessThresholdMs;
  }

  /**
   * Start background pool initialization for the given repo paths. Non-blocking.
   */
  start(repoPaths: string[]): void {
    for (const repoPath of repoPaths) {
      if (!this.pools.has(repoPath)) {
        this.pools.set(repoPath, []);
      }
      this.replenish(repoPath);
    }

    this.intervalTimer = setInterval(() => {
      for (const repoPath of this.pools.keys()) {
        this.refreshStaleEntries(repoPath);
        this.replenish(repoPath);
      }
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Claim a worktree from the pool for an implement-phase task.
   * Falls back to createWorktree() if pool is empty or on any error.
   */
  claim(
    repoPath: string,
    taskId: string,
    invocationId: number | string,
  ): { worktreePath: string; branchName: string } {
    const pool = this.pools.get(repoPath) ?? [];
    const newBranchName = `orca/${taskId}-inv-${invocationId}`;
    const repoDirname = basename(repoPath);
    const parentDir = dirname(repoPath);
    const targetPath = join(parentDir, `${repoDirname}-${taskId}`);

    while (pool.length > 0) {
      const entry = pool.shift()!;

      // Verify the pool entry's directory still exists
      if (!existsSync(entry.worktreePath)) {
        logger.warn(
          `pool entry worktree no longer exists, skipping: ${entry.worktreePath}`,
        );
        continue;
      }

      try {
        // Rename the branch from orca/pool-<hex> to orca/<taskId>-inv-<invocationId>
        git(["branch", "-m", entry.branchName, newBranchName], {
          cwd: repoPath,
        });

        // Refresh .env* files from repo (may have changed since pool entry was created)
        copyEnvFiles(repoPath, entry.worktreePath);

        let finalWorktreePath = entry.worktreePath;

        // Rename the directory to the standard task worktree name
        if (existsSync(targetPath)) {
          // targetPath already in use (rare: same taskId running concurrently)
          // Use the pool path as-is — only branch was renamed
          logger.warn(
            `target path already exists (${targetPath}), using pool path: ${entry.worktreePath}`,
          );
        } else {
          try {
            renameSync(entry.worktreePath, targetPath);
            finalWorktreePath = targetPath;
            // Repair worktree reference after directory rename
            git(["worktree", "repair", finalWorktreePath], { cwd: repoPath });
          } catch (renameErr) {
            const code = (renameErr as NodeJS.ErrnoException).code;
            if (code === "EPERM" || code === "EBUSY") {
              // On Windows, EPERM can happen if a process still holds the dir.
              // Use the pool path as-is.
              logger.warn(
                `renameSync failed (${code}), using pool path: ${entry.worktreePath}`,
              );
            } else {
              throw renameErr;
            }
          }
        }

        logger.info(
          `pool claim successful for ${taskId}: ${finalWorktreePath} (branch: ${newBranchName})`,
        );

        // Trigger background replenishment to restore pool to target size
        this.replenish(repoPath);

        return { worktreePath: finalWorktreePath, branchName: newBranchName };
      } catch (err) {
        logger.warn(
          `pool claim failed for ${taskId}, attempting rollback: ${err}`,
        );
        // Attempt to roll back the branch rename
        try {
          git(["branch", "-m", newBranchName, entry.branchName], {
            cwd: repoPath,
          });
        } catch (rollbackErr) {
          logger.warn(`pool claim rollback failed: ${rollbackErr}`);
        }
        // Fall through to createWorktree
        break;
      }
    }

    // Pool empty or all entries failed — fall back to createWorktree()
    logger.info(
      `pool empty or claim failed for ${repoPath}, falling back to createWorktree()`,
    );
    return createWorktree(repoPath, taskId, invocationId);
  }

  /**
   * Number of available pool entries for a given repo.
   */
  size(repoPath: string): number {
    return this.pools.get(repoPath)?.length ?? 0;
  }

  /**
   * Stop the service and clean up all reserve worktrees.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    const removePromises: Promise<void>[] = [];
    for (const entries of this.pools.values()) {
      for (const entry of entries) {
        removePromises.push(
          removeWorktreeAsync(entry.worktreePath).catch((err) => {
            logger.warn(
              `failed to remove pool entry ${entry.worktreePath}: ${err}`,
            );
          }),
        );
      }
    }
    await Promise.allSettled(removePromises);
    this.pools.clear();
    this.inFlight.clear();
  }

  /**
   * Replenish the pool for a repo up to the target size. Non-blocking.
   * Accounts for in-flight createPoolEntry() promises to avoid over-creation.
   */
  private replenish(repoPath: string): void {
    if (this.stopped) return;

    const pool = this.pools.get(repoPath);
    if (!pool) return;

    const inFlight = this.inFlight.get(repoPath) ?? 0;
    const needed = this.poolSize - pool.length - inFlight;
    if (needed <= 0) return;

    this.inFlight.set(repoPath, inFlight + needed);

    for (let i = 0; i < needed; i++) {
      createPoolEntry(repoPath)
        .then((entry) => {
          this.inFlight.set(repoPath, (this.inFlight.get(repoPath) ?? 1) - 1);
          if (this.stopped) {
            // Cleanup entry that was created after stop()
            removeWorktreeAsync(entry.worktreePath).catch((err) => {
              logger.warn(
                `failed to remove post-stop pool entry ${entry.worktreePath}: ${err}`,
              );
            });
            return;
          }
          pool.push(entry);
          logger.info(
            `pool entry created for ${repoPath}: ${entry.worktreePath} (pool size: ${pool.length}/${this.poolSize})`,
          );
        })
        .catch((err) => {
          this.inFlight.set(repoPath, (this.inFlight.get(repoPath) ?? 1) - 1);
          logger.warn(`failed to create pool entry for ${repoPath}: ${err}`);
        });
    }
  }

  /**
   * Refresh stale pool entries (older than freshnessThresholdMs) by
   * fetching origin and hard-resetting to origin's default branch.
   */
  private refreshStaleEntries(repoPath: string): void {
    if (this.stopped) return;

    const pool = this.pools.get(repoPath);
    if (!pool) return;

    const now = Date.now();
    for (const entry of pool) {
      if (now - entry.createdAt < this.freshnessThresholdMs) continue;

      gitAsync(["fetch", "origin"], { cwd: entry.worktreePath })
        .then(async () => {
          const defaultBranch = await getDefaultBranchAsync(repoPath);
          await gitAsync(["reset", "--hard", `origin/${defaultBranch}`], {
            cwd: entry.worktreePath,
          });
        })
        .then(() => {
          entry.createdAt = Date.now();
          logger.info(`refreshed stale pool entry: ${entry.worktreePath}`);
        })
        .catch((err) => {
          logger.warn(
            `failed to refresh pool entry ${entry.worktreePath}: ${err}`,
          );
        });
    }
  }
}

/**
 * Create a WorktreePoolService with the given pool size.
 */
export function createWorktreePool(poolSize: number): WorktreePoolService {
  return new WorktreePoolService(poolSize);
}
