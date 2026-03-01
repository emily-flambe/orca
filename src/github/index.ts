import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrInfo {
  exists: boolean;
  url?: string;
  number?: number;
  merged?: boolean;
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

/**
 * Synchronous sleep for retry backoff.
 */
function sleepSyncMs(ms: number): void {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* fallback spin */
    }
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
export function findPrForBranch(
  branchName: string,
  cwd: string,
  maxAttempts = 3,
): PrInfo {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = gh(
        ["pr", "list", "--head", branchName, "--json", "url,number,state", "--limit", "1"],
        { cwd },
      );

      const prs = JSON.parse(output) as { url: string; number: number; state: string }[];
      if (prs.length === 0) {
        return { exists: false };
      }

      const pr = prs[0]!;
      return {
        exists: true,
        url: pr.url,
        number: pr.number,
        merged: pr.state === "MERGED",
      };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[orca/github] findPrForBranch failed for ${branchName} ` +
          `(attempt ${attempt}/${maxAttempts}): ${msg}`,
      );
      if (attempt < maxAttempts) {
        sleepSyncMs(attempt * 2000);
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(
    `[orca/github] findPrForBranch exhausted ${maxAttempts} attempts for ${branchName}: ${msg}`,
  );
  return { exists: false };
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
      ["pr", "list", "--state", "open", "--json", "headRefName", "--limit", "200"],
      { cwd },
    );
    const prs = JSON.parse(output) as { headRefName: string }[];
    return new Set(prs.map((pr) => pr.headRefName));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orca/github] listOpenPrBranches failed: ${msg}`);
    return new Set();
  }
}

/**
 * Close older open PRs for the same task that have been superseded by a new attempt.
 *
 * Searches for open PRs whose branch matches `orca/<taskId>-inv-*`, filters out
 * the current PR, and closes the rest with a comment. Best-effort: never throws,
 * always returns results (possibly partial on individual PR close failures).
 */
export function closeSupersededPrs(
  taskId: string,
  currentPrNumber: number,
  cwd: string,
): { number: number; branch: string }[] {
  const closed: { number: number; branch: string }[] = [];
  const branchPrefix = `orca/${taskId}-inv-`;

  // Find all open PRs whose branch starts with orca/<taskId>-
  let prs: { number: number; headRefName: string }[];
  try {
    const output = gh(
      ["pr", "list", "--state", "open", "--search", `orca/${taskId}-`, "--json", "number,headRefName", "--limit", "50"],
      { cwd },
    );
    prs = JSON.parse(output) as { number: number; headRefName: string }[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[orca/github] closeSupersededPrs: failed to list PRs for ${taskId}: ${msg}`);
    return closed;
  }

  // Filter to only branches matching orca/<taskId>-inv-*, excluding current PR
  const superseded = prs.filter(
    (pr) => pr.headRefName?.startsWith(branchPrefix) && pr.number !== currentPrNumber,
  );

  for (const pr of superseded) {
    try {
      // Close first, then comment — avoids orphaned "Superseded" comments if close fails
      gh(["pr", "close", String(pr.number), "--delete-branch"], { cwd });
      gh(["pr", "comment", String(pr.number), "--body", `Superseded by #${currentPrNumber}`], { cwd });
      closed.push({ number: pr.number, branch: pr.headRefName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orca/github] closeSupersededPrs: failed to close PR #${pr.number}: ${msg}`);
    }
  }

  return closed;
}

// ---------------------------------------------------------------------------
// Async helpers for deploy monitoring
// ---------------------------------------------------------------------------

async function ghAsync(args: string[], options?: { cwd?: string }): Promise<string> {
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

export type PrCheckStatus = "pending" | "success" | "failure" | "no_checks";

/**
 * Check CI check status on a PR by number.
 *
 * Uses `gh pr checks <number> --json name,state,bucket` to inspect check runs.
 * - Any pending/queued → "pending"
 * - Any fail → "failure"
 * - All pass/skipping → "success"
 * - CLI error or no checks → "no_checks"
 */
export async function getPrCheckStatus(
  prNumber: number,
  cwd: string,
): Promise<PrCheckStatus> {
  try {
    const output = await ghAsync(
      ["pr", "checks", String(prNumber), "--json", "name,state,bucket"],
      { cwd },
    );
    const checks = JSON.parse(output) as { name: string; state: string; bucket: string }[];

    if (checks.length === 0) return "no_checks";

    const hasPending = checks.some(
      (c) => c.bucket === "pending" || c.bucket === "queued",
    );
    if (hasPending) return "pending";

    const hasFail = checks.some((c) => c.bucket === "fail");
    if (hasFail) return "failure";

    return "success";
  } catch {
    return "no_checks";
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
      ["run", "list", "--commit", commitSha, "--json", "status,conclusion", "--limit", "20"],
      { cwd },
    );
    const runs = JSON.parse(output) as { status: string; conclusion: string | null }[];

    if (runs.length === 0) return "no_runs";

    // If any run is still in progress or queued, overall is in_progress
    const hasInProgress = runs.some(
      (r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting" || r.status === "pending",
    );
    if (hasInProgress) return "in_progress";

    // All runs completed — check conclusions
    const hasFailed = runs.some(
      (r) => r.conclusion === "failure" || r.conclusion === "cancelled" || r.conclusion === "timed_out",
    );
    if (hasFailed) return "failure";

    // All completed with success/skipped/neutral
    return "success";
  } catch {
    // gh CLI error — treat as no runs (will retry)
    return "no_runs";
  }
}
