import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  cleanupStaleResourcesAsync,
  cleanupOldInvocationLogs,
} from "../../cleanup/index.js";
import { deleteOldCronRuns } from "../../db/queries.js";
import { sweepExitedHandles } from "../../session-handles.js";
import { getWorktreePool } from "../../worktree/pool.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("cleanup-cron");

export const cleanupCronWorkflow = inngest.createFunction(
  {
    id: "cleanup-cron",
    retries: 1,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("cleanup", async () => {
      sweepExitedHandles();
      const { db, config } = getSchedulerDeps();
      await cleanupStaleResourcesAsync({ db, config });
      cleanupOldInvocationLogs({ db, config });

      // Delete cron runs older than 7 days
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      deleteOldCronRuns(db, sevenDaysAgo);

      // Refresh stale worktree pool reserves
      const pool = getWorktreePool();
      if (pool) {
        await pool.refreshStale().catch((err) => {
          logger.warn(`[orca/cleanup-cron] pool refreshStale failed: ${err}`);
        });
      }
    });
  },
);
