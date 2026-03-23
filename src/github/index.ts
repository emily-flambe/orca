import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, basename } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { isTransientGitError, git } from "../git.js";
import { createLogger } from "../logger.js";

const logger = createLogger("github");

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrInfo {
  exists: boolean;
  url?: string;
  number?: number;
  merged?: boolean;
  headBranch?: string;
  /** Normalized PR state: draft | open | merged | closed */
  state?: "draft" | "open" | "merged" | "closed";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gh(args: string[], options?: { cwd?: string }): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const stderr = execErr.stderr?.trim() ?? "";
    const detail = stderr || execErr.message || "unknown error";
    throw new Error(`gh command failed: gh ${args.join(" ")}\n${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find a PR for the given branch name.
 *
 * Uses `gh pr list --head <branch>` to check if a PR exists.
 * Retries up to `maxAttempts` times with backoff to handle transient
 * CLI failures (e.g. Windows DLL init errors).
 * Returns info about the PR if found, or `{ exists: false }` otherwise.
 */
export async function findPrForBranch(
  branchName: string,
  cwd: string,
  maxAttempts = 3,
): Promise<PrInfo> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = gh(
        [
          "pr",
          "list",
          "--head",
          branchName,
          "--json",
          "url,number,state,headRefName,isDraft",
          "--limit",
          "1",
        ],
        { cwd },
      );

      const prs = JSON.parse(output) as {
        url: string;
        number: number;
        state: string;
        headRefName: string;
        isDraft: boolean;
      }[];
      if (prs.length > 0) {
        const pr = prs[0]!;
        const prState: PrInfo["state"] =
          pr.isDraft && pr.state === "OPEN"
            ? "draft"
            : pr.state === "OPEN"
              ? "open"
              : pr.state === "MERGED"
                ? "merged"
                : "closed";
        return {
          exists: true,
          url: pr.url,
          number: pr.number,
          merged: pr.state === "MERGED",
          headBranch: pr.headRefName,
          state: prState,
        };
      }
      // Empty result — may be GitHub API lag. Retry with backoff.
      logger.warn(
        `findPrForBranch: no PR found for ${branchName} ` +
          `(attempt ${attempt}/${maxAttempts}), retrying...`,
      );
      if (attempt < maxAttempts) {
        await sleep(attempt * 5000);
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `findPrForBranch failed for ${branchName} ` +
          `(attempt ${attempt}/${maxAttempts}): ${msg}`,
      );
      if (attempt < maxAttempts) {
        await sleep(attempt * 2000);
      }
    }
  }
  if (lastError) {
    const msg =
      lastError instanceof Error ? lastError.message : String(lastError);
    logger.error(
      `findPrForBranch exhausted ${maxAttempts} attempts for ${branchName}: ${msg}`,
    );
  }
  return { exists: false };
}

/**
 * Verify a PR exists by its URL.
 *
 * Uses `gh pr view <url> --json url,number,state` to confirm the PR.
 * Returns PrInfo if found, or `{ exists: false }` if not.
 */
export function findPrByUrl(prUrl: string, cwd: string): PrInfo {
  try {
    const output = gh(
      ["pr", "view", prUrl, "--json", "url,number,state,headRefName,isDraft"],
      {
        cwd,
      },
    );
    const data = JSON.parse(output) as {
      url?: string;
      number?: number;
      state?: string;
      headRefName?: string;
      isDraft?: boolean;
    };
    if (typeof data.number !== "number" || typeof data.url !== "string") {
      logger.warn(
        `findPrByUrl: missing url or number in response for ${prUrl}`,
      );
      return { exists: false };
    }
    const prState: PrInfo["state"] =
      data.isDraft && data.state === "OPEN"
        ? "draft"
        : data.state === "OPEN"
          ? "open"
          : data.state === "MERGED"
            ? "merged"
            : "closed";
    return {
      exists: true,
      url: data.url,
      number: data.number,
      merged: data.state === "MERGED",
      headBranch: data.headRefName,
      state: prState,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`findPrByUrl failed for ${prUrl}: ${msg}`);
    return { exists: false };
  }
}

/**
 * List branch names that have open PRs in the given repo.
 *
 * Uses a single `gh pr list --state open` call and returns a Set of
 * headRefName values. Returns an empty set on error (best-effort).
 */
export function listOpenPrBranches(cwd: string): Set<string> {
  try {
    const output = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "headRefName",
        "--limit",
        "200",
      ],
      { cwd },
    );
    const prs = JSON.parse(output) as { headRefName: string }[];
    return new Set(prs.map((pr) => pr.headRefName));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`listOpenPrBranches failed: ${msg}`);
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Async helpers for deploy monitoring
// ---------------------------------------------------------------------------

async function ghAsync(
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      encoding: "utf-8",
      cwd: options?.cwd,
    });
    return stdout.trim();
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const stderr = (execErr.stderr ?? "").trim();
    const detail = stderr || execErr.message || "unknown error";
    throw new Error(`gh command failed: gh ${args.join(" ")}\n${detail}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the merge commit SHA for a PR by number.
 * Retries up to 3 times with 2s delay (merge is async on GitHub's side).
 */
export async function getMergeCommitSha(
  prNumber: number,
  cwd: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await ghAsync(
        ["pr", "view", String(prNumber), "--json", "mergeCommit"],
        { cwd },
      );
      const data = JSON.parse(output) as { mergeCommit?: { oid?: string } };
      if (data.mergeCommit?.oid) {
        return data.mergeCommit.oid;
      }
    } catch {
      // gh may fail if PR not found — retry
    }
    if (attempt < 2) await sleep(2000);
  }
  return null;
}

/**
 * Close a PR by number, adding a comment and deleting the remote branch.
 * Returns true on success, false on failure.
 */
export function closePr(prNumber: number, cwd: string): boolean {
  try {
    gh(
      [
        "pr",
        "close",
        String(prNumber),
        "--delete-branch",
        "--comment",
        "Closed by Orca cleanup: orphaned PR with no running invocation or active task.",
      ],
      { cwd },
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`closePr(#${prNumber}) failed: ${msg}`);
    return false;
  }
}

/**
 * Close all open PRs for a Linear issue that are superseded by a newer PR.
 *
 * Finds all open PRs whose branch matches `orca/<taskId>-*`, excluding the
 * new PR's own branch. Closes each with a comment linking to the new PR and
 * deletes the remote branch. Returns the number of PRs closed.
 */
export function closeSupersededPrs(
  taskId: string,
  newPrNumber: number,
  newInvocationId: number,
  newBranchName: string,
  cwd: string,
  comment?: string,
): number {
  let prs: { headRefName: string; number: number }[];
  try {
    const output = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "headRefName,number",
        "--limit",
        "200",
      ],
      { cwd },
    );
    prs = JSON.parse(output) as { headRefName: string; number: number }[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`closeSupersededPrs: failed to list PRs for ${taskId}: ${msg}`);
    return 0;
  }

  const prefix = `orca/${taskId}-`;
  let closed = 0;
  for (const pr of prs) {
    if (!pr.headRefName.startsWith(prefix)) continue;
    if (pr.headRefName === newBranchName) continue;
    try {
      gh(
        [
          "pr",
          "close",
          String(pr.number),
          "--delete-branch",
          "--comment",
          comment ??
            `Superseded by PR #${newPrNumber} (invocation #${newInvocationId}).`,
        ],
        { cwd },
      );
      logger.info(
        `closed superseded PR #${pr.number} (branch: ${pr.headRefName}) for task ${taskId}`,
      );
      closed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `closeSupersededPrs: failed to close PR #${pr.number}: ${msg}`,
      );
    }
  }
  return closed;
}

/**
 * Close all open PRs for a canceled Linear issue.
 *
 * Finds all open PRs on branches matching `orca/<taskId>-*` and closes each
 * with a comment explaining the Linear issue was canceled. Also deletes the
 * remote branch. Returns the number of PRs closed.
 */
export function closePrsForCanceledTask(taskId: string, cwd: string): number {
  let prs: { headRefName: string; number: number }[];
  try {
    const output = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "headRefName,number",
        "--limit",
        "200",
      ],
      { cwd },
    );
    prs = JSON.parse(output) as { headRefName: string; number: number }[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `closePrsForCanceledTask: failed to list PRs for ${taskId}: ${msg}`,
    );
    return 0;
  }

  const prefix = `orca/${taskId}-`;
  let closed = 0;
  for (const pr of prs) {
    if (!pr.headRefName.startsWith(prefix)) continue;
    try {
      gh(
        [
          "pr",
          "close",
          String(pr.number),
          "--delete-branch",
          "--comment",
          `Closed automatically: Linear issue ${taskId} was canceled.`,
        ],
        { cwd },
      );
      logger.info(
        `closed PR #${pr.number} (branch: ${pr.headRefName}) — Linear issue ${taskId} canceled`,
      );
      closed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `closePrsForCanceledTask: failed to close PR #${pr.number}: ${msg}`,
      );
    }
  }
  return closed;
}

/**
 * Close orphaned open PRs on `orca/*` branches.
 *
 * An orphan is an open PR whose head branch:
 * - Starts with `orca/`
 * - Is not in `runningBranches` or `activeBranches`
 * - Was last updated more than `maxAgeMs` ago
 *
 * Returns the number of PRs closed.
 */
export function closeOrphanedPrs(
  cwd: string,
  opts: {
    runningBranches: Set<string>;
    activeBranches: Set<string>;
    maxAgeMs: number;
    now: number;
  },
): number {
  let prs: { headRefName: string; number: number; updatedAt: string }[];
  try {
    const output = gh(
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "headRefName,number,updatedAt",
        "--limit",
        "200",
      ],
      { cwd },
    );
    prs = JSON.parse(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = isTransientGitError(err)
      ? " (transient, will retry next cycle)"
      : "";
    logger.warn(`closeOrphanedPrs: failed to list PRs${detail}: ${msg}`);
    return 0;
  }

  let closed = 0;
  for (const pr of prs) {
    if (!pr.headRefName.startsWith("orca/")) continue;
    if (opts.runningBranches.has(pr.headRefName)) continue;
    if (opts.activeBranches.has(pr.headRefName)) continue;

    const updatedMs = new Date(pr.updatedAt).getTime();
    if (Number.isNaN(updatedMs) || opts.now - updatedMs < opts.maxAgeMs)
      continue;

    if (closePr(pr.number, cwd)) {
      logger.info(
        `closed orphaned PR #${pr.number} (branch: ${pr.headRefName})`,
      );
      closed++;
    }
  }
  return closed;
}

export type PrCheckStatus =
  | "pending"
  | "success"
  | "failure"
  | "no_checks"
  | "error";

/**
 * Check CI check status on a PR by number.
 *
 * Uses `gh pr checks <number> --json name,state,bucket` to inspect check runs.
 * - Any pending/queued → "pending"
 * - Any fail → "failure"
 * - All pass/skipping → "success"
 * - CLI error after 2 attempts → "error"
 * - No checks → "no_checks"
 */
export async function getPrCheckStatus(
  prNumber: number,
  cwd: string,
): Promise<PrCheckStatus> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await ghAsync(
        ["pr", "checks", String(prNumber), "--json", "name,state,bucket"],
        { cwd },
      );
      const checks = JSON.parse(output) as {
        name: string;
        state: string;
        bucket: string;
      }[];

      if (checks.length === 0) return "no_checks";

      const hasPending = checks.some(
        (c) => c.bucket === "pending" || c.bucket === "queued",
      );
      if (hasPending) return "pending";

      const hasFail = checks.some((c) => c.bucket === "fail");
      if (hasFail) return "failure";

      return "success";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no checks reported/i.test(msg)) return "no_checks";
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  return "error";
}

/**
 * Synchronous version of getPrCheckStatus — uses execFileSync.
 * Returns "error" on any CLI error (no retry).
 */
export function getPrCheckStatusSync(
  prNumber: number,
  cwd: string,
): PrCheckStatus {
  try {
    const output = gh(
      ["pr", "checks", String(prNumber), "--json", "name,state,bucket"],
      { cwd },
    );
    const checks = JSON.parse(output) as {
      name: string;
      state: string;
      bucket: string;
    }[];

    if (checks.length === 0) return "no_checks";

    const hasPending = checks.some(
      (c) => c.bucket === "pending" || c.bucket === "queued",
    );
    if (hasPending) return "pending";

    const hasFail = checks.some((c) => c.bucket === "fail");
    if (hasFail) return "failure";

    return "success";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no checks reported/i.test(msg)) return "no_checks";
    return "error";
  }
}

/**
 * Merge a PR by number using squash merge and delete the branch.
 * Returns structured success/failure.
 */
export async function mergePr(
  prNumber: number,
  cwd: string,
): Promise<{ merged: true } | { merged: false; error: string }> {
  try {
    await ghAsync(
      ["pr", "merge", String(prNumber), "--squash", "--delete-branch"],
      { cwd },
    );
    return { merged: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { merged: false, error: message };
  }
}

export type PrMergeState = {
  mergeable: string; // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus: string; // "CLEAN" | "BEHIND" | "CONFLICTING" | "BLOCKED" | "UNKNOWN"
};

/**
 * Get the mergeable state and mergeStateStatus of a PR by number.
 * Returns { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } on failure.
 */
export async function getPrMergeState(
  prNumber: number,
  cwd: string,
): Promise<PrMergeState> {
  try {
    const output = await ghAsync(
      ["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus"],
      { cwd },
    );
    const data = JSON.parse(output) as {
      mergeable: string;
      mergeStateStatus: string;
    };
    return {
      mergeable: data.mergeable,
      mergeStateStatus: data.mergeStateStatus,
    };
  } catch {
    return { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
  }
}

/**
 * Update a PR branch to be up-to-date with its base branch using `gh pr update-branch`.
 * Returns true on success, false on failure.
 */
export async function updatePrBranch(
  prNumber: number,
  cwd: string,
): Promise<boolean> {
  try {
    await ghAsync(["pr", "update-branch", String(prNumber)], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebase a PR branch onto origin/main and force-push the result.
 *
 * Creates a temporary git worktree adjacent to the main repo, fetches
 * origin, checks out the branch at origin/<branchName>, rebases onto
 * origin/main, and force-pushes. Aborts on conflicts.
 *
 * Returns:
 *   { success: true } — rebase and push succeeded
 *   { success: false; hasConflicts: true } — rebase had merge conflicts
 *   { success: false; hasConflicts: false; error: string } — other failure
 */
export function rebasePrBranch(
  branchName: string,
  repoPath: string,
):
  | { success: true }
  | { success: false; hasConflicts: true }
  | { success: false; hasConflicts: false; error: string } {
  // Fetch latest so origin/main and origin/<branchName> are up to date
  try {
    git(["fetch", "origin"], { cwd: repoPath });
  } catch (err) {
    return {
      success: false,
      hasConflicts: false,
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Create a temp worktree adjacent to the main repo.
  // Include branchName in the path to avoid collisions when two tasks for the
  // same repo rebase simultaneously. Use / → - substitution for branch names
  // like "orca/EMI-123-inv-456".
  // --force lets us check out a branch already checked out in another worktree.
  const safeBranch = branchName.replace(/\//g, "-");
  const tempPath = `${dirname(repoPath)}/${basename(repoPath)}-rebase-${safeBranch}-${Date.now()}`;
  try {
    git(["worktree", "add", "--force", "--detach", tempPath], {
      cwd: repoPath,
    });
  } catch (err) {
    return {
      success: false,
      hasConflicts: false,
      error: `worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Helper to clean up the temp worktree. Falls back to rmSync + prune if
  // git worktree remove fails (e.g. Windows EPERM from antivirus locks).
  function cleanupTempWorktree(): void {
    try {
      git(["worktree", "remove", "--force", tempPath], { cwd: repoPath });
      return;
    } catch {
      // Fall through to rmSync fallback
    }
    try {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { recursive: true, force: true });
      }
      git(["worktree", "prune"], { cwd: repoPath });
    } catch {
      // Best-effort — stale worktree will be pruned on next scheduler tick
    }
  }

  try {
    // Check out the branch at its remote state (handles stale local refs)
    git(["checkout", "-B", branchName, `origin/${branchName}`], {
      cwd: tempPath,
    });
  } catch (err) {
    cleanupTempWorktree();
    return {
      success: false,
      hasConflicts: false,
      error: `checkout failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Attempt rebase onto origin/main
  try {
    git(["rebase", "origin/main"], { cwd: tempPath });
  } catch {
    // Abort the in-progress rebase to leave the worktree clean
    try {
      git(["rebase", "--abort"], { cwd: tempPath });
    } catch {
      // Ignore abort errors
    }
    cleanupTempWorktree();
    return { success: false, hasConflicts: true };
  }

  // Force-push the rebased branch
  try {
    git(["push", "--force-with-lease", "origin", branchName], {
      cwd: tempPath,
    });
  } catch (err) {
    cleanupTempWorktree();
    return {
      success: false,
      hasConflicts: false,
      error: `push failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  cleanupTempWorktree();
  return { success: true };
}

/**
 * Returns names of checks with bucket === "fail" for a given PR.
 * Returns [] on error.
 */
export async function getFailingCheckNames(
  prNumber: number,
  cwd: string,
): Promise<string[]> {
  try {
    const output = await ghAsync(
      ["pr", "checks", String(prNumber), "--json", "name,state,bucket"],
      { cwd },
    );
    const checks = JSON.parse(output) as {
      name: string;
      state: string;
      bucket: string;
    }[];
    return checks.filter((c) => c.bucket === "fail").map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Check if the same workflow failures exist on main, indicating a CI flake.
 * Returns true if it's a flake, false if it's a real failure or on any error.
 */
export async function isCiFlakeOnMain(
  failingCheckNames: string[],
  cwd: string,
): Promise<boolean> {
  if (failingCheckNames.length === 0) return false;
  try {
    const output = await ghAsync(
      [
        "run",
        "list",
        "--branch",
        "main",
        "--json",
        "name,conclusion",
        "--limit",
        "5",
      ],
      { cwd },
    );
    const runs = JSON.parse(output) as { name: string; conclusion: string }[];
    const failedMainWorkflows = new Set(
      runs.filter((r) => r.conclusion === "failure").map((r) => r.name),
    );
    if (failedMainWorkflows.size === 0) return false;

    for (const checkName of failingCheckNames) {
      const workflowName = checkName.includes(" / ")
        ? checkName.split(" / ")[0]!.trim()
        : checkName;
      if (
        failedMainWorkflows.has(workflowName) ||
        failedMainWorkflows.has(checkName)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export {
  enrichPrDescription,
  isWellStructuredPrBody,
} from "./pr-description.js";

export type WorkflowRunStatus =
  | "pending"
  | "in_progress"
  | "success"
  | "failure"
  | "no_runs";

/**
 * Check GitHub Actions workflow run status for a given commit SHA.
 */
export async function getWorkflowRunStatus(
  commitSha: string,
  cwd: string,
): Promise<WorkflowRunStatus> {
  try {
    const output = await ghAsync(
      [
        "run",
        "list",
        "--commit",
        commitSha,
        "--json",
        "status,conclusion",
        "--limit",
        "20",
      ],
      { cwd },
    );
    const runs = JSON.parse(output) as {
      status: string;
      conclusion: string | null;
    }[];

    if (runs.length === 0) return "no_runs";

    // If any run is still in progress or queued, overall is in_progress
    const hasInProgress = runs.some(
      (r) =>
        r.status === "in_progress" ||
        r.status === "queued" ||
        r.status === "waiting" ||
        r.status === "pending",
    );
    if (hasInProgress) return "in_progress";

    // All runs completed — check conclusions
    const hasFailed = runs.some(
      (r) =>
        r.conclusion === "failure" ||
        r.conclusion === "cancelled" ||
        r.conclusion === "timed_out",
    );
    if (hasFailed) return "failure";

    // All completed with success/skipped/neutral
    return "success";
  } catch {
    // gh CLI error — treat as no runs (will retry)
    return "no_runs";
  }
}
