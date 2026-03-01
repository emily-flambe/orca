import { eq, gte, asc, desc, sql, count, sum, inArray, and, isNotNull } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import {
  tasks,
  invocations,
  budgetEvents,
  type TaskStatus,
} from "./schema.js";
import type { OrcaDb } from "./index.js";

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------
type NewTask = InferInsertModel<typeof tasks>;
type Task = typeof tasks.$inferSelect;

// ---------------------------------------------------------------------------
// Task queries
// ---------------------------------------------------------------------------

/** Insert a new task. Caller must supply all required fields. */
export function insertTask(db: OrcaDb, task: NewTask): void {
  db.insert(tasks).values(task).run();
}

/** Update a task's orca_status and set updated_at to now. */
export function updateTaskStatus(
  db: OrcaDb,
  taskId: string,
  status: TaskStatus,
): void {
  db.update(tasks)
    .set({
      orcaStatus: status,
      doneAt: status === "done" ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Increment retry_count by 1 and reset status to the given value (default "ready"). */
export function incrementRetryCount(
  db: OrcaDb,
  taskId: string,
  resetStatus: TaskStatus = "ready",
): void {
  db.update(tasks)
    .set({
      retryCount: sql`${tasks.retryCount} + 1`,
      orcaStatus: resetStatus,
      doneAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Get all tasks with orca_status="ready", ordered by priority ASC then created_at ASC. */
export function getReadyTasks(db: OrcaDb): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.orcaStatus, "ready"))
    .orderBy(asc(tasks.priority), asc(tasks.createdAt))
    .all();
}

/** Get tasks matching any of the given statuses, ordered by priority ASC then created_at ASC. */
export function getDispatchableTasks(db: OrcaDb, statuses: TaskStatus[]): Task[] {
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.orcaStatus, statuses))
    .orderBy(asc(tasks.priority), asc(tasks.createdAt))
    .all();
}

/** Set the PR branch name on a task. */
export function updateTaskPrBranch(db: OrcaDb, taskId: string, branchName: string): void {
  db.update(tasks)
    .set({ prBranchName: branchName, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Increment review_cycle_count by 1. */
export function incrementReviewCycleCount(db: OrcaDb, taskId: string): void {
  db.update(tasks)
    .set({
      reviewCycleCount: sql`${tasks.reviewCycleCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Get all tasks with orca_status="deploying". */
export function getDeployingTasks(db: OrcaDb): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.orcaStatus, "deploying"))
    .all();
}

/** Get all tasks with orca_status="awaiting_ci". */
export function getAwaitingCiTasks(db: OrcaDb): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.orcaStatus, "awaiting_ci"))
    .all();
}

/** Update CI tracking fields on a task. */
export function updateTaskCiInfo(
  db: OrcaDb,
  taskId: string,
  info: { ciStartedAt?: string | null },
): void {
  db.update(tasks)
    .set({ ...info, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Update deploy-related fields on a task. */
export function updateTaskDeployInfo(
  db: OrcaDb,
  taskId: string,
  info: { mergeCommitSha?: string | null; prNumber?: number | null; deployStartedAt?: string | null },
): void {
  db.update(tasks)
    .set({ ...info, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Get a single task by its linear_issue_id. */
export function getTask(db: OrcaDb, taskId: string): Task | undefined {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.linearIssueId, taskId))
    .get();
}

/** Get all tasks. */
export function getAllTasks(db: OrcaDb): Task[] {
  return db.select().from(tasks).all();
}

/** Get all child tasks for a given parent identifier. */
export function getChildTasks(db: OrcaDb, parentIdentifier: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentIdentifier, parentIdentifier))
    .all();
}

/** Get all parent tasks (isParent = 1). */
export function getParentTasks(db: OrcaDb): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.isParent, 1))
    .all();
}

/** Delete a task and its invocations/budget events by linear_issue_id. */
export function deleteTask(db: OrcaDb, taskId: string): void {
  // Delete budget events for this task's invocations first (FK chain)
  const taskInvocations = db.select({ id: invocations.id }).from(invocations)
    .where(eq(invocations.linearIssueId, taskId)).all();
  if (taskInvocations.length > 0) {
    const invIds = taskInvocations.map((i) => i.id);
    db.delete(budgetEvents).where(inArray(budgetEvents.invocationId, invIds)).run();
  }
  db.delete(invocations).where(eq(invocations.linearIssueId, taskId)).run();
  db.delete(tasks).where(eq(tasks.linearIssueId, taskId)).run();
}

/** Partial update of task fields (priority, status, etc.) by linear_issue_id. */
export function updateTaskFields(
  db: OrcaDb,
  taskId: string,
  updates: Partial<Omit<NewTask, "linearIssueId" | "createdAt">>,
): void {
  const setValues: Record<string, unknown> = { ...updates, updatedAt: new Date().toISOString() };

  // Automatically manage doneAt when orcaStatus is being updated
  if ("orcaStatus" in updates) {
    setValues.doneAt = updates.orcaStatus === "done" ? new Date().toISOString() : null;
  }

  db.update(tasks)
    .set(setValues as typeof updates & { updatedAt: string })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

// ---------------------------------------------------------------------------
// Invocation types
// ---------------------------------------------------------------------------
type NewInvocation = InferInsertModel<typeof invocations>;
type Invocation = typeof invocations.$inferSelect;

// Partial update type: all fields except id and linear_issue_id are optional
type InvocationUpdate = Partial<
  Omit<Invocation, "id" | "linearIssueId">
>;

// ---------------------------------------------------------------------------
// Invocation queries
// ---------------------------------------------------------------------------

/** Get a single invocation by its id. */
export function getInvocation(db: OrcaDb, id: number): Invocation | undefined {
  return db.select().from(invocations).where(eq(invocations.id, id)).get();
}

/** Count invocations with status="running". */
export function countActiveSessions(db: OrcaDb): number {
  const result = db
    .select({ value: count() })
    .from(invocations)
    .where(eq(invocations.status, "running"))
    .get();
  return result?.value ?? 0;
}

/** Insert a new invocation and return its auto-generated id. */
export function insertInvocation(db: OrcaDb, invocation: NewInvocation): number {
  const result = db
    .insert(invocations)
    .values(invocation)
    .returning({ id: invocations.id })
    .get();
  return result.id;
}

/** Partial update of an invocation by id. */
export function updateInvocation(
  db: OrcaDb,
  id: number,
  updates: InvocationUpdate,
): void {
  db.update(invocations)
    .set(updates)
    .where(eq(invocations.id, id))
    .run();
}

/** Get all invocations for a given task. */
export function getInvocationsByTask(
  db: OrcaDb,
  taskId: string,
): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(eq(invocations.linearIssueId, taskId))
    .all();
}

/**
 * Find the most recent invocation for a task where the agent hit max turns
 * during the implement phase and has a valid session ID and worktree path.
 * Used to determine if a retry can resume the previous session.
 */
export function getLastMaxTurnsInvocation(
  db: OrcaDb,
  taskId: string,
): Invocation | undefined {
  return db
    .select()
    .from(invocations)
    .where(
      and(
        eq(invocations.linearIssueId, taskId),
        eq(invocations.outputSummary, "max turns reached"),
        eq(invocations.phase, "implement"),
        isNotNull(invocations.sessionId),
        isNotNull(invocations.worktreePath),
      ),
    )
    .orderBy(desc(invocations.id))
    .limit(1)
    .get();
}

/** Get all invocations with status="running". */
export function getRunningInvocations(db: OrcaDb): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(eq(invocations.status, "running"))
    .all();
}

// ---------------------------------------------------------------------------
// Observability queries
// ---------------------------------------------------------------------------

/** Get aggregated invocation metrics summary via SQL (no full-table load). */
export function getMetricsSummary(db: OrcaDb) {
  // Status counts
  const statusRows = db
    .select({ status: invocations.status, cnt: count() })
    .from(invocations)
    .groupBy(invocations.status)
    .all();

  const statusMap: Record<string, number> = {};
  for (const row of statusRows) {
    statusMap[row.status] = row.cnt;
  }

  const completed = statusMap["completed"] ?? 0;
  const failed = statusMap["failed"] ?? 0;
  const timedOut = statusMap["timed_out"] ?? 0;
  const running = statusMap["running"] ?? 0;
  const total = completed + failed + timedOut + running;
  const finished = completed + failed + timedOut;

  // Cost stats
  const costRow = db
    .select({
      totalCost: sum(invocations.costUsd),
      costCount: count(),
    })
    .from(invocations)
    .where(isNotNull(invocations.costUsd))
    .get();

  const totalCost = costRow?.totalCost ? Number(costRow.totalCost) : 0;
  const costCount = costRow?.costCount ?? 0;
  const avgCost = costCount > 0 ? totalCost / costCount : 0;

  // Duration stats
  const durationRow = db
    .select({
      totalMs: sql<string>`sum((julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) * 86400000)`,
      cnt: count(),
    })
    .from(invocations)
    .where(
      and(
        isNotNull(invocations.endedAt),
        isNotNull(invocations.startedAt),
        sql`(julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) >= 0`,
      ),
    )
    .get();

  const totalDurMs = durationRow?.totalMs ? Number(durationRow.totalMs) : 0;
  const durCount = durationRow?.cnt ?? 0;
  const avgDurationMs = durCount > 0 ? totalDurMs / durCount : 0;

  // Turn stats
  const turnRow = db
    .select({
      totalTurns: sum(invocations.numTurns),
      cnt: count(),
    })
    .from(invocations)
    .where(isNotNull(invocations.numTurns))
    .get();

  const totalTurns = turnRow?.totalTurns ? Number(turnRow.totalTurns) : 0;
  const turnCount = turnRow?.cnt ?? 0;
  const avgTurns = turnCount > 0 ? totalTurns / turnCount : 0;

  return {
    total,
    completed,
    failed,
    timedOut,
    running,
    finished,
    totalCost,
    avgCost,
    avgDurationMs,
    avgTurns,
  };
}

/** Get daily invocation metrics grouped by day and status (for last N days). */
export function getDailyMetrics(db: OrcaDb, since: string) {
  return db
    .select({
      day: sql<string>`substr(${invocations.startedAt}, 1, 10)`,
      status: invocations.status,
      cnt: count(),
      totalCost: sql<string>`coalesce(sum(${invocations.costUsd}), 0)`,
      totalDurationMs: sql<string>`coalesce(sum(case when ${invocations.endedAt} is not null and (julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) >= 0 then (julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) * 86400000 else 0 end), 0)`,
      durationCount: sql<number>`sum(case when ${invocations.endedAt} is not null and (julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) >= 0 then 1 else 0 end)`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, since))
    .groupBy(sql`substr(${invocations.startedAt}, 1, 10)`, invocations.status)
    .all();
}

/** Get top N tasks by total cost. */
export function getTopTasksByCost(db: OrcaDb, limit: number) {
  return db
    .select({
      taskId: invocations.linearIssueId,
      totalCost: sql<string>`sum(${invocations.costUsd})`,
      invocationCount: count(),
    })
    .from(invocations)
    .where(isNotNull(invocations.costUsd))
    .groupBy(invocations.linearIssueId)
    .orderBy(sql`sum(${invocations.costUsd}) desc`)
    .limit(limit)
    .all();
}

/** Get recent failed/timed_out invocations. */
export function getErrorInvocations(db: OrcaDb, limit: number): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(inArray(invocations.status, ["failed", "timed_out"]))
    .orderBy(desc(invocations.id))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Budget event types
// ---------------------------------------------------------------------------
type NewBudgetEvent = InferInsertModel<typeof budgetEvents>;

// ---------------------------------------------------------------------------
// Budget queries
// ---------------------------------------------------------------------------

/** Insert a budget event. */
export function insertBudgetEvent(db: OrcaDb, event: NewBudgetEvent): void {
  db.insert(budgetEvents).values(event).run();
}

/**
 * Sum cost_usd from budget_events where recorded_at >= windowStart.
 * Returns 0 if no events match.
 */
export function sumCostInWindow(db: OrcaDb, windowStart: string): number {
  const result = db
    .select({ total: sum(budgetEvents.costUsd) })
    .from(budgetEvents)
    .where(gte(budgetEvents.recordedAt, windowStart))
    .get();
  return result?.total ? Number(result.total) : 0;
}
