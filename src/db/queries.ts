import {
  eq,
  gte,
  asc,
  desc,
  sql,
  count,
  sum,
  inArray,
  and,
  isNotNull,
  isNull,
  avg,
  lt,
  lte,
  or,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import {
  tasks,
  invocations,
  budgetEvents,
  cronSchedules,
  cronRuns,
  systemEvents,
  type TaskStatus,
} from "./schema.js";
import type { OrcaDb } from "./index.js";

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------
type NewTask = InferInsertModel<typeof tasks>;
export type Task = typeof tasks.$inferSelect;

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

/**
 * Set a task to "failed" status and record the failure reason, phase, and timestamp.
 * Truncates reason to 500 chars to keep the DB tidy.
 */
export function updateTaskFailure(
  db: OrcaDb,
  taskId: string,
  reason: string,
  phase: "implement" | "review" | "fix" | "ci" | "deploy",
): void {
  db.update(tasks)
    .set({
      orcaStatus: "failed" as TaskStatus,
      lastFailureReason: reason.slice(0, 500),
      lastFailedPhase: phase,
      lastFailedAt: new Date().toISOString(),
      doneAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/**
 * Atomically claim a task for dispatch using compare-and-swap.
 * Only updates the status to "dispatched" if the task is currently in one of
 * the provided `fromStatuses`. Returns true if exactly one row was updated.
 */
export function claimTaskForDispatch(
  db: OrcaDb,
  taskId: string,
  fromStatuses: TaskStatus[],
): boolean {
  const result = db
    .update(tasks)
    .set({
      orcaStatus: "dispatched" as TaskStatus,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(tasks.linearIssueId, taskId),
        inArray(tasks.orcaStatus, fromStatuses),
      ),
    )
    .run();
  return result.changes === 1;
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

/** Get tasks matching any of the given statuses, ordered by priority ASC then created_at ASC. */
export function getDispatchableTasks(
  db: OrcaDb,
  statuses: TaskStatus[],
): Task[] {
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.orcaStatus, statuses))
    .orderBy(asc(tasks.priority), asc(tasks.createdAt))
    .all();
}

/** Set the PR branch name on a task. */
export function updateTaskPrBranch(
  db: OrcaDb,
  taskId: string,
  branchName: string,
): void {
  db.update(tasks)
    .set({ prBranchName: branchName, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Set the fix_reason on a task (used to customize fix-phase agent prompt). */
export function updateTaskFixReason(
  db: OrcaDb,
  taskId: string,
  fixReason: string | null,
): void {
  db.update(tasks)
    .set({ fixReason, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Reset merge_attempt_count to 0. Used when dispatching a conflict-resolution fix session. */
export function resetMergeAttemptCount(db: OrcaDb, taskId: string): void {
  db.update(tasks)
    .set({ mergeAttemptCount: 0, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Increment merge_attempt_count by 1. */
export function incrementMergeAttemptCount(db: OrcaDb, taskId: string): void {
  db.update(tasks)
    .set({
      mergeAttemptCount: sql`${tasks.mergeAttemptCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Increment stale_session_retry_count by 1 and return the new count. */
export function incrementStaleSessionRetryCount(
  db: OrcaDb,
  taskId: string,
): number {
  db.update(tasks)
    .set({
      staleSessionRetryCount: sql`${tasks.staleSessionRetryCount} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
  const row = db
    .select({ count: tasks.staleSessionRetryCount })
    .from(tasks)
    .where(eq(tasks.linearIssueId, taskId))
    .get();
  return row?.count ?? 0;
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
  return db.select().from(tasks).where(eq(tasks.orcaStatus, "deploying")).all();
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
  info: {
    mergeCommitSha?: string | null;
    prNumber?: number | null;
    deployStartedAt?: string | null;
  },
): void {
  db.update(tasks)
    .set({ ...info, updatedAt: new Date().toISOString() })
    .where(eq(tasks.linearIssueId, taskId))
    .run();
}

/** Get a single task by its linear_issue_id. */
export function getTask(db: OrcaDb, taskId: string): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.linearIssueId, taskId)).get();
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
  return db.select().from(tasks).where(eq(tasks.isParent, 1)).all();
}

/** Delete a task and its invocations/budget events by linear_issue_id. */
export function deleteTask(db: OrcaDb, taskId: string): void {
  // Delete budget events for this task's invocations first (FK chain)
  const taskInvocations = db
    .select({ id: invocations.id })
    .from(invocations)
    .where(eq(invocations.linearIssueId, taskId))
    .all();
  if (taskInvocations.length > 0) {
    const invIds = taskInvocations.map((i) => i.id);
    db.delete(budgetEvents)
      .where(inArray(budgetEvents.invocationId, invIds))
      .run();
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
  const setValues: Record<string, unknown> = {
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  // Automatically manage doneAt when orcaStatus is being updated
  if ("orcaStatus" in updates) {
    setValues.doneAt =
      updates.orcaStatus === "done" ? new Date().toISOString() : null;
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
type InvocationUpdate = Partial<Omit<Invocation, "id" | "linearIssueId">>;

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
export function insertInvocation(
  db: OrcaDb,
  invocation: NewInvocation,
): number {
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
  db.update(invocations).set(updates).where(eq(invocations.id, id)).run();
}

/** Get all invocations for a given task. */
export function getInvocationsByTask(db: OrcaDb, taskId: string): Invocation[] {
  return db
    .select()
    .from(invocations)
    .where(eq(invocations.linearIssueId, taskId))
    .all();
}

/**
 * Find the most recent completed implement-phase invocation for a task that
 * has a valid session ID. Used to resume the implement session during fix phase.
 */
export function getLastCompletedImplementInvocation(
  db: OrcaDb,
  taskId: string,
): Invocation | undefined {
  return db
    .select()
    .from(invocations)
    .where(
      and(
        eq(invocations.linearIssueId, taskId),
        eq(invocations.phase, "implement"),
        eq(invocations.status, "completed"),
        isNotNull(invocations.sessionId),
      ),
    )
    .orderBy(desc(invocations.id))
    .limit(1)
    .get();
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

/**
 * Find the most recent invocation for a task that was interrupted by a deploy
 * and has a preserved worktree (worktree_preserved = 1).
 * Used to determine if a retry can reuse the preserved worktree and resume
 * the session. Matches all phases (implement, review, fix) since deploy
 * interruptions now preserve worktrees for every phase.
 */
export function getLastDeployInterruptedInvocation(
  db: OrcaDb,
  taskId: string,
): Invocation | undefined {
  return db
    .select()
    .from(invocations)
    .where(
      and(
        eq(invocations.linearIssueId, taskId),
        eq(invocations.outputSummary, "interrupted_by_deploy"),
        eq(invocations.status, "failed"),
        eq(invocations.worktreePreserved, 1),
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

/** Clear session IDs from all invocations for a task across all phases.
 * Called at startup to ensure dead pre-restart sessions aren't re-used. */
export function clearSessionIds(db: OrcaDb, taskId: string): void {
  db.update(invocations)
    .set({ sessionId: null })
    .where(eq(invocations.linearIssueId, taskId))
    .run();
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

/** Returns an ISO timestamp for the start of a budget window `hours` hours ago. */
export function budgetWindowStart(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
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

/**
 * Sum (input_tokens + output_tokens) from budget_events where recorded_at >= windowStart.
 * Returns 0 if no events match.
 */
export function sumTokensInWindow(db: OrcaDb, windowStart: string): number {
  const result = db
    .select({
      total: sql<number>`coalesce(sum(${budgetEvents.inputTokens} + ${budgetEvents.outputTokens}), 0)`,
    })
    .from(budgetEvents)
    .where(gte(budgetEvents.recordedAt, windowStart))
    .get();
  return result?.total ? Number(result.total) : 0;
}

/**
 * Sum input_tokens and output_tokens separately from budget_events where recorded_at >= windowStart.
 * Returns { input: 0, output: 0 } if no events match.
 */
export function sumTokensSplitInWindow(
  db: OrcaDb,
  windowStart: string,
): { input: number; output: number } {
  const result = db
    .select({
      input: sql<number>`coalesce(sum(${budgetEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${budgetEvents.outputTokens}), 0)`,
    })
    .from(budgetEvents)
    .where(gte(budgetEvents.recordedAt, windowStart))
    .get();
  return {
    input: result?.input ? Number(result.input) : 0,
    output: result?.output ? Number(result.output) : 0,
  };
}

/**
 * Get the earliest recorded_at timestamp from budget_events where recorded_at >= windowStart.
 * Returns null if no events match.
 */
export function getEarliestEventInWindow(
  db: OrcaDb,
  windowStart: string,
): string | null {
  const result = db
    .select({
      earliest: sql<string>`min(${budgetEvents.recordedAt})`,
    })
    .from(budgetEvents)
    .where(gte(budgetEvents.recordedAt, windowStart))
    .get();
  return result?.earliest ?? null;
}

// ---------------------------------------------------------------------------
// Metrics queries
// ---------------------------------------------------------------------------

export interface InvocationStats {
  /** Counts of invocations by status. */
  byStatus: { status: string; count: number }[];
  /** Average session duration in seconds for completed invocations. */
  avgDurationSecs: number | null;
  /** Average cost in USD for completed invocations. */
  avgCostUsd: number | null;
  /** Total cost in USD across all completed invocations. */
  totalCostUsd: number | null;
  /** Average tokens (input + output) per completed invocation. */
  avgTokens: number | null;
  /** Total tokens (input + output) across all completed invocations. */
  totalTokens: number | null;
}

/** Aggregate invocation statistics for the metrics dashboard. */
export function getInvocationStats(db: OrcaDb): InvocationStats {
  const byStatus = db
    .select({ status: invocations.status, count: count() })
    .from(invocations)
    .groupBy(invocations.status)
    .all()
    .map((r) => ({ status: r.status, count: r.count }));

  const durationResult = db
    .select({
      avgDuration: sql<number>`avg((julianday(${invocations.endedAt}) - julianday(${invocations.startedAt})) * 86400)`,
    })
    .from(invocations)
    .where(eq(invocations.status, "completed"))
    .get();

  const costResult = db
    .select({
      avgCost: avg(invocations.costUsd),
      totalCost: sum(invocations.costUsd),
    })
    .from(invocations)
    .where(eq(invocations.status, "completed"))
    .get();

  const tokenResult = db
    .select({
      avgTokens: sql<number>`avg(coalesce(${invocations.inputTokens}, 0) + coalesce(${invocations.outputTokens}, 0))`,
      totalTokens: sql<number>`sum(coalesce(${invocations.inputTokens}, 0) + coalesce(${invocations.outputTokens}, 0))`,
    })
    .from(invocations)
    .where(eq(invocations.status, "completed"))
    .get();

  return {
    byStatus,
    avgDurationSecs: durationResult?.avgDuration ?? null,
    avgCostUsd: costResult?.avgCost ? Number(costResult.avgCost) : null,
    totalCostUsd: costResult?.totalCost ? Number(costResult.totalCost) : null,
    avgTokens: tokenResult?.avgTokens ? Number(tokenResult.avgTokens) : null,
    totalTokens: tokenResult?.totalTokens
      ? Number(tokenResult.totalTokens)
      : null,
  };
}

export interface RecentError {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  outputSummary: string | null;
  phase: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Get the most recent failed or timed-out invocations. */
export function getRecentErrors(db: OrcaDb, limit = 20): RecentError[] {
  return db
    .select({
      id: invocations.id,
      linearIssueId: invocations.linearIssueId,
      startedAt: invocations.startedAt,
      endedAt: invocations.endedAt,
      status: invocations.status,
      outputSummary: invocations.outputSummary,
      phase: invocations.phase,
      costUsd: invocations.costUsd,
      inputTokens: invocations.inputTokens,
      outputTokens: invocations.outputTokens,
    })
    .from(invocations)
    .where(inArray(invocations.status, ["failed", "timed_out"]))
    .orderBy(desc(invocations.id))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

export interface DailyStatEntry {
  date: string; // "YYYY-MM-DD"
  completed: number;
  failed: number;
  costUsd: number;
  tokens: number;
}

export function getDailyStats(db: OrcaDb, days = 14): DailyStatEntry[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .select({
      date: sql<string>`date(${invocations.startedAt})`,
      completed: sql<number>`sum(case when ${invocations.status} = 'completed' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${invocations.status} in ('failed', 'timed_out') then 1 else 0 end)`,
      costUsd: sql<number>`coalesce(sum(${invocations.costUsd}), 0)`,
      tokens: sql<number>`coalesce(sum(coalesce(${invocations.inputTokens}, 0) + coalesce(${invocations.outputTokens}, 0)), 0)`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, since))
    .groupBy(sql`date(${invocations.startedAt})`)
    .orderBy(sql`date(${invocations.startedAt})`)
    .all();

  // Fill in missing days with zeros
  const dateMap = new Map(rows.map((r) => [r.date, r]));
  const result: DailyStatEntry[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0]!;
    const row = dateMap.get(dateStr);
    result.push({
      date: dateStr,
      completed: row ? Number(row.completed) : 0,
      failed: row ? Number(row.failed) : 0,
      costUsd: row ? Number(row.costUsd) : 0,
      tokens: row ? Number(row.tokens) : 0,
    });
  }
  return result;
}

/**
 * Compute the success rate (completed / total terminal) over the past 12 hours.
 * Returns null when there are no completed or failed/timed_out invocations in the window.
 * Excludes invocations orphaned by crash/restart — those are infrastructure noise,
 * not real task failures.
 */
export function getSuccessRate12h(db: OrcaDb): number | null {
  const since = budgetWindowStart(12);
  const result = db
    .select({
      completed: sql<number>`sum(case when ${invocations.status} = 'completed' then 1 else 0 end)`,
      total: sql<number>`sum(case when ${invocations.status} in ('completed', 'failed', 'timed_out') and coalesce(${invocations.outputSummary}, '') != 'orphaned by crash/restart' then 1 else 0 end)`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, since))
    .get();

  if (!result || !result.total || Number(result.total) === 0) return null;
  return Number(result.completed) / Number(result.total);
}

export interface ActivityEntry {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  phase: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function getRecentActivity(db: OrcaDb, limit = 20): ActivityEntry[] {
  return db.all<ActivityEntry>(sql`
    SELECT
      i.id,
      i.linear_issue_id   AS linearIssueId,
      i.started_at        AS startedAt,
      i.ended_at          AS endedAt,
      CASE
        WHEN t.orca_status = 'failed'              THEN 'failed'
        WHEN t.orca_status = 'done'                THEN 'completed'
        WHEN i.status = 'running'                  THEN 'running'
        WHEN i.status = 'completed'                THEN 'completed'
        WHEN i.status = 'failed' AND t.orca_status IN ('ready', 'in_review', 'changes_requested', 'dispatched', 'running')
                                                   THEN 'queued'
        WHEN i.status = 'failed'                   THEN 'retrying'
        ELSE i.status
      END                 AS status,
      i.phase,
      i.cost_usd          AS costUsd,
      i.input_tokens      AS inputTokens,
      i.output_tokens     AS outputTokens
    FROM invocations i
    INNER JOIN (
      SELECT linear_issue_id, MAX(id) AS max_id
      FROM invocations
      GROUP BY linear_issue_id
    ) latest ON i.id = latest.max_id
    LEFT JOIN tasks t ON t.linear_issue_id = i.linear_issue_id
    ORDER BY i.id DESC
    LIMIT ${limit}
  `);
}

/**
 * Sum cost_usd from budget_events where recorded_at is within [windowStart, windowEnd).
 * Returns 0 if no events match.
 */
export function sumCostInWindowRange(
  db: OrcaDb,
  windowStart: string,
  windowEnd: string,
): number {
  const result = db
    .select({ total: sum(budgetEvents.costUsd) })
    .from(budgetEvents)
    .where(
      and(
        gte(budgetEvents.recordedAt, windowStart),
        lt(budgetEvents.recordedAt, windowEnd),
      ),
    )
    .get();
  return result?.total ? Number(result.total) : 0;
}

/**
 * Sum (input_tokens + output_tokens) from budget_events where recorded_at is within [windowStart, windowEnd).
 * Returns 0 if no events match.
 */
export function sumTokensInWindowRange(
  db: OrcaDb,
  windowStart: string,
  windowEnd: string,
): number {
  const result = db
    .select({
      total: sql<number>`coalesce(sum(${budgetEvents.inputTokens} + ${budgetEvents.outputTokens}), 0)`,
    })
    .from(budgetEvents)
    .where(
      and(
        gte(budgetEvents.recordedAt, windowStart),
        lt(budgetEvents.recordedAt, windowEnd),
      ),
    )
    .get();
  return result?.total ? Number(result.total) : 0;
}

// ---------------------------------------------------------------------------
// Cron schedule types
// ---------------------------------------------------------------------------
type NewCronSchedule = InferInsertModel<typeof cronSchedules>;
export type CronSchedule = typeof cronSchedules.$inferSelect;

// ---------------------------------------------------------------------------
// Cron schedule queries
// ---------------------------------------------------------------------------

/** Insert a new cron schedule and return its auto-generated id. */
export function insertCronSchedule(
  db: OrcaDb,
  schedule: NewCronSchedule,
): number {
  const result = db
    .insert(cronSchedules)
    .values(schedule)
    .returning({ id: cronSchedules.id })
    .get();
  return result.id;
}

/** Update fields on a cron schedule. */
export function updateCronSchedule(
  db: OrcaDb,
  id: number,
  updates: Partial<Omit<NewCronSchedule, "id" | "createdAt">>,
): void {
  db.update(cronSchedules)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(cronSchedules.id, id))
    .run();
}

/** Delete a cron schedule by id. */
export function deleteCronSchedule(db: OrcaDb, id: number): void {
  db.delete(cronSchedules).where(eq(cronSchedules.id, id)).run();
}

/** Get a single cron schedule by id. */
export function getCronSchedule(
  db: OrcaDb,
  id: number,
): CronSchedule | undefined {
  return db.select().from(cronSchedules).where(eq(cronSchedules.id, id)).get();
}

/** Get all cron schedules. */
export function getAllCronSchedules(db: OrcaDb): CronSchedule[] {
  return db.select().from(cronSchedules).all();
}

/**
 * Get cron schedules that are due to run.
 * Filters: enabled=1, next_run_at IS NOT NULL, next_run_at <= now,
 * and (max_runs IS NULL OR run_count < max_runs)
 */
export function getDueCronSchedules(db: OrcaDb, now: string): CronSchedule[] {
  return db
    .select()
    .from(cronSchedules)
    .where(
      and(
        eq(cronSchedules.enabled, 1),
        isNotNull(cronSchedules.nextRunAt),
        lte(cronSchedules.nextRunAt, now),
        or(
          isNull(cronSchedules.maxRuns),
          sql`${cronSchedules.runCount} < ${cronSchedules.maxRuns}`,
        ),
      ),
    )
    .all();
}

/** Update the lastRunStatus field on a cron schedule row. */
export function updateCronLastRunStatus(
  db: OrcaDb,
  id: number,
  status: "success" | "failed",
): void {
  db.update(cronSchedules)
    .set({ lastRunStatus: status, updatedAt: new Date().toISOString() })
    .where(eq(cronSchedules.id, id))
    .run();
}

/**
 * Increment run_count by 1 and update last_run_at and next_run_at.
 */
export function incrementCronRunCount(
  db: OrcaDb,
  id: number,
  nextRunAt: string,
): void {
  db.update(cronSchedules)
    .set({
      runCount: sql`${cronSchedules.runCount} + 1`,
      lastRunAt: new Date().toISOString(),
      nextRunAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(cronSchedules.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Cron run types
// ---------------------------------------------------------------------------
export type CronRun = typeof cronRuns.$inferSelect;

// ---------------------------------------------------------------------------
// Cron run queries
// ---------------------------------------------------------------------------

/** Insert a new cron run and return its auto-generated id. */
export function insertCronRun(
  db: OrcaDb,
  run: { cronScheduleId: number; startedAt: string; status: string },
): number {
  const result = db
    .insert(cronRuns)
    .values(run)
    .returning({ id: cronRuns.id })
    .get();
  return result.id;
}

/** Update a cron run with completion data. */
export function completeCronRun(
  db: OrcaDb,
  id: number,
  update: {
    endedAt: string;
    status: string;
    output: string | null;
    durationMs: number;
  },
): void {
  db.update(cronRuns).set(update).where(eq(cronRuns.id, id)).run();
}

/** Get recent cron runs for a schedule, newest first. */
export function getCronRunsForSchedule(
  db: OrcaDb,
  scheduleId: number,
  limit = 50,
): CronRun[] {
  return db
    .select()
    .from(cronRuns)
    .where(eq(cronRuns.cronScheduleId, scheduleId))
    .orderBy(desc(cronRuns.id))
    .limit(limit)
    .all();
}

/** Delete cron runs older than the given date. Returns count of deleted rows. */
export function deleteOldCronRuns(db: OrcaDb, beforeDate: string): number {
  const result = db
    .delete(cronRuns)
    .where(lt(cronRuns.startedAt, beforeDate))
    .run();
  return result.changes;
}

/** Get all tasks spawned by a specific cron schedule. */
export function getTasksByCronSchedule(db: OrcaDb, scheduleId: number): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.cronScheduleId, scheduleId))
    .all();
}

/**
 * Delete cron-spawned tasks created before the given date.
 * Returns the count of deleted rows.
 */
export function deleteOldCronTasks(db: OrcaDb, beforeDate: string): number {
  // Only delete terminal cron tasks (done or failed) — never active/running ones.
  const terminalStatuses: TaskStatus[] = ["done", "failed", "canceled"];
  const oldTasks = db
    .select({ id: tasks.linearIssueId })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.cronScheduleId),
        lt(tasks.createdAt, beforeDate),
        inArray(tasks.orcaStatus, terminalStatuses),
      ),
    )
    .all();

  for (const task of oldTasks) {
    deleteTask(db, task.id);
  }

  return oldTasks.length;
}

/**
 * Get tasks in 'failed' status that still have retries remaining.
 * Excludes cron tasks (cron_claude, cron_shell) — those have their own lifecycle.
 */
export function getFailedTasksWithRetriesRemaining(
  db: OrcaDb,
  maxRetries: number,
): Task[] {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.orcaStatus, "failed"),
        sql`(${tasks.retryCount} + ${tasks.staleSessionRetryCount}) < ${maxRetries}`,
        or(
          isNull(tasks.taskType),
          sql`${tasks.taskType} NOT IN ('cron_claude', 'cron_shell')`,
        ),
      ),
    )
    .all();
}

// ---------------------------------------------------------------------------
// System event types
// ---------------------------------------------------------------------------
export type SystemEvent = typeof systemEvents.$inferSelect;
export type SystemEventType = SystemEvent["type"];

// ---------------------------------------------------------------------------
// System event queries
// ---------------------------------------------------------------------------

/** Insert a system event. */
export function insertSystemEvent(
  db: OrcaDb,
  event: {
    type: SystemEventType;
    message: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.insert(systemEvents)
    .values({
      type: event.type,
      message: event.message,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** Get recent system events (newest first). */
export function getRecentSystemEvents(db: OrcaDb, limit = 100): SystemEvent[] {
  return db
    .select()
    .from(systemEvents)
    .orderBy(desc(systemEvents.createdAt))
    .limit(limit)
    .all();
}

/** Get system events by type. */
export function getSystemEventsByType(
  db: OrcaDb,
  type: SystemEventType,
  limit = 50,
): SystemEvent[] {
  return db
    .select()
    .from(systemEvents)
    .where(eq(systemEvents.type, type))
    .orderBy(desc(systemEvents.createdAt))
    .limit(limit)
    .all();
}

/** Get system events by type since a given timestamp. */
export function getSystemEventsSince(
  db: OrcaDb,
  since: string,
  type?: SystemEventType,
  limit = 200,
): SystemEvent[] {
  const conditions = [gte(systemEvents.createdAt, since)];
  if (type) conditions.push(eq(systemEvents.type, type));
  return db
    .select()
    .from(systemEvents)
    .where(and(...conditions))
    .orderBy(desc(systemEvents.createdAt))
    .limit(limit)
    .all();
}

/** Count events by type since a given timestamp. */
export function countSystemEventsSince(
  db: OrcaDb,
  since: string,
  type?: SystemEventType,
): number {
  const conditions = [gte(systemEvents.createdAt, since)];
  if (type) conditions.push(eq(systemEvents.type, type));
  const result = db
    .select({ count: count() })
    .from(systemEvents)
    .where(and(...conditions))
    .get();
  return result?.count ?? 0;
}

/** Get uptime info: time since last startup event. */
export function getLastStartup(db: OrcaDb): SystemEvent | undefined {
  return db
    .select()
    .from(systemEvents)
    .where(eq(systemEvents.type, "startup"))
    .orderBy(desc(systemEvents.createdAt))
    .limit(1)
    .get();
}
