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
  cronSchedules,
  cronRuns,
  systemEvents,
  taskStateTransitions,
  agents,
  agentMemories,
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
  options?: { reason?: string; invocationId?: number },
): void {
  const current = db
    .select({ orcaStatus: tasks.orcaStatus })
    .from(tasks)
    .where(eq(tasks.linearIssueId, taskId))
    .get();

  db.update(tasks)
    .set({
      orcaStatus: status,
      doneAt: status === "done" ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();

  insertTaskStateTransition(db, {
    linearIssueId: taskId,
    fromStatus: current?.orcaStatus ?? null,
    toStatus: status,
    reason: options?.reason,
    invocationId: options?.invocationId,
  });
}

/**
 * Atomically claim a task for dispatch using compare-and-swap.
 * Only updates the status to "running" if the task is currently in one of
 * the provided `fromStatuses`. Returns true if exactly one row was updated.
 */
export function claimTaskForDispatch(
  db: OrcaDb,
  taskId: string,
  fromStatuses: TaskStatus[],
  options?: { reason?: string; invocationId?: number },
): boolean {
  const current = db
    .select({ orcaStatus: tasks.orcaStatus })
    .from(tasks)
    .where(eq(tasks.linearIssueId, taskId))
    .get();

  const result = db
    .update(tasks)
    .set({
      orcaStatus: "running" as TaskStatus,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(tasks.linearIssueId, taskId),
        inArray(tasks.orcaStatus, fromStatuses),
      ),
    )
    .run();

  if (result.changes === 1) {
    insertTaskStateTransition(db, {
      linearIssueId: taskId,
      fromStatus: current?.orcaStatus ?? null,
      toStatus: "running",
      reason: options?.reason ?? "claimed for dispatch",
      invocationId: options?.invocationId,
    });
  }

  return result.changes === 1;
}

/** Increment retry_count by 1 and reset status to the given value (default "ready"). */
export function incrementRetryCount(
  db: OrcaDb,
  taskId: string,
  resetStatus: TaskStatus = "ready",
  options?: { reason?: string; invocationId?: number },
): void {
  const current = db
    .select({ orcaStatus: tasks.orcaStatus })
    .from(tasks)
    .where(eq(tasks.linearIssueId, taskId))
    .get();

  db.update(tasks)
    .set({
      retryCount: sql`${tasks.retryCount} + 1`,
      orcaStatus: resetStatus,
      doneAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.linearIssueId, taskId))
    .run();

  insertTaskStateTransition(db, {
    linearIssueId: taskId,
    fromStatus: current?.orcaStatus ?? null,
    toStatus: resetStatus,
    reason: options?.reason ?? "retry",
    invocationId: options?.invocationId,
  });
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

/** Reset stale_session_retry_count to 0. Used when a task makes real progress (phase transition). */
export function resetStaleSessionRetryCount(db: OrcaDb, taskId: string): void {
  db.update(tasks)
    .set({ staleSessionRetryCount: 0, updatedAt: new Date().toISOString() })
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

/** Delete a task and its invocations by linear_issue_id. */
export function deleteTask(db: OrcaDb, taskId: string): void {
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
 * Get the count of invocations grouped by linear_issue_id.
 * Returns a Map from taskId -> count.
 * Used by GET /api/tasks to avoid N+1 queries.
 */
export function getInvocationCountsByTask(db: OrcaDb): Map<string, number> {
  const rows = db
    .select({
      linearIssueId: invocations.linearIssueId,
      count: count(),
    })
    .from(invocations)
    .groupBy(invocations.linearIssueId)
    .all();
  return new Map(rows.map((r) => [r.linearIssueId, r.count]));
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
// Budget queries
// ---------------------------------------------------------------------------

/** Returns an ISO timestamp for the start of a budget window `hours` hours ago. */
export function budgetWindowStart(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Sum (input_tokens + output_tokens) from invocations where started_at >= windowStart.
 * Returns 0 if no invocations match.
 */
export function sumTokensInWindow(db: OrcaDb, windowStart: string): number {
  const result = db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${invocations.inputTokens}, 0) + coalesce(${invocations.outputTokens}, 0)), 0)`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, windowStart))
    .get();
  return result?.total ? Number(result.total) : 0;
}

/**
 * Sum input_tokens and output_tokens separately from invocations where started_at >= windowStart.
 * Returns { input: 0, output: 0 } if no invocations match.
 */
export function sumTokensSplitInWindow(
  db: OrcaDb,
  windowStart: string,
): { input: number; output: number } {
  const result = db
    .select({
      input: sql<number>`coalesce(sum(coalesce(${invocations.inputTokens}, 0)), 0)`,
      output: sql<number>`coalesce(sum(coalesce(${invocations.outputTokens}, 0)), 0)`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, windowStart))
    .get();
  return {
    input: result?.input ? Number(result.input) : 0,
    output: result?.output ? Number(result.output) : 0,
  };
}

/**
 * Get the earliest started_at timestamp from invocations where started_at >= windowStart.
 * Returns null if no invocations match.
 */
export function getEarliestInvocationInWindow(
  db: OrcaDb,
  windowStart: string,
): string | null {
  const result = db
    .select({
      earliest: sql<string>`min(${invocations.startedAt})`,
    })
    .from(invocations)
    .where(gte(invocations.startedAt, windowStart))
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
        WHEN i.status = 'failed' AND t.orca_status IN ('ready', 'in_review', 'changes_requested', 'running')
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
 * Sum (input_tokens + output_tokens) from invocations where started_at is within [windowStart, windowEnd).
 * Returns 0 if no invocations match.
 */
export function sumTokensInWindowRange(
  db: OrcaDb,
  windowStart: string,
  windowEnd: string,
): number {
  const result = db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${invocations.inputTokens}, 0) + coalesce(${invocations.outputTokens}, 0)), 0)`,
    })
    .from(invocations)
    .where(
      and(
        gte(invocations.startedAt, windowStart),
        lt(invocations.startedAt, windowEnd),
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

// ---------------------------------------------------------------------------
// Task state transition types
// ---------------------------------------------------------------------------
export type TaskStateTransition = typeof taskStateTransitions.$inferSelect;

// ---------------------------------------------------------------------------
// Task state transition queries
// ---------------------------------------------------------------------------

/** Insert a task state transition record. */
export function insertTaskStateTransition(
  db: OrcaDb,
  transition: {
    linearIssueId: string;
    fromStatus: string | null;
    toStatus: string;
    reason?: string;
    invocationId?: number;
  },
): void {
  db.insert(taskStateTransitions)
    .values({
      linearIssueId: transition.linearIssueId,
      fromStatus: transition.fromStatus ?? null,
      toStatus: transition.toStatus,
      reason: transition.reason ?? null,
      invocationId: transition.invocationId ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** Get all state transitions for a task, ordered oldest-first. */
export function getTaskStateTransitions(
  db: OrcaDb,
  taskId: string,
): TaskStateTransition[] {
  return db
    .select()
    .from(taskStateTransitions)
    .where(eq(taskStateTransitions.linearIssueId, taskId))
    .orderBy(asc(taskStateTransitions.id))
    .all();
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------
type NewAgent = InferInsertModel<typeof agents>;
export type AgentRow = typeof agents.$inferSelect;

// ---------------------------------------------------------------------------
// Agent queries
// ---------------------------------------------------------------------------

/** Insert a new agent. */
export function insertAgent(db: OrcaDb, agent: NewAgent): void {
  db.insert(agents).values(agent).run();
}

/** Update fields on an agent. */
export function updateAgent(
  db: OrcaDb,
  id: string,
  updates: Partial<Omit<NewAgent, "id" | "createdAt">>,
): void {
  db.update(agents)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(agents.id, id))
    .run();
}

/** Delete an agent and all its memories. */
export function deleteAgent(db: OrcaDb, id: string): void {
  db.delete(agentMemories).where(eq(agentMemories.agentId, id)).run();
  db.delete(agents).where(eq(agents.id, id)).run();
}

/** Get a single agent by id. */
export function getAgent(db: OrcaDb, id: string): AgentRow | undefined {
  return db.select().from(agents).where(eq(agents.id, id)).get();
}

/** Get all agents. */
export function getAllAgents(db: OrcaDb): AgentRow[] {
  return db.select().from(agents).all();
}

/**
 * Get agents that are due to run.
 * Filters: enabled=1, schedule IS NOT NULL, next_run_at IS NOT NULL, next_run_at <= now
 */
export function getDueAgents(db: OrcaDb, now: string): AgentRow[] {
  return db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.enabled, 1),
        isNotNull(agents.schedule),
        isNotNull(agents.nextRunAt),
        lte(agents.nextRunAt, now),
      ),
    )
    .all();
}

/** Update the lastRunStatus field on an agent. */
export function updateAgentLastRunStatus(
  db: OrcaDb,
  id: string,
  status: "success" | "failed",
): void {
  db.update(agents)
    .set({ lastRunStatus: status, updatedAt: new Date().toISOString() })
    .where(eq(agents.id, id))
    .run();
}

/** Increment run_count by 1 and update last_run_at and next_run_at. */
export function incrementAgentRunCount(
  db: OrcaDb,
  id: string,
  nextRunAt: string | null,
): void {
  db.update(agents)
    .set({
      runCount: sql`${agents.runCount} + 1`,
      lastRunAt: new Date().toISOString(),
      nextRunAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Agent memory types
// ---------------------------------------------------------------------------
export type AgentMemoryRow = typeof agentMemories.$inferSelect;

// ---------------------------------------------------------------------------
// Agent memory queries
// ---------------------------------------------------------------------------

/** Insert a new agent memory and return its auto-generated id. */
export function insertAgentMemory(
  db: OrcaDb,
  memory: {
    agentId: string;
    type: "episodic" | "semantic" | "procedural";
    content: string;
    sourceRunId?: string | null;
  },
): number {
  const result = db
    .insert(agentMemories)
    .values({
      agentId: memory.agentId,
      type: memory.type,
      content: memory.content,
      sourceRunId: memory.sourceRunId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning({ id: agentMemories.id })
    .get();
  return result.id;
}

/** Update the content of an agent memory. */
export function updateAgentMemory(
  db: OrcaDb,
  id: number,
  content: string,
): void {
  db.update(agentMemories)
    .set({ content, updatedAt: new Date().toISOString() })
    .where(eq(agentMemories.id, id))
    .run();
}

/** Delete a single agent memory by id. */
export function deleteAgentMemory(db: OrcaDb, id: number): void {
  db.delete(agentMemories).where(eq(agentMemories.id, id)).run();
}

/** Get memories for an agent, ordered by created_at DESC. */
export function getAgentMemories(
  db: OrcaDb,
  agentId: string,
  limit?: number,
): AgentMemoryRow[] {
  const query = db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.createdAt));
  if (limit) return query.limit(limit).all();
  return query.all();
}

/** Count memories for an agent. */
export function getAgentMemoryCount(db: OrcaDb, agentId: string): number {
  const result = db
    .select({ value: count() })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .get();
  return result?.value ?? 0;
}

/** Delete all memories for an agent. */
export function deleteAllAgentMemories(db: OrcaDb, agentId: string): void {
  db.delete(agentMemories).where(eq(agentMemories.agentId, agentId)).run();
}

/**
 * Prune agent memories beyond maxMemories, deleting the oldest first.
 * Returns the number of memories deleted.
 */
export function pruneAgentMemories(
  db: OrcaDb,
  agentId: string,
  maxMemories: number,
): number {
  const currentCount = getAgentMemoryCount(db, agentId);
  if (currentCount <= maxMemories) return 0;

  const toDelete = currentCount - maxMemories;
  const oldest = db
    .select({ id: agentMemories.id })
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agentId))
    .orderBy(asc(agentMemories.createdAt))
    .limit(toDelete)
    .all();

  for (const row of oldest) {
    db.delete(agentMemories).where(eq(agentMemories.id, row.id)).run();
  }
  return oldest.length;
}

/** Get all tasks spawned by a specific agent. */
export function getTasksByAgent(db: OrcaDb, agentId: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.agentId, agentId))
    .all();
}
