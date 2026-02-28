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
    case "In Review": return "done";
    case "Done": return "done";
    case "Canceled": return "failed";
    default: return null; // Backlog and unknown → skip
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
  const orcaStatus = mapLinearStateToOrcaStatus(issue.state.name);

  // Skip backlog and unknown states
  if (orcaStatus === null) return;

  const agentPrompt = buildPrompt(issue);
  const existing = getTask(db, issue.identifier);

  if (!existing) {
    const now = new Date().toISOString();
    insertTask(db, {
      linearIssueId: issue.identifier,
      agentPrompt,
      repoPath: config.defaultCwd,
      orcaStatus,
      priority: issue.priority,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // Always sync prompt, priority, and status from Linear
    updateTaskFields(db, issue.identifier, {
      agentPrompt,
      priority: issue.priority,
      orcaStatus,
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

  // Conflict case 1: Orca running, Linear Todo → kill session, reset to ready
  if (task.orcaStatus === "running" && linearStateName === "Todo") {
    // Find and kill active session for this task
    for (const [invId, handle] of activeHandles) {
      const runningInvocations = getRunningInvocations(db);
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
    updateTaskStatus(db, taskId, "ready");
    log(`conflict resolved: task ${taskId} reset to ready (Linear moved to Todo)`);
    return;
  }

  // Conflict case 2: Orca ready, Linear Done → set done
  if (task.orcaStatus === "ready" && linearStateName === "Done") {
    updateTaskStatus(db, taskId, "done");
    log(`conflict resolved: task ${taskId} set to done (Linear Done)`);
    return;
  }

  // Conflict case 3: Orca done, Linear Todo → reset to ready
  if (task.orcaStatus === "done" && linearStateName === "Todo") {
    updateTaskStatus(db, taskId, "ready");
    log(`conflict resolved: task ${taskId} reset to ready (Linear moved to Todo)`);
    return;
  }

  // Conflict case 4: Any, Linear Canceled → set failed (permanent, no retry)
  if (linearStateName === "Canceled") {
    // Kill active session if running
    if (task.orcaStatus === "running") {
      for (const [invId, handle] of activeHandles) {
        const runningInvocations = getRunningInvocations(db);
        const matchingInv = runningInvocations.find(
          (inv) => inv.linearIssueId === taskId && inv.id === invId,
        );
        if (matchingInv) {
          killSession(handle).catch((err) => {
            log(`error killing session for canceled task ${taskId}: ${err}`);
          });
          updateInvocation(db, invId, {
            status: "failed",
            endedAt: new Date().toISOString(),
            outputSummary: "canceled in Linear",
          });
          activeHandles.delete(invId);
          break;
        }
      }
    }
    updateTaskStatus(db, taskId, "failed");
    log(`conflict resolved: task ${taskId} set to failed (Linear Canceled)`);
    return;
  }
}

// ---------------------------------------------------------------------------
// 4.5 Write-back
// ---------------------------------------------------------------------------

export async function writeBackStatus(
  client: LinearClient,
  taskId: string,
  orcaTransition: "dispatched" | "done" | "failed_permanent" | "retry",
  stateMap: WorkflowStateMap,
): Promise<void> {
  const transitionToStateName: Record<string, string> = {
    dispatched: "In Progress",
    done: "In Review",
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
