import { execFileSync } from "node:child_process";

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