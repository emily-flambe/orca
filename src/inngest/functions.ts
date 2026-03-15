import { taskLifecycle } from "./workflows/task-lifecycle.js";
import { ciMergeWorkflow } from "./workflows/ci-merge.js";
import { deployMonitorWorkflow } from "./workflows/deploy-monitor.js";
import { cleanupCronWorkflow } from "./workflows/cleanup.js";
import { reconcileStuckTasksWorkflow } from "./workflows/reconcile-stuck-tasks.js";
import { cronDispatchWorkflow } from "./workflows/cron-dispatch.js";

export const functions = [
  taskLifecycle,
  ciMergeWorkflow,
  deployMonitorWorkflow,
  cleanupCronWorkflow,
  reconcileStuckTasksWorkflow,
  cronDispatchWorkflow,
];
