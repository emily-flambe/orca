import { taskLifecycle } from "./workflows/task-lifecycle.js";
import { cleanupCronWorkflow } from "./workflows/cleanup.js";
import { reconcileStuckTasksWorkflow } from "./workflows/reconcile-stuck-tasks.js";
import { cronDispatchWorkflow } from "./workflows/cron-dispatch.js";
import { cronTaskLifecycle } from "./workflows/cron-task-lifecycle.js";
import { agentDispatchWorkflow } from "./workflows/agent-dispatch.js";
import { agentTaskLifecycle } from "./workflows/agent-task-lifecycle.js";

export const functions = [
  taskLifecycle,
  cleanupCronWorkflow,
  reconcileStuckTasksWorkflow,
  cronDispatchWorkflow,
  cronTaskLifecycle,
  agentDispatchWorkflow,
  agentTaskLifecycle,
];
