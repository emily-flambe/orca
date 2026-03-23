// ---------------------------------------------------------------------------
// Linear sync — full sync, webhook processing, conflict resolution, write-back
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.js";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient, LinearIssue, WorkflowStateMap } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import type { TaskStatus } from "../db/schema.js";
import type { InngestClient } from "../inngest/client.js";
import {
  getTask,
  getChildTasks,
  getParentTasks,
  insertTask,
  updateTaskStatus,
  updateTaskFields,
  updateInvocation,
  getRunningInvocations,
} from "../db/queries.js";
import { activeHandles } from "../session-handles.js";
import { killSession } from "../runner/index.js";
import { closePrsForCanceledTask } from "../github/index.js";
import { emitTaskUpdated, emitTasksRefreshed } from "../events.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Returns the best WorkflowStateMap entry for the given type, applying preference logic. */
export function findStateByType(
  stateMap: WorkflowStateMap,
  targetType: string,
  matchReview?: boolean,
): { id: string; type: string; name: string } | undefined {
  // Collect all entries matching the target type
  const candidates: Array<{ id: string; type: string; name: string }> = [];
  for (const [name, entry] of stateMap.entries()) {
    if (entry.type === targetType) {
      candidates.push({ id: entry.id, type: entry.type, name });
    }
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Step 2: Preference logic for disambiguation
  // For "started" type: prefer name matching /review/i if matchReview=true,
  // prefer name NOT matching /review/i if matchReview=false
  if (matchReview !== undefined) {
    const reviewMatch = candidates.find((c) => /review/i.test(c.name));
    const nonReviewMatch = candidates.find((c) => !/review/i.test(c.name));

    if (matchReview && reviewMatch) return reviewMatch;
    if (!matchReview && nonReviewMatch) return nonReviewMatch;
    // Fall through to first if preferred variant not found
  }

  // For "completed" type: prefer exact name "Done"
  if (targetType === "completed") {
    const doneExact = candidates.find((c) => c.name === "Done");
    if (doneExact) return doneExact;
  }

  // Step 3: Fall back to first candidate (insertion order)
  return candidates[0];
}

export interface WebhookEvent {
  action: "create" | "update" | "remove";
  type: string; // "Issue"
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    priority: number;
    state?: { id: string; name: string; type: string };
    teamId?: string;
    projectId?: string;
    labelIds?: string[];
  };
}

// ---------------------------------------------------------------------------
// 4.6 Write-back loop prevention
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4.7 Post-deploy webhook grace period
// ---------------------------------------------------------------------------
// After a deploy, echo registrations from the old instance are lost. Webhooks
// triggered by the old instance's write-backs arrive at the new instance with
// no matching echo entries. To prevent false "Linear state change" kills, skip
// conflict resolution for state-change webhooks during a grace period after
// startup.

const STARTUP_GRACE_MS = 120_000;
let startupTimestamp = Date.now();

export function isInStartupGrace(): boolean {
  return Date.now() - startupTimestamp < STARTUP_GRACE_MS;
}

/** For testing: skip the startup grace period. */
export function clearStartupGrace(): void {
  startupTimestamp = 0;
}

// ---------------------------------------------------------------------------

export const expectedChanges = new Map<
  string,
  Array<{ stateName: string; expiresAt: number }>
>();

export function registerExpectedChange(
  taskId: string,
  stateName: string,
): void {
  const entries = expectedChanges.get(taskId) ?? [];
  entries.push({ stateName, expiresAt: Date.now() + 90_000 });
  expectedChanges.set(taskId, entries);
}

export function isExpectedChange(taskId: string, stateName: string): boolean {
  const entries = expectedChanges.get(taskId);
  if (!entries || entries.length === 0) return false;

  // Prune expired entries
  const now = Date.now();
  const valid = entries.filter((e) => now <= e.expiresAt);

  if (valid.length === 0) {
    expectedChanges.delete(taskId);
    return false;
  }

  // Find and consume a matching entry
  const matchIdx = valid.findIndex((e) => e.stateName === stateName);
  if (matchIdx >= 0) {
    valid.splice(matchIdx, 1);
    if (valid.length === 0) {
      expectedChanges.delete(taskId);
    } else {
      expectedChanges.set(taskId, valid);
    }
    return true;
  }

  // No match — update with pruned list
  expectedChanges.set(taskId, valid);
  return false;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logger = createLogger("sync");

function log(message: string): void {
  logger.info(message);
}

// ---------------------------------------------------------------------------
// 4.2 State mapping
// ---------------------------------------------------------------------------

function mapLinearStateToOrcaStatus(
  stateName: string,
  stateType: string,
): TaskStatus | null {
  switch (stateType) {
    case "backlog":
      return "backlog";
    case "unstarted":
      return "ready";
    case "started":
      return /review/i.test(stateName) ? "in_review" : "running";
    case "completed":
      return "done";
    case "canceled":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 4.2 Upsert logic
// ---------------------------------------------------------------------------

export function buildPrompt(issue: LinearIssue): string {
  const ownPrompt = `${issue.title}\n\n${issue.description}`.trim();
  if (issue.parentTitle) {
    return `## Parent Issue\n**${issue.parentTitle}**\n${issue.parentDescription ?? ""}\n\n---\n\n## This Issue\n${ownPrompt}`;
  }
  return ownPrompt;
}

function upsertTask(
  db: OrcaDb,
  issue: LinearIssue,
  config: OrcaConfig,
): boolean {
  // Canceled → transition existing tasks to failed; skip creating new ones.
  if (issue.state.type === "canceled") {
    const existing = getTask(db, issue.identifier);
    if (existing) {
      updateTaskStatus(db, issue.identifier, "failed", {
        reason: "linear_canceled",
      });
      log(`canceled task ${issue.identifier} → failed`);
      closePrsForCanceledTask(issue.identifier, existing.repoPath);
    }
    return false;
  }

  const orcaStatus = mapLinearStateToOrcaStatus(
    issue.state.name,
    issue.state.type,
  );

  // Skip backlog and unknown states
  if (orcaStatus === null) return false;

  // Resolve repo path: per-project map → defaultCwd fallback → skip
  const repoPath =
    config.projectRepoMap.get(issue.projectId) ?? config.defaultCwd;
  if (!repoPath) {
    log(
      `skipping ${issue.identifier}: no repo path for project ${issue.projectId}`,
    );
    return false;
  }

  const agentPrompt = buildPrompt(issue);
  const existing = getTask(db, issue.identifier);

  const parentIdentifier = issue.parentId ?? null;
  const isParent = (issue.childIds?.length ?? 0) > 0 ? 1 : 0;

  if (!existing) {
    // On insert, intermediate Linear states ("In Progress", "In Review")
    // mean Orca previously dispatched this task but the DB was wiped or
    // this is a fresh instance. Since no agent is actually running, map
    // these to "ready" so the scheduler can re-dispatch them.
    const insertStatus =
      orcaStatus === "running" || orcaStatus === "in_review"
        ? "ready"
        : orcaStatus;
    const now = new Date().toISOString();
    insertTask(db, {
      linearIssueId: issue.identifier,
      agentPrompt,
      repoPath,
      orcaStatus: insertStatus,
      priority: issue.priority,
      retryCount: 0,
      doneAt: insertStatus === "done" ? now : null,
      parentIdentifier,
      isParent,
      projectName: issue.projectName,
      createdAt: now,
      updatedAt: now,
    });
    return insertStatus === "ready";
  } else {
    // Determine whether Linear's state should override Orca's local status.
    //
    // User-initiated overrides (Todo, Done, Canceled) always win — these are
    // intentional actions in Linear that Orca must respect.
    //
    // Intermediate states ("In Progress" → running, "In Review" → in_review)
    // should NOT overwrite Orca's internal state during sync, because they are
    // typically echoes of Orca's own write-backs. Without this guard, a task
    // that Orca set to "ready" (via retry) or "failed" gets clobbered back to
    // "running" by fullSync seeing the stale "In Progress" in Linear.
    const isUserOverride =
      orcaStatus === "backlog" ||
      orcaStatus === "ready" ||
      orcaStatus === "done" ||
      orcaStatus === "failed";
    const effectiveStatus = isUserOverride ? orcaStatus : existing.orcaStatus;

    // When Linear "Todo" overrides a non-ready state, reset retry/review counts
    // so the task gets a completely fresh start.
    const resetCounters =
      orcaStatus === "ready" && existing.orcaStatus !== "ready";

    updateTaskFields(db, issue.identifier, {
      agentPrompt,
      repoPath,
      priority: issue.priority,
      orcaStatus: effectiveStatus,
      parentIdentifier,
      isParent,
      ...(issue.projectName ? { projectName: issue.projectName } : {}),
      ...(resetCounters
        ? {
            retryCount: 0,
            reviewCycleCount: 0,
            mergeAttemptCount: 0,
            staleSessionRetryCount: 0,
          }
        : {}),
    });
    return effectiveStatus === "ready" && existing.orcaStatus !== "ready";
  }
}

// ---------------------------------------------------------------------------
// Parent status rollup
// ---------------------------------------------------------------------------

const ACTIVE_CHILD_STATUSES = new Set<string>([
  "running",
  "in_review",
  "changes_requested",
  "deploying",
  "awaiting_ci",
]);

/**
 * Evaluate and update parent task statuses based on their children's progress.
 * If `parentIds` is provided, only those parents are evaluated; otherwise all parents.
 */
export async function evaluateParentStatuses(
  db: OrcaDb,
  client: LinearClient,
  stateMap: WorkflowStateMap,
  parentIds?: string[],
): Promise<void> {
  const parents = parentIds
    ? parentIds
        .map((id) => getTask(db, id))
        .filter(
          (t): t is NonNullable<typeof t> => t != null && t.isParent === 1,
        )
    : getParentTasks(db);

  for (const parent of parents) {
    const children = getChildTasks(db, parent.linearIssueId);
    if (children.length === 0) continue;

    const allDone = children.every((c) => c.orcaStatus === "done");
    const anyActive = children.some((c) =>
      ACTIVE_CHILD_STATUSES.has(c.orcaStatus),
    );

    if (allDone && parent.orcaStatus !== "done") {
      updateTaskStatus(db, parent.linearIssueId, "done", {
        reason: "all_children_done",
      });
      writeBackStatus(client, parent.linearIssueId, "done", stateMap).catch(
        (err) => {
          log(`write-back failed for parent ${parent.linearIssueId}: ${err}`);
        },
      );
      log(`parent ${parent.linearIssueId} → done (all children done)`);
    } else if (anyActive && parent.orcaStatus === "ready") {
      updateTaskStatus(db, parent.linearIssueId, "running", {
        reason: "child_activity_detected",
      });
      writeBackStatus(client, parent.linearIssueId, "running", stateMap).catch(
        (err) => {
          log(`write-back failed for parent ${parent.linearIssueId}: ${err}`);
        },
      );
      log(`parent ${parent.linearIssueId} → running (child activity detected)`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4.1 Full sync
// ---------------------------------------------------------------------------

export async function fullSync(
  db: OrcaDb,
  client: LinearClient,
  graph: DependencyGraph,
  config: OrcaConfig,
  stateMap?: WorkflowStateMap,
  inngest?: InngestClient,
): Promise<LinearIssue[]> {
  const issues = await client.fetchProjectIssues(config.linearProjectIds);

  const readyToEmit: string[] = [];
  for (const issue of issues) {
    const shouldEmit = upsertTask(db, issue, config);
    if (shouldEmit) readyToEmit.push(issue.identifier);
  }

  graph.rebuild(issues);

  // Evaluate parent statuses after all upserts
  if (stateMap) {
    await evaluateParentStatuses(db, client, stateMap);
  }

  if (inngest && readyToEmit.length > 0) {
    for (const id of readyToEmit) {
      const task = getTask(db, id);
      if (task) {
        inngest
          .send({
            name: "task/ready",
            data: {
              linearIssueId: task.linearIssueId,
              repoPath: task.repoPath,
              priority: task.priority,
              projectName: task.projectName ?? null,
              taskType: task.taskType,
              createdAt: task.createdAt,
            },
          })
          .catch((err: unknown) => {
            log(`failed to emit task/ready for ${id}: ${err}`);
          });
      }
    }
  }

  emitTasksRefreshed();
  log(`full sync complete: ${issues.length} issues`);
  return issues;
}

// ---------------------------------------------------------------------------
// 4.3 Process webhook event
// ---------------------------------------------------------------------------

export async function processWebhookEvent(
  db: OrcaDb,
  client: LinearClient,
  graph: DependencyGraph,
  config: OrcaConfig,
  stateMap: WorkflowStateMap,
  event: WebhookEvent,
  inngest?: InngestClient,
): Promise<void> {
  // Check for write-back echo
  const stateName = event.data.state?.name;
  if (stateName && isExpectedChange(event.data.identifier, stateName)) {
    log(
      `skipping echo webhook for ${event.data.identifier} (state: ${stateName})`,
    );
    return;
  }

  // During the post-deploy grace period, treat state-change webhooks for
  // EXISTING tasks as potential echoes from the old instance. New tasks
  // (action: create) always go through.
  if (stateName && isInStartupGrace() && event.action === "update") {
    log(
      `startup grace: deferring state-change webhook for ${event.data.identifier} (state: ${stateName}, ${Math.round((STARTUP_GRACE_MS - (Date.now() - startupTimestamp)) / 1000)}s remaining)`,
    );
    return;
  }

  if (event.action === "remove") {
    // Per spec: leave task as-is, don't delete from DB
    return;
  }

  // create or update: build a LinearIssue-like object from webhook data
  // Webhook data may not include full relations, so we construct a minimal issue
  // Webhook payloads don't include parent/children. For parentIdentifier and
  // isParent, we preserve whatever the DB already has (set during fullSync).
  // For prompt enrichment fields, we set null — the DB already has the correct
  // agentPrompt from fullSync.
  const existingTask = getTask(db, event.data.identifier);
  const issueFromEvent: LinearIssue = {
    id: event.data.id,
    identifier: event.data.identifier,
    title: event.data.title,
    description: event.data.description ?? "",
    priority: event.data.priority,
    state: event.data.state ?? { id: "", name: "", type: "" },
    teamId: event.data.teamId ?? "",
    projectId: event.data.projectId ?? "",
    relations: [],
    inverseRelations: [],
    parentId: existingTask?.parentIdentifier ?? null,
    parentTitle: null,
    parentDescription: null,
    projectName: "", // webhook payloads don't include project name; preserved via conditional update
    childIds: existingTask?.isParent ? ["_placeholder"] : [],
    labels: [],
  };

  // Only upsert if we have state info
  if (event.data.state) {
    // Capture previous state BEFORE resolveConflict modifies the DB
    const previousTask = getTask(db, event.data.identifier);
    const previousStatus = previousTask?.orcaStatus ?? null;

    // Resolve conflicts BEFORE upsert overwrites the Orca status
    resolveConflict(
      db,
      event.data.identifier,
      event.data.state.name,
      event.data.state.type,
    );

    upsertTask(db, issueFromEvent, config);

    // Emit SSE event for the updated task
    const updatedTask = getTask(db, event.data.identifier);
    if (updatedTask) {
      emitTaskUpdated(updatedTask);
    }

    // Emit Inngest events for state transitions
    if (inngest) {
      const finalTask = getTask(db, event.data.identifier);

      // Emit task/ready when task transitions to ready
      if (
        finalTask &&
        finalTask.orcaStatus === "ready" &&
        previousStatus !== "ready"
      ) {
        inngest
          .send({
            name: "task/ready",
            data: {
              linearIssueId: finalTask.linearIssueId,
              repoPath: finalTask.repoPath,
              priority: finalTask.priority,
              projectName: finalTask.projectName ?? null,
              taskType: finalTask.taskType,
              createdAt: finalTask.createdAt,
            },
          })
          .catch((err: unknown) => {
            log(
              `failed to emit task/ready for ${event.data.identifier}: ${err}`,
            );
          });
      }

      // Emit task/cancelled when Linear sends a cancelled state for an active task.
      // Skip terminal states (failed, done, backlog) — no active workflow to cancel.
      const CANCELLABLE_STATUSES = new Set<TaskStatus>([
        "ready",
        "running",
        "in_review",
        "changes_requested",
        "awaiting_ci",
        "deploying",
      ]);
      if (
        event.data.state.type === "canceled" &&
        previousTask &&
        previousStatus &&
        CANCELLABLE_STATUSES.has(previousStatus)
      ) {
        inngest
          .send({
            name: "task/cancelled",
            data: {
              linearIssueId: event.data.identifier,
              reason: "cancelled in Linear",
              retryCount: previousTask.retryCount,
              previousStatus,
            },
          })
          .catch((err: unknown) => {
            log(
              `failed to emit task/cancelled for ${event.data.identifier}: ${err}`,
            );
          });
      }
    }

    // If this is a child task, evaluate its parent's status
    if (updatedTask?.parentIdentifier) {
      evaluateParentStatuses(db, client, stateMap, [
        updatedTask.parentIdentifier,
      ]).catch((err) => {
        log(
          `parent eval failed after webhook for ${event.data.identifier}: ${err}`,
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4.4 Conflict resolution
// ---------------------------------------------------------------------------

/** Kill the running session for a task, if any. */
function killRunningSession(db: OrcaDb, taskId: string): void {
  const runningInvocations = getRunningInvocations(db);
  for (const [invId, handle] of activeHandles) {
    const matchingInv = runningInvocations.find(
      (inv) => inv.linearIssueId === taskId && inv.id === invId,
    );
    if (matchingInv) {
      killSession(handle).catch((err) => {
        log(`error killing session for task ${taskId}: ${err}`);
      });
      updateInvocation(db, invId, {
        status: "failed",
        endedAt: new Date().toISOString(),
        outputSummary: "interrupted by Linear state change",
      });
      activeHandles.delete(invId);
      break;
    }
  }
}

export function resolveConflict(
  db: OrcaDb,
  taskId: string,
  linearStateName: string,
  linearStateType: string,
): void {
  const task = getTask(db, taskId);
  if (!task) return;

  // Canceled — must be checked before null guard
  if (linearStateType === "canceled") {
    if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
      killRunningSession(db, taskId);
    }
    updateTaskStatus(db, taskId, "failed", { reason: "linear_canceled" });
    log(`conflict resolved: task ${taskId} → failed (Linear Canceled)`);
    closePrsForCanceledTask(taskId, task.repoPath);
    return;
  }

  const expectedOrcaStatus = mapLinearStateToOrcaStatus(
    linearStateName,
    linearStateType,
  );
  if (expectedOrcaStatus === null) return;

  // If statuses match, no conflict
  if (task.orcaStatus === expectedOrcaStatus) return;

  // Any state → Linear Backlog: reset to backlog.
  if (linearStateType === "backlog") {
    if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
      killRunningSession(db, taskId);
    }
    updateTaskFields(db, taskId, {
      orcaStatus: "backlog",
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
    });
    log(
      `conflict resolved: task ${taskId} reset to backlog from ${task.orcaStatus} (Linear moved to Backlog)`,
    );
    return;
  }

  // Any state → Linear unstarted (Todo): reset to ready with fresh retry/review counts.
  // Guard: if the task is in an active state and was recently updated (within 2 min),
  // this is almost certainly a stale webhook echo from a previous retry cycle or
  // pre-deploy write-back, not a genuine user action. Skip to avoid disrupting work.
  if (linearStateType === "unstarted") {
    const activeStates = ["running", "in_review"];
    if (activeStates.includes(task.orcaStatus)) {
      const updatedAgo = Date.now() - new Date(task.updatedAt).getTime();
      if (updatedAgo < 120_000) {
        log(
          `conflict suppressed: task ${taskId} is ${task.orcaStatus} (updated ${Math.round(updatedAgo / 1000)}s ago), ignoring stale "Todo" webhook`,
        );
        return;
      }
      if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
        killRunningSession(db, taskId);
      }
    }
    updateTaskFields(db, taskId, {
      orcaStatus: "ready",
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
    });
    log(
      `conflict resolved: task ${taskId} reset to ready from ${task.orcaStatus} (Linear moved to Todo)`,
    );
    return;
  }

  // Conflict case 2: Orca ready, Linear Done → set done
  if (task.orcaStatus === "ready" && linearStateType === "completed") {
    updateTaskStatus(db, taskId, "done", { reason: "linear_done_override" });
    log(`conflict resolved: task ${taskId} set to done (Linear Done)`);
    return;
  }

  // Conflict case 5: in_review, Linear Done → mark done (human override)
  if (task.orcaStatus === "in_review" && linearStateType === "completed") {
    updateTaskStatus(db, taskId, "done", { reason: "linear_done_override" });
    log(
      `conflict resolved: task ${taskId} set to done from in_review (Linear Done — human override)`,
    );
    return;
  }

  // Conflict case 8: deploying, Linear "started+review" → no-op
  if (
    task.orcaStatus === "deploying" &&
    linearStateType === "started" &&
    /review/i.test(linearStateName)
  ) {
    return;
  }

  // Conflict case 8b: awaiting_ci, Linear "started+review" → no-op
  if (
    task.orcaStatus === "awaiting_ci" &&
    linearStateType === "started" &&
    /review/i.test(linearStateName)
  ) {
    return;
  }

  // Conflict case 10: deploying, Linear Done → mark done (human override, skip monitoring)
  if (task.orcaStatus === "deploying" && linearStateType === "completed") {
    updateTaskStatus(db, taskId, "done", { reason: "linear_done_override" });
    log(
      `conflict resolved: task ${taskId} set to done from deploying (Linear Done — human override)`,
    );
    return;
  }

  // Conflict case 10b: awaiting_ci, Linear Done → mark done (human override, skip CI gate)
  if (task.orcaStatus === "awaiting_ci" && linearStateType === "completed") {
    updateTaskStatus(db, taskId, "done", { reason: "linear_done_override" });
    log(
      `conflict resolved: task ${taskId} set to done from awaiting_ci (Linear Done — human override)`,
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// 4.5 Write-back
// ---------------------------------------------------------------------------

export async function writeBackStatus(
  client: LinearClient,
  taskId: string,
  orcaTransition:
    | "running"
    | "in_review"
    | "deploying"
    | "awaiting_ci"
    | "done"
    | "changes_requested"
    | "failed_permanent"
    | "retry"
    | "backlog",
  stateMap: WorkflowStateMap,
): Promise<void> {
  // deploying and awaiting_ci are no-ops — Linear stays at "In Review", don't write back
  if (orcaTransition === "deploying" || orcaTransition === "awaiting_ci")
    return;

  // Map each transition to { targetType, matchReview }
  const transitionTypeMap: Record<
    string,
    { targetType: string; matchReview?: boolean }
  > = {
    running: { targetType: "started", matchReview: false },
    in_review: { targetType: "started", matchReview: true },
    done: { targetType: "completed" },
    changes_requested: { targetType: "started", matchReview: false },
    failed_permanent: { targetType: "canceled" },
    retry: { targetType: "unstarted" },
    backlog: { targetType: "backlog" },
  };

  const mapping = transitionTypeMap[orcaTransition];
  if (!mapping) {
    log(
      `write-back: unknown transition "${orcaTransition}" for task ${taskId}`,
    );
    return;
  }

  const stateEntry = findStateByType(
    stateMap,
    mapping.targetType,
    mapping.matchReview,
  );

  if (!stateEntry) {
    log(
      `write-back: no ${mapping.targetType} state found for transition "${orcaTransition}"`,
    );
    return;
  }

  // Register BEFORE the API call so the echo window covers API latency + webhook delay.
  // TTL is 90s to account for slow API calls + Linear webhook delivery lag,
  // especially during rapid retry-redispatch cycles where multiple state changes
  // compete for Linear's webhook pipeline.
  registerExpectedChange(taskId, stateEntry.name);

  try {
    await client.updateIssueState(taskId, stateEntry.id);
    log(
      `wrote back status: task ${taskId} -> Linear state "${stateEntry.name}"`,
    );
  } catch (err) {
    // Write-back failures are logged but do not block Orca's internal state transition
    log(`write-back failed for task ${taskId}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// 4.6 State mapping diagnostics
// ---------------------------------------------------------------------------

export function logStateMapping(stateMap: WorkflowStateMap): void {
  const transitions: Array<{
    name: string;
    targetType: string;
    matchReview?: boolean;
  }> = [
    { name: "running", targetType: "started", matchReview: false },
    { name: "in_review", targetType: "started", matchReview: true },
    { name: "done", targetType: "completed" },
    { name: "changes_requested", targetType: "started", matchReview: false },
    { name: "failed_permanent", targetType: "canceled" },
    { name: "retry", targetType: "unstarted" },
    { name: "backlog", targetType: "backlog" },
  ];

  for (const transition of transitions) {
    const resolved = findStateByType(
      stateMap,
      transition.targetType,
      transition.matchReview,
    );
    if (resolved) {
      log(
        `state mapping: ${transition.name} → ${resolved.name} (type: ${resolved.type})`,
      );
    } else {
      log(
        `state mapping: ${transition.name} → NOT FOUND (no ${transition.targetType} state)`,
      );
    }
  }

  // Check: multiple "started" states AND none contain "review"
  const startedStates: string[] = [];
  for (const [name, entry] of stateMap.entries()) {
    if (entry.type === "started") {
      startedStates.push(name);
    }
  }
  if (
    startedStates.length > 1 &&
    !startedStates.some((name) => /review/i.test(name))
  ) {
    logger.warn(
      'warning: multiple started states exist but none contain "review" — in_review write-back will use first started state; add ORCA_STATE_MAP to disambiguate',
    );
  }
}
