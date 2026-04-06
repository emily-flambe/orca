import { taskLifecycle } from "./workflows/task-lifecycle.js";
import { cleanupCronWorkflow } from "./workflows/cleanup.js";
import { reconcileStuckTasksWorkflow } from "./workflows/reconcile-stuck-tasks.js";
import { scheduledDispatchWorkflow } from "./workflows/scheduled-dispatch.js";
import { agentTaskLifecycle } from "./workflows/agent-task-lifecycle.js";

export const functions = [
  taskLifecycle,
  cleanupCronWorkflow,
  reconcileStuckTasksWorkflow,
  scheduledDispatchWorkflow,
  agentTaskLifecycle,
];
