import { eq, ne, gte, asc, desc, sql, count, sum, inArray, and, isNotNull } from "drizzle-orm";
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

// ---------------------------------------------------------------------------
// Observability queries
// ---------------------------------------------------------------------------

/** Count tasks grouped by orcaStatus. */
export function getTasksByStatus(db: OrcaDb): Record<string, number> {
  const rows = db
    .select({ status: tasks.orcaStatus, cnt: count() })
    .from(tasks)
    .groupBy(tasks.orcaStatus)
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.cnt;
  }
  return result;
}

/** Count invocations grouped by status. */
export function getInvocationsByStatusGroup(db: OrcaDb): Record<string, number> {
  const rows = db
    .select({ status: invocations.status, cnt: count() })
    .from(invocations)
    .groupBy(invocations.status)
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.status] = row.cnt;
  }
  return result;
}

/** Sum all costUsd from invocations. */
export function getTotalCostAllTime(db: OrcaDb): number {
  const result = db
    .select({ total: sum(invocations.costUsd) })
    .from(invocations)
    .get();
  return result?.total ? Number(result.total) : 0;
}

/** Get cost per day from budget_events for the last 30 days. */
export function getCostByDay(db: OrcaDb): { date: string; cost: number }[] {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .select({
      date: sql<string>`substr(${budgetEvents.recordedAt}, 1, 10)`,
      cost: sum(budgetEvents.costUsd),
    })
    .from(budgetEvents)
    .where(gte(budgetEvents.recordedAt, thirtyDaysAgo))
    .groupBy(sql`substr(${budgetEvents.recordedAt}, 1, 10)`)
    .orderBy(asc(sql`substr(${budgetEvents.recordedAt}, 1, 10)`))
    .all();
  return rows.map((r) => ({ date: r.date, cost: r.cost ? Number(r.cost) : 0 }));
}

/** Average session duration in seconds for completed invocations. */
export function getAvgSessionDuration(db: OrcaDb): number {
  const result = db
    .select({
      avg: sql<number>`avg(
        strftime('%s', ${invocations.endedAt}) - strftime('%s', ${invocations.startedAt})
      )`,
    })
    .from(invocations)
    .where(
      and(
        eq(invocations.status, "completed"),
        isNotNull(invocations.endedAt),
      ),
    )
    .get();
  return result?.avg ? Math.round(result.avg) : 0;
}

/** Count all invocations. */
export function getTotalInvocations(db: OrcaDb): number {
  const result = db
    .select({ cnt: count() })
    .from(invocations)
    .get();
  return result?.cnt ?? 0;
}

/** Get last N non-running invocations ordered by startedAt desc. */
export function getRecentCompletions(db: OrcaDb, limit = 20): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(ne(invocations.status, "running"))
    .orderBy(desc(invocations.startedAt))
    .limit(limit)
    .all();
}

/** Get last N failed/timed_out invocations ordered by startedAt desc. */
export function getRecentErrors(db: OrcaDb, limit = 50): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(inArray(invocations.status, ["failed", "timed_out"]))
    .orderBy(desc(invocations.startedAt))
    .limit(limit)
    .all();
}

/** Group failed/timed_out invocations by outputSummary, return top N patterns. */
export function getErrorPatterns(
  db: OrcaDb,
  limit = 20,
): { pattern: string; count: number; lastSeen: string }[] {
  const rows = db
    .select({
      pattern: invocations.outputSummary,
      cnt: count(),
      lastSeen: sql<string>`max(${invocations.startedAt})`,
    })
    .from(invocations)
    .where(
      and(
        inArray(invocations.status, ["failed", "timed_out"]),
        isNotNull(invocations.outputSummary),
      ),
    )
    .groupBy(invocations.outputSummary)
    .orderBy(desc(count()))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    pattern: r.pattern ?? "unknown",
    count: r.cnt,
    lastSeen: r.lastSeen,
  }));
}

/** Get failure rate: total non-running invocations vs failed/timed_out. */
export function getFailureRate(db: OrcaDb): { total: number; failed: number; rate: number } {
  const totalResult = db
    .select({ cnt: count() })
    .from(invocations)
    .where(ne(invocations.status, "running"))
    .get();
  const total = totalResult?.cnt ?? 0;

  const failedResult = db
    .select({ cnt: count() })
    .from(invocations)
    .where(inArray(invocations.status, ["failed", "timed_out"]))
    .get();
  const failed = failedResult?.cnt ?? 0;

  return { total, failed, rate: total > 0 ? Number((failed / total).toFixed(2)) : 0 };
}

/** Get invocations for log search, optionally filtered by taskId. */
export function getInvocationsForLogSearch(
  db: OrcaDb,
  taskId?: string,
): Pick<Invocation, "id" | "linearIssueId" | "startedAt" | "logPath">[] {
  if (taskId) {
    return db
      .select({
        id: invocations.id,
        linearIssueId: invocations.linearIssueId,
        startedAt: invocations.startedAt,
        logPath: invocations.logPath,
      })
      .from(invocations)
      .where(eq(invocations.linearIssueId, taskId))
      .orderBy(desc(invocations.startedAt))
      .all();
  }
  return db
    .select({
      id: invocations.id,
      linearIssueId: invocations.linearIssueId,
      startedAt: invocations.startedAt,
      logPath: invocations.logPath,
    })
    .from(invocations)
    .orderBy(desc(invocations.startedAt))
    .limit(100)
    .all();
}
