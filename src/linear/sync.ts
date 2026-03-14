// ---------------------------------------------------------------------------
// Linear sync — full sync, webhook processing, conflict resolution, write-back
// ---------------------------------------------------------------------------

import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient, LinearIssue, WorkflowStateMap } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import type { TaskStatus } from "../db/schema.js";
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
import { activeHandles } from "../scheduler/index.js";
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
  overrides?: Record<string, string>,
  orcaStatus?: string,
): { id: string; type: string; name: string } | undefined {
  // Step 1: Check stateMapOverrides — reverse-lookup: find a key in overrides
  // whose value === orcaStatus, and if that key exists in stateMap with matching type, use it.
  if (overrides && orcaStatus !== undefined) {
    for (const [stateName, mappedStatus] of Object.entries(overrides)) {
      if (mappedStatus === orcaStatus) {
        const entry = stateMap.get(stateName);
        if (entry && entry.type === targetType) {
          return { id: entry.id, type: entry.type, name: stateName };
        }
      }
    }
  }

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

export const expectedChanges = new Map<
  string,
  { stateName: string; expiresAt: number }
>();

export function registerExpectedChange(
  taskId: string,
  stateName: string,
): void {
  expectedChanges.set(taskId, {
    stateName,
    expiresAt: Date.now() + 10_000,
  });
}

export function isExpectedChange(taskId: string, stateName: string): boolean {
  const entry = expectedChanges.get(taskId);
  if (!entry) return false;

  // Expired — remove and treat as non-echo
  if (Date.now() > entry.expiresAt) {
    expectedChanges.delete(taskId);
    return false;
  }

  // Matches — consume and return true
  if (entry.stateName === stateName) {
    expectedChanges.delete(taskId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/sync] ${message}`);
}

// ---------------------------------------------------------------------------
// 4.2 State mapping
// ---------------------------------------------------------------------------

function mapLinearStateToOrcaStatus(
  stateName: string,
  config?: OrcaConfig,
): TaskStatus | null {
  // Check overrides first
  if (config?.stateMapOverrides?.[stateName]) {
    const override = config.stateMapOverrides[stateName];
    if (override === "skip") return null;
    return override as TaskStatus;
  }
  switch (stateName) {
    case "Backlog":
      return "backlog";
    case "Todo":
      return "ready";
    case "In Progress":
      return "running";
    case "In Review":
      return "in_review";
    case "Done":
      return "done";
    default:
      return null; // Canceled and unknown → skip
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

function upsertTask(db: OrcaDb, issue: LinearIssue, config: OrcaConfig): void {
  // Canceled → transition existing tasks to failed; skip creating new ones.
  if (issue.state.name === "Canceled") {
    const existing = getTask(db, issue.identifier);
    if (existing) {
      updateTaskStatus(db, issue.identifier, "failed");
      log(`canceled task ${issue.identifier} → failed`);
      closePrsForCanceledTask(issue.identifier, existing.repoPath);
    }
    return;
  }

  const orcaStatus = mapLinearStateToOrcaStatus(issue.state.name, config);

  // Skip backlog and unknown states
  if (orcaStatus === null) return;

  // Resolve repo path: per-project map → defaultCwd fallback → skip
  const repoPath =
    config.projectRepoMap.get(issue.projectId) ?? config.defaultCwd;
  if (!repoPath) {
    log(
      `skipping ${issue.identifier}: no repo path for project ${issue.projectId}`,
    );
    return;
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
  }
}

// ---------------------------------------------------------------------------
// Parent status rollup
// ---------------------------------------------------------------------------

const ACTIVE_CHILD_STATUSES = new Set<string>([
  "dispatched",
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
      updateTaskStatus(db, parent.linearIssueId, "done");
      writeBackStatus(client, parent.linearIssueId, "done", stateMap).catch(
        (err) => {
          log(`write-back failed for parent ${parent.linearIssueId}: ${err}`);
        },
      );
      log(`parent ${parent.linearIssueId} → done (all children done)`);
    } else if (anyActive && parent.orcaStatus === "ready") {
      updateTaskStatus(db, parent.linearIssueId, "running");
      writeBackStatus(
        client,
        parent.linearIssueId,
        "dispatched",
        stateMap,
      ).catch((err) => {
        log(`write-back failed for parent ${parent.linearIssueId}: ${err}`);
      });
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
  labelIdCache?: Map<string, string>,
): Promise<LinearIssue[]> {
  const issues = await client.fetchProjectIssues(config.linearProjectIds);

  // Label filtering: if ORCA_TASK_FILTER_LABEL is set, only process matching issues
  let filteredIssues = issues;
  if (config.taskFilterLabel && labelIdCache) {
    // Refresh the label cache
    labelIdCache.clear();
    const labelId = await client.fetchLabelIdByName(config.taskFilterLabel);
    if (labelId) {
      labelIdCache.set(config.taskFilterLabel, labelId);
      filteredIssues = issues.filter((issue) =>
        issue.labels.includes(config.taskFilterLabel!),
      );
      log(
        `label filter: ${filteredIssues.length}/${issues.length} issues match label "${config.taskFilterLabel}"`,
      );
    } else {
      // Fail open: label not found in Linear, process all issues
      log(
        `label filter: label "${config.taskFilterLabel}" not found in Linear, processing all issues (fail open)`,
      );
    }
  }

  for (const issue of filteredIssues) {
    upsertTask(db, issue, config);
  }

  graph.rebuild(filteredIssues);

  // Evaluate parent statuses after all upserts
  if (stateMap) {
    await evaluateParentStatuses(db, client, stateMap);
  }

  emitTasksRefreshed();
  log(`full sync complete: ${filteredIssues.length} issues`);
  return filteredIssues;
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
  labelIdCache?: Map<string, string>,
): Promise<void> {
  // Label filtering: if configured and cache is populated, check labelIds
  if (config.taskFilterLabel && labelIdCache && labelIdCache.size > 0) {
    const requiredLabelId = labelIdCache.get(config.taskFilterLabel);
    if (requiredLabelId) {
      const eventLabelIds = event.data.labelIds;
      if (!eventLabelIds || !eventLabelIds.includes(requiredLabelId)) {
        log(
          `label filter: skipping webhook for ${event.data.identifier} (missing required label)`,
        );
        return;
      }
    }
  }

  // Check for write-back echo
  const stateName = event.data.state?.name;
  if (stateName && isExpectedChange(event.data.identifier, stateName)) {
    log(
      `skipping echo webhook for ${event.data.identifier} (state: ${stateName})`,
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
    // Resolve conflicts BEFORE upsert overwrites the Orca status
    resolveConflict(db, event.data.identifier, event.data.state.name, config);

    upsertTask(db, issueFromEvent, config);

    // Emit SSE event for the updated task
    const updatedTask = getTask(db, event.data.identifier);
    if (updatedTask) {
      emitTaskUpdated(updatedTask);
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
  config?: OrcaConfig,
): void {
  const task = getTask(db, taskId);
  if (!task) return;

  // Canceled must be checked before the null guard because
  // mapLinearStateToOrcaStatus returns null for Canceled.
  if (linearStateName === "Canceled") {
    if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
      killRunningSession(db, taskId);
    }
    updateTaskStatus(db, taskId, "failed");
    log(`conflict resolved: task ${taskId} → failed (Linear Canceled)`);
    closePrsForCanceledTask(taskId, task.repoPath);
    return;
  }

  const expectedOrcaStatus = mapLinearStateToOrcaStatus(
    linearStateName,
    config,
  );
  if (expectedOrcaStatus === null) return;

  // If statuses match, no conflict
  if (task.orcaStatus === expectedOrcaStatus) return;

  // Any state → Linear Backlog: reset to backlog.
  if (linearStateName === "Backlog") {
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

  // Any state → Linear Todo: reset to ready with fresh retry/review counts.
  // This covers: running, done, in_review, changes_requested, deploying, failed.
  if (linearStateName === "Todo") {
    if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
      killRunningSession(db, taskId);
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
  if (task.orcaStatus === "ready" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(`conflict resolved: task ${taskId} set to done (Linear Done)`);
    return;
  }

  // Conflict case 5: in_review, Linear Done → mark done (human override)
  if (task.orcaStatus === "in_review" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(
      `conflict resolved: task ${taskId} set to done from in_review (Linear Done — human override)`,
    );
    return;
  }

  // Conflict case 8: deploying, Linear "In Review" → no-op (expected state, don't overwrite)
  if (task.orcaStatus === "deploying" && linearStateName === "In Review") {
    return;
  }

  // Conflict case 8b: awaiting_ci, Linear "In Review" → no-op (expected state, don't overwrite)
  if (task.orcaStatus === "awaiting_ci" && linearStateName === "In Review") {
    return;
  }

  // Conflict case 10: deploying, Linear Done → mark done (human override, skip monitoring)
  if (task.orcaStatus === "deploying" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(
      `conflict resolved: task ${taskId} set to done from deploying (Linear Done — human override)`,
    );
    return;
  }

  // Conflict case 10b: awaiting_ci, Linear Done → mark done (human override, skip CI gate)
  if (task.orcaStatus === "awaiting_ci" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(
      `conflict resolved: task ${taskId} set to done from awaiting_ci (Linear Done — human override)`,
    );
    return;
  }

  // Note: Canceled is handled above the null guard at the top of this function.
}

// ---------------------------------------------------------------------------
// 4.5 Write-back
// ---------------------------------------------------------------------------

export async function writeBackStatus(
  client: LinearClient,
  taskId: string,
  orcaTransition:
    | "dispatched"
    | "in_review"
    | "deploying"
    | "awaiting_ci"
    | "done"
    | "changes_requested"
    | "failed_permanent"
    | "retry"
    | "backlog",
  stateMap: WorkflowStateMap,
  overrides?: Record<string, string>,
): Promise<void> {
  // deploying and awaiting_ci are no-ops — Linear stays at "In Review", don't write back
  if (orcaTransition === "deploying" || orcaTransition === "awaiting_ci")
    return;

  // Map each transition to { targetType, matchReview }
  const transitionTypeMap: Record<
    string,
    { targetType: string; matchReview?: boolean }
  > = {
    dispatched: { targetType: "started", matchReview: false },
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
    overrides,
    orcaTransition,
  );

  if (!stateEntry) {
    log(
      `write-back: no ${mapping.targetType} state found for transition "${orcaTransition}"`,
    );
    return;
  }

  // Register expected change for loop prevention before the API call
  // Use the actual state name returned from findStateByType
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

export function logStateMapping(
  stateMap: WorkflowStateMap,
  overrides?: Record<string, string>,
): void {
  const transitions: Array<{
    name: string;
    targetType: string;
    matchReview?: boolean;
  }> = [
    { name: "dispatched", targetType: "started", matchReview: false },
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
      overrides,
      transition.name,
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
    console.warn(
      '[orca/sync] warning: multiple started states exist but none contain "review" — in_review write-back will use first started state; add ORCA_STATE_MAP to disambiguate',
    );
  }
}
