import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  cleanupStaleResources,
  cleanupOldInvocationLogs,
} from "../../cleanup/index.js";
import { deleteOldCronRuns } from "../../db/queries.js";
import { sweepExitedHandles } from "../../session-handles.js";

export const cleanupCronWorkflow = inngest.createFunction(
  {
    id: "cleanup-cron",
    retries: 1,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    await step.run("cleanup", async () => {
      sweepExitedHandles();
      const { db, config, worktreePool } = getSchedulerDeps();
      worktreePool?.refresh();
      const pooledWorktreePaths =
        worktreePool?.getPooledPaths() ?? new Set<string>();
      cleanupStaleResources({ db, config, pooledWorktreePaths });
      cleanupOldInvocationLogs({ db, config });

      // Delete cron runs older than 7 days
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      deleteOldCronRuns(db, sevenDaysAgo);
    });
  },
);
