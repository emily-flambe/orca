// ---------------------------------------------------------------------------
// Startup backfill: populate pr_url and pr_state for tasks that have a
// pr_number but no pr_state (e.g. tasks created before this feature was added).
// Runs asynchronously at startup — failures are silently skipped.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, isNull } from "drizzle-orm";
import type { OrcaDb } from "./index.js";
import { tasks } from "./schema.js";
import { createLogger } from "../logger.js";

const logger = createLogger("db/backfill");
const execFileAsync = promisify(execFile);

type PrState = "draft" | "open" | "merged" | "closed";

function mapGhState(state: string, isDraft: boolean): PrState {
  if (isDraft && state === "OPEN") return "draft";
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "closed";
}

/**
 * For each task with prNumber != null and prState == null, query the GitHub API
 * to fetch the PR's current state and URL, then persist to DB.
 *
 * Runs in the background — does not block startup. Failures are skipped silently.
 */
export async function backfillPrState(db: OrcaDb): Promise<void> {
  let taskList: {
    linearIssueId: string;
    prNumber: number | null;
    repoPath: string;
  }[];
  try {
    taskList = db
      .select({
        linearIssueId: tasks.linearIssueId,
        prNumber: tasks.prNumber,
        repoPath: tasks.repoPath,
      })
      .from(tasks)
      .where(isNull(tasks.prState))
      .all()
      .filter((t) => t.prNumber != null);
  } catch (err) {
    logger.warn(`backfillPrState: failed to query tasks: ${err}`);
    return;
  }

  if (taskList.length === 0) return;

  logger.info(
    `backfillPrState: backfilling PR state for ${taskList.length} task(s)`,
  );

  for (const task of taskList) {
    if (task.prNumber == null) continue;
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", String(task.prNumber), "--json", "state,url,isDraft"],
        { cwd: task.repoPath, encoding: "utf-8" },
      );
      const data = JSON.parse(stdout.trim()) as {
        state?: string;
        url?: string;
        isDraft?: boolean;
      };
      if (!data.state || !data.url) continue;
      const prState = mapGhState(data.state, data.isDraft ?? false);
      db.update(tasks)
        .set({
          prUrl: data.url,
          prState,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(tasks.linearIssueId, task.linearIssueId))
        .run();
      logger.info(
        `backfillPrState: ${task.linearIssueId} PR #${task.prNumber} → ${prState}`,
      );
    } catch {
      // Skip on any error (PR deleted, repo gone, gh auth issues, etc.)
    }
  }
}
