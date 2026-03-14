import { ciMergeWorkflow } from "./workflows/ci-merge.js";
import { deployMonitorWorkflow } from "./workflows/deploy-monitor.js";
import { cleanupCronWorkflow } from "./workflows/cleanup.js";

export const functions = [
  ciMergeWorkflow,
  deployMonitorWorkflow,
  cleanupCronWorkflow,
];
