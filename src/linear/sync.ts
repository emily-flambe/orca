// ---------------------------------------------------------------------------
// Linear sync — full sync, webhook processing, conflict resolution, write-back
// ---------------------------------------------------------------------------

import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient, LinearIssue, WorkflowStateMap } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import type { TaskStatus } from "../db/schema.js";
import {
  deleteTask,
  getTask,
  insertTask,
  updateTaskStatus,
  updateTaskFields,
  updateInvocation,
  getRunningInvocations,
} from "../db/queries.js";
import { activeHandles } from "../scheduler/index.js";
import { killSession } from "../runner/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export function isExpectedChange(
  taskId: string,
  stateName: string,
): boolean {
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
): TaskStatus | null {
  switch (stateName) {
    case "Todo": return "ready";
    case "In Progress": return "running";
    case "In Review": return "in_review";
    case "Done": return "done";
    default: return null; // Backlog, Canceled, and unknown → skip
  }
}

// ---------------------------------------------------------------------------
// 4.2 Upsert logic
// ---------------------------------------------------------------------------

function buildPrompt(issue: LinearIssue): string {
  return `${issue.title}\n\n${issue.description}`.trim();
}

function upsertTask(
  db: OrcaDb,
  issue: LinearIssue,
  config: OrcaConfig,
): void {
  // Canceled issues should not exist in Orca's DB at all
  if (issue.state.name === "Canceled") {
    const existing = getTask(db, issue.identifier);
    if (existing) {
      deleteTask(db, issue.identifier);
      log(`deleted canceled task ${issue.identifier}`);
    }
    return;
  }

  const orcaStatus = mapLinearStateToOrcaStatus(issue.state.name);

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

  if (!existing) {
    // On insert, intermediate Linear states ("In Progress", "In Review")
    // mean Orca previously dispatched this task but the DB was wiped or
    // this is a fresh instance. Since no agent is actually running, map
    // these to "ready" so the scheduler can re-dispatch them.
    const insertStatus =
      orcaStatus === "running" || orcaStatus === "in_review" ? "ready" : orcaStatus;
    const now = new Date().toISOString();
    insertTask(db, {
      linearIssueId: issue.identifier,
      agentPrompt,
      repoPath,
      orcaStatus: insertStatus,
      priority: issue.priority,
      retryCount: 0,
      doneAt: insertStatus === "done" ? now : null,
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
      orcaStatus === "ready" || orcaStatus === "done" || orcaStatus === "failed";
    const effectiveStatus = isUserOverride ? orcaStatus : existing.orcaStatus;

    // When Linear "Todo" overrides a non-ready state, reset retry/review counts
    // so the task gets a completely fresh start.
    const resetCounters = orcaStatus === "ready" && existing.orcaStatus !== "ready";

    updateTaskFields(db, issue.identifier, {
      agentPrompt,
      repoPath,
      priority: issue.priority,
      orcaStatus: effectiveStatus,
      ...(resetCounters ? { retryCount: 0, reviewCycleCount: 0 } : {}),
    });
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
): Promise<number> {
  const issues = await client.fetchProjectIssues(config.linearProjectIds);

  for (const issue of issues) {
    upsertTask(db, issue, config);
  }

  graph.rebuild(issues);

  log(`full sync complete: ${issues.length} issues`);
  return issues.length;
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
): Promise<void> {
  // Check for write-back echo
  const stateName = event.data.state?.name;
  if (stateName && isExpectedChange(event.data.identifier, stateName)) {
    log(`skipping echo webhook for ${event.data.identifier} (state: ${stateName})`);
    return;
  }

  if (event.action === "remove") {
    // Per spec: leave task as-is, don't delete from DB
    return;
  }

  // create or update: build a LinearIssue-like object from webhook data
  // Webhook data may not include full relations, so we construct a minimal issue
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
  };

  // Only upsert if we have state info
  if (event.data.state) {
    // Resolve conflicts BEFORE upsert overwrites the Orca status
    resolveConflict(db, event.data.identifier, event.data.state.name, config);

    upsertTask(db, issueFromEvent, config);
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
  _config: OrcaConfig,
): void {
  const task = getTask(db, taskId);
  if (!task) return;

  const expectedOrcaStatus = mapLinearStateToOrcaStatus(linearStateName);
  if (expectedOrcaStatus === null) return;

  // If statuses match, no conflict
  if (task.orcaStatus === expectedOrcaStatus) return;

  // Any state → Linear Todo: reset to ready with fresh retry/review counts.
  // This covers: running, done, in_review, changes_requested, deploying, failed.
  if (linearStateName === "Todo") {
    if (task.orcaStatus === "running" || task.orcaStatus === "in_review") {
      killRunningSession(db, taskId);
    }
    updateTaskFields(db, taskId, { orcaStatus: "ready", retryCount: 0, reviewCycleCount: 0 });
    log(`conflict resolved: task ${taskId} reset to ready from ${task.orcaStatus} (Linear moved to Todo)`);
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
    log(`conflict resolved: task ${taskId} set to done from in_review (Linear Done — human override)`);
    return;
  }

  // Conflict case 8: deploying, Linear "In Review" → no-op (expected state, don't overwrite)
  if (task.orcaStatus === "deploying" && linearStateName === "In Review") {
    return;
  }

  // Conflict case 10: deploying, Linear Done → mark done (human override, skip monitoring)
  if (task.orcaStatus === "deploying" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(`conflict resolved: task ${taskId} set to done from deploying (Linear Done — human override)`);
    return;
  }

  // Conflict case 7: Any, Linear Canceled → kill session if running, delete task
  if (linearStateName === "Canceled") {
    if (task.orcaStatus === "running") {
      killRunningSession(db, taskId);
    }
    deleteTask(db, taskId);
    log(`conflict resolved: task ${taskId} deleted (Linear Canceled)`);
    return;
  }
}

// ---------------------------------------------------------------------------
// 4.5 Write-back
// ---------------------------------------------------------------------------

export async function writeBackStatus(
  client: LinearClient,
  taskId: string,
  orcaTransition: "dispatched" | "in_review" | "deploying" | "done" | "changes_requested" | "failed_permanent" | "retry",
  stateMap: WorkflowStateMap,
): Promise<void> {
  // deploying is a no-op — Linear stays at "In Review", don't write back
  if (orcaTransition === "deploying") return;

  const transitionToStateName: Record<string, string> = {
    dispatched: "In Progress",
    in_review: "In Review",
    done: "Done",
    changes_requested: "In Progress",
    failed_permanent: "Canceled",
    retry: "Todo",
  };

  const targetStateName = transitionToStateName[orcaTransition];
  if (!targetStateName) {
    log(`write-back: unknown transition "${orcaTransition}" for task ${taskId}`);
    return;
  }

  const stateEntry = stateMap.get(targetStateName);
  if (!stateEntry) {
    log(`write-back: no state found for name "${targetStateName}"`);
    return;
  }

  // Register expected change for loop prevention before the API call
  registerExpectedChange(taskId, targetStateName);

  try {
    await client.updateIssueState(taskId, stateEntry.id);
    log(`wrote back status: task ${taskId} -> Linear state "${targetStateName}"`);
  } catch (err) {
    // Write-back failures are logged but do not block Orca's internal state transition
    log(`write-back failed for task ${taskId}: ${err}`);
  }
}
