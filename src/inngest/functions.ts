import { taskLifecycle } from "./workflows/task-lifecycle.js";
import { ciMergeWorkflow } from "./workflows/ci-merge.js";
import { deployMonitorWorkflow } from "./workflows/deploy-monitor.js";
import { cleanupCronWorkflow } from "./workflows/cleanup.js";
import { stuckTaskReconciliationWorkflow } from "./workflows/reconciliation.js";

export const functions = [
  taskLifecycle,
  ciMergeWorkflow,
  deployMonitorWorkflow,
  cleanupCronWorkflow,
  stuckTaskReconciliationWorkflow,
];
