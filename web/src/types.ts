export {
  CRON_TYPES,
  type CronType,
  TASK_TYPES,
  type TaskType,
  TASK_STATUSES,
  type TaskStatus,
  INVOCATION_STATUSES,
  type InvocationStatus,
  type Task,
  type CronSchedule,
  type CronRun,
  type Invocation,
  type TaskWithInvocations,
  type OrcaStatus,
  type FailedTaskSummary,
} from "../../src/shared/types.ts";

export interface InngestWorkflow {
  id: string;
  name: string;
  slug: string;
  triggers: Array<{ type: string; value: string }>;
  recentRuns: Array<{
    id: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  }>;
  stats: { total: number; completed: number; failed: number };
}
