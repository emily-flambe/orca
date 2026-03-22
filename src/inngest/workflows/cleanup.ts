import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  cleanupStaleResourcesAsync,
  cleanupOldInvocationLogs,
} from "../../cleanup/index.js";
import { deleteOldCronRuns, getAllTasks } from "../../db/queries.js";
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
      await cleanupStaleResourcesAsync({ db, config }, worktreePool);
      cleanupOldInvocationLogs({ db, config });

      // Refresh stale pool entries for each known repo
      if (worktreePool) {
        const repoPaths = [...new Set(getAllTasks(db).map((t) => t.repoPath))];
        const oneHour = 60 * 60 * 1000;
        for (const repoPath of repoPaths) {
          await worktreePool.refreshStale(repoPath, oneHour);
        }
      }

      // Delete cron runs older than 7 days
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      deleteOldCronRuns(db, sevenDaysAgo);
    });
  },
);
