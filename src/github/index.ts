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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find a PR for the given branch name.
 *
 * Uses `gh pr list --head <branch>` to check if a PR exists.
 * Returns info about the PR if found, or `{ exists: false }` otherwise.
 */
export function findPrForBranch(branchName: string, cwd: string): PrInfo {
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
  } catch {
    return { exists: false };
  }
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