/**
 * Shared utilities used across Inngest workflows.
 * Extracted from task-lifecycle.ts to avoid duplication.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git.js";

// ---------------------------------------------------------------------------
// alreadyDonePatterns — patterns in output summary indicating task is complete
// ---------------------------------------------------------------------------

/**
 * Patterns in the output summary that indicate the task was already done
 * (no changes needed). Merged from task-lifecycle.ts and verify-pr.ts.
 */
export const alreadyDonePatterns: string[] = [
  "already complete",
  "already implemented",
  "already merged",
  "already on main",
  "already on `main`",
  "already on `origin/main`",
  "already exists",
  "already satisfied",
  "already done",
  "nothing to do",
  "no changes needed",
  "acceptance criteria",
];

// ---------------------------------------------------------------------------
// extractMarkerFromLog — scan NDJSON session log for REVIEW_RESULT marker
// ---------------------------------------------------------------------------

/**
 * Scans the NDJSON session log for a REVIEW_RESULT marker in assistant messages.
 *
 * Returns "APPROVED", "CHANGES_REQUESTED", or null if no marker is found.
 */
export async function extractMarkerFromLog(
  invocationId: number,
): Promise<"APPROVED" | "CHANGES_REQUESTED" | null> {
  try {
    const logPath = join(process.cwd(), "logs", `${invocationId}.ndjson`);
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "assistant") continue;
        const message = msg.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            if (b.text.includes("REVIEW_RESULT:APPROVED")) return "APPROVED";
            if (b.text.includes("REVIEW_RESULT:CHANGES_REQUESTED"))
              return "CHANGES_REQUESTED";
          }
        }
      } catch {
        /* malformed line — skip */
      }
    }
  } catch {
    /* log unreadable — skip */
  }
  return null;
}

// ---------------------------------------------------------------------------
// worktreeHasNoChanges — check if worktree has no commits ahead of origin/main
// ---------------------------------------------------------------------------

/**
 * Returns true if the worktree at `worktreePath` has no commits ahead of
 * `origin/main`. Used to detect "already done" tasks where Claude succeeded
 * but made no changes (because none were needed).
 */
export async function worktreeHasNoChanges(
  worktreePath: string,
): Promise<boolean> {
  try {
    if (!existsSync(worktreePath)) return false;
    const diff = git(["diff", "origin/main...HEAD"], { cwd: worktreePath });
    return diff.trim() === "";
  } catch {
    return false;
  }
}
