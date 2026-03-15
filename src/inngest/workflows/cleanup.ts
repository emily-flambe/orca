import { inngest } from "../client.js";
import { getSchedulerDeps } from "../deps.js";
import {
  cleanupStaleResources,
  cleanupOldInvocationLogs,
} from "../../cleanup/index.js";
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
      const { db, config } = getSchedulerDeps();
      cleanupStaleResources({ db, config });
      cleanupOldInvocationLogs({ db, config });
    });
  },
);
