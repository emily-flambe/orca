// ---------------------------------------------------------------------------
// Stuck-task reconciliation tests (EMI-321)
// ---------------------------------------------------------------------------
//
// Tests for the stuck-task reconciliation workflow in
// src/inngest/workflows/reconciliation.ts.
//
// These tests replicate the reconciliation logic to verify behavior without
// spinning up the full Inngest workflow.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateTaskStatus,
  getTask,
  getDispatchableTasks,
  getAllTasks,
  incrementRetryCount,
  getRunningInvocations,
} from "../src/db/queries.js";
import { activeHandles } from "../src/session-handles.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

const BASE_TS = new Date("2026-03-15T00:00:00.000Z").getTime();

function tsAgo(ms: number): string {
  return new Date(BASE_TS - ms).toISOString();
}

function seedTask(
  db: OrcaDb,
  opts: {
    linearIssueId: string;
    orcaStatus:
      | "ready"
      | "dispatched"
      | "running"
      | "in_review"
      | "awaiting_ci"
      | "deploying"
      | "done"
      | "failed";
    retryCount?: number;
    updatedAt?: string;
    prBranchName?: string;
    prNumber?: number;
    mergeCommitSha?: string;
    ciStartedAt?: string;
    deployStartedAt?: string;
  },
): void {
  const ts = opts.updatedAt ?? new Date(BASE_TS).toISOString();
  insertTask(db, {
    linearIssueId: opts.linearIssueId,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    orcaStatus: opts.orcaStatus,
    priority: 0,
    retryCount: opts.retryCount ?? 0,
    prBranchName: opts.prBranchName ?? null,
    prNumber: opts.prNumber ?? null,
    mergeCommitSha: opts.mergeCommitSha ?? null,
    ciStartedAt: opts.ciStartedAt ?? null,
    deployStartedAt: opts.deployStartedAt ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
}

function seedRunningInvocation(db: OrcaDb, linearIssueId: string): number {
  const ts = new Date(BASE_TS).toISOString();
  return insertInvocation(db, {
    linearIssueId,
    startedAt: ts,
    status: "running",
    phase: "implement",
  });
}

// ---------------------------------------------------------------------------
// Reconciliation logic extracted for testing (mirrors reconciliation.ts)
// ---------------------------------------------------------------------------

interface ReconcileConfig {
  strandedTaskThresholdMin: number;
  sessionTimeoutMin: number;
  maxRetries: number;
}

interface ReconcileResult {
  reconciled: string[];
  reEmitted: Array<{ name: string; linearIssueId: string }>;
}

function runReconciliation(
  db: OrcaDb,
  config: ReconcileConfig,
  now: number = BASE_TS,
): ReconcileResult {
  const thresholdMs = config.strandedTaskThresholdMin * 60 * 1000;
  const sessionTimeoutMs = config.sessionTimeoutMin * 60 * 1000;
  const reconciled: string[] = [];
  const reEmitted: Array<{ name: string; linearIssueId: string }> = [];

  // Phase 1: dispatched/running with no active handle
  const runningInvocations = getRunningInvocations(db);
  const runningInvocationsByTask = new Map<string, number[]>();
  for (const inv of runningInvocations) {
    const existing = runningInvocationsByTask.get(inv.linearIssueId) ?? [];
    existing.push(inv.id);
    runningInvocationsByTask.set(inv.linearIssueId, existing);
  }

  const activeTasks = getDispatchableTasks(db, ["dispatched", "running"]);
  for (const task of activeTasks) {
    const age = now - new Date(task.updatedAt).getTime();
    if (age < thresholdMs) continue;

    const taskInvocations =
      runningInvocationsByTask.get(task.linearIssueId) ?? [];
    const hasActiveHandle = taskInvocations.some((id) => activeHandles.has(id));

    if (!hasActiveHandle) {
      if (task.retryCount >= config.maxRetries) {
        updateTaskStatus(db, task.linearIssueId, "failed");
      } else {
        incrementRetryCount(db, task.linearIssueId, "ready");
      }
      reconciled.push(task.linearIssueId);
    }
  }

  // Phase 2: in_review stuck past session timeout + threshold
  // Skip if there's still an active handle (legitimate long review).
  const inReviewTasks = getDispatchableTasks(db, ["in_review"]);
  for (const task of inReviewTasks) {
    const age = now - new Date(task.updatedAt).getTime();
    if (age < sessionTimeoutMs + thresholdMs) continue;

    const taskInvocations =
      runningInvocationsByTask.get(task.linearIssueId) ?? [];
    const hasActiveHandle = taskInvocations.some((id) => activeHandles.has(id));
    if (hasActiveHandle) continue;

    if (task.retryCount >= config.maxRetries) {
      updateTaskStatus(db, task.linearIssueId, "failed");
    } else {
      incrementRetryCount(db, task.linearIssueId, "ready");
    }
    reconciled.push(task.linearIssueId);
  }

  // Phase 3: awaiting_ci/deploying stuck past threshold
  // Fall back to reset when required fields are missing (can't re-emit).
  const allTasks = getAllTasks(db);
  const awaitingOrDeploying = allTasks.filter(
    (t) => t.orcaStatus === "awaiting_ci" || t.orcaStatus === "deploying",
  );
  for (const task of awaitingOrDeploying) {
    const age = now - new Date(task.updatedAt).getTime();
    if (age < thresholdMs) continue;

    if (task.orcaStatus === "awaiting_ci") {
      if (!task.prBranchName || task.prNumber == null) {
        // Fall back to reset
        if (task.retryCount >= config.maxRetries) {
          updateTaskStatus(db, task.linearIssueId, "failed");
        } else {
          incrementRetryCount(db, task.linearIssueId, "ready");
        }
        reconciled.push(task.linearIssueId);
        continue;
      }
      reEmitted.push({
        name: "task/awaiting-ci",
        linearIssueId: task.linearIssueId,
      });
    } else {
      if (!task.mergeCommitSha || task.prNumber == null) {
        // Fall back to reset
        if (task.retryCount >= config.maxRetries) {
          updateTaskStatus(db, task.linearIssueId, "failed");
        } else {
          incrementRetryCount(db, task.linearIssueId, "ready");
        }
        reconciled.push(task.linearIssueId);
        continue;
      }
      reEmitted.push({
        name: "task/deploying",
        linearIssueId: task.linearIssueId,
      });
    }
    reconciled.push(task.linearIssueId);
  }

  return { reconciled, reEmitted };
}

// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ReconcileConfig = {
  strandedTaskThresholdMin: 15,
  sessionTimeoutMin: 45,
  maxRetries: 3,
};

const THRESHOLD_MS = DEFAULT_CONFIG.strandedTaskThresholdMin * 60 * 1000;
const SESSION_TIMEOUT_MS = DEFAULT_CONFIG.sessionTimeoutMin * 60 * 1000;

// ---------------------------------------------------------------------------

describe("Phase 1: dispatched/running tasks without active handle", () => {
  afterEach(() => {
    activeHandles.clear();
  });

  test("dispatched task with no active handle + age > threshold → reset to ready", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-1",
      orcaStatus: "dispatched",
      retryCount: 0,
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-1");
    const task = getTask(db, "PROJ-1");
    expect(task?.orcaStatus).toBe("ready");
    expect(task?.retryCount).toBe(1);
  });

  test("dispatched task with no active handle + retries exhausted → status failed", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-2",
      orcaStatus: "dispatched",
      retryCount: 3, // maxRetries = 3
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-2");
    const task = getTask(db, "PROJ-2");
    expect(task?.orcaStatus).toBe("failed");
  });

  test("running task with an active handle → NOT reconciled", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-3",
      orcaStatus: "running",
      retryCount: 0,
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
    });
    const invId = seedRunningInvocation(db, "PROJ-3");
    // Simulate an active handle
    activeHandles.set(invId, {} as never);

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).not.toContain("PROJ-3");
    const task = getTask(db, "PROJ-3");
    expect(task?.orcaStatus).toBe("running");
  });

  test("dispatched task newer than threshold → NOT reconciled", () => {
    const db = freshDb();
    // updatedAt is only 5 minutes ago, below the 15-minute threshold
    seedTask(db, {
      linearIssueId: "PROJ-4",
      orcaStatus: "dispatched",
      retryCount: 0,
      updatedAt: tsAgo(5 * 60 * 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).not.toContain("PROJ-4");
    const task = getTask(db, "PROJ-4");
    expect(task?.orcaStatus).toBe("dispatched");
  });
});

// ---------------------------------------------------------------------------

describe("Phase 2: in_review tasks stuck past timeout + threshold", () => {
  test("in_review task older than sessionTimeoutMs + thresholdMs → reset to ready", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-10",
      orcaStatus: "in_review",
      retryCount: 0,
      updatedAt: tsAgo(SESSION_TIMEOUT_MS + THRESHOLD_MS + 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-10");
    const task = getTask(db, "PROJ-10");
    expect(task?.orcaStatus).toBe("ready");
    expect(task?.retryCount).toBe(1);
  });

  test("in_review task that is recent → NOT reconciled", () => {
    const db = freshDb();
    // Only 20 minutes old — well below the 45+15=60 minute threshold
    seedTask(db, {
      linearIssueId: "PROJ-11",
      orcaStatus: "in_review",
      retryCount: 0,
      updatedAt: tsAgo(20 * 60 * 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).not.toContain("PROJ-11");
    const task = getTask(db, "PROJ-11");
    expect(task?.orcaStatus).toBe("in_review");
  });

  test("in_review task with active handle → NOT reconciled despite age", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-13",
      orcaStatus: "in_review",
      retryCount: 0,
      updatedAt: tsAgo(SESSION_TIMEOUT_MS + THRESHOLD_MS + 1000),
    });
    const invId = seedRunningInvocation(db, "PROJ-13");
    activeHandles.set(invId, {} as never);

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).not.toContain("PROJ-13");
    const task = getTask(db, "PROJ-13");
    expect(task?.orcaStatus).toBe("in_review");

    activeHandles.delete(invId);
  });

  test("in_review task with exhausted retries → marked failed", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-12",
      orcaStatus: "in_review",
      retryCount: 3,
      updatedAt: tsAgo(SESSION_TIMEOUT_MS + THRESHOLD_MS + 1000),
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-12");
    const task = getTask(db, "PROJ-12");
    expect(task?.orcaStatus).toBe("failed");
  });
});

// ---------------------------------------------------------------------------

describe("Phase 3: awaiting_ci/deploying tasks stuck past threshold", () => {
  test("awaiting_ci task older than threshold → included in reconciled (re-emit)", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-20",
      orcaStatus: "awaiting_ci",
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
      prBranchName: "orca/PROJ-20",
      prNumber: 42,
    });

    const { reconciled, reEmitted } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-20");
    expect(reEmitted).toContainEqual({
      name: "task/awaiting-ci",
      linearIssueId: "PROJ-20",
    });
  });

  test("deploying task older than threshold → included in reconciled (re-emit)", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-21",
      orcaStatus: "deploying",
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
      mergeCommitSha: "abc123",
      prNumber: 99,
    });

    const { reconciled, reEmitted } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("PROJ-21");
    expect(reEmitted).toContainEqual({
      name: "task/deploying",
      linearIssueId: "PROJ-21",
    });
  });

  test("awaiting_ci task missing prBranchName → reset to ready (cannot re-emit, fall back)", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-22",
      orcaStatus: "awaiting_ci",
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
      prNumber: 10,
      // prBranchName intentionally omitted
    });

    const { reconciled, reEmitted } = runReconciliation(db, DEFAULT_CONFIG);

    // Task IS reconciled (reset to ready) even though we can't re-emit
    expect(reconciled).toContain("PROJ-22");
    expect(reEmitted.map((e) => e.linearIssueId)).not.toContain("PROJ-22");
    const task = getTask(db, "PROJ-22");
    expect(task?.orcaStatus).toBe("ready");
  });

  test("awaiting_ci task newer than threshold → NOT reconciled", () => {
    const db = freshDb();
    seedTask(db, {
      linearIssueId: "PROJ-23",
      orcaStatus: "awaiting_ci",
      updatedAt: tsAgo(5 * 60 * 1000),
      prBranchName: "orca/PROJ-23",
      prNumber: 5,
    });

    const { reconciled } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).not.toContain("PROJ-23");
  });
});

// ---------------------------------------------------------------------------

describe("Multiple stranded tasks of different types all get reconciled", () => {
  afterEach(() => {
    activeHandles.clear();
  });

  test("all stranded task types are reconciled in a single run", () => {
    const db = freshDb();

    // Phase 1: dispatched with no handle
    seedTask(db, {
      linearIssueId: "MULTI-1",
      orcaStatus: "dispatched",
      retryCount: 0,
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
    });

    // Phase 1: running with no handle (has invocation but no active handle)
    seedTask(db, {
      linearIssueId: "MULTI-2",
      orcaStatus: "running",
      retryCount: 1,
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
    });
    seedRunningInvocation(db, "MULTI-2");
    // Note: no activeHandles entry for MULTI-2

    // Phase 2: in_review past timeout
    seedTask(db, {
      linearIssueId: "MULTI-3",
      orcaStatus: "in_review",
      retryCount: 0,
      updatedAt: tsAgo(SESSION_TIMEOUT_MS + THRESHOLD_MS + 1000),
    });

    // Phase 3: awaiting_ci
    seedTask(db, {
      linearIssueId: "MULTI-4",
      orcaStatus: "awaiting_ci",
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
      prBranchName: "orca/MULTI-4",
      prNumber: 7,
    });

    // Phase 3: deploying
    seedTask(db, {
      linearIssueId: "MULTI-5",
      orcaStatus: "deploying",
      updatedAt: tsAgo(THRESHOLD_MS + 1000),
      mergeCommitSha: "deadbeef",
      prNumber: 8,
    });

    // Not stranded: fresh dispatched task
    seedTask(db, {
      linearIssueId: "MULTI-6",
      orcaStatus: "dispatched",
      retryCount: 0,
      updatedAt: tsAgo(2 * 60 * 1000),
    });

    const { reconciled, reEmitted } = runReconciliation(db, DEFAULT_CONFIG);

    expect(reconciled).toContain("MULTI-1");
    expect(reconciled).toContain("MULTI-2");
    expect(reconciled).toContain("MULTI-3");
    expect(reconciled).toContain("MULTI-4");
    expect(reconciled).toContain("MULTI-5");
    expect(reconciled).not.toContain("MULTI-6");

    expect(reconciled.length).toBe(5);

    expect(reEmitted).toContainEqual({
      name: "task/awaiting-ci",
      linearIssueId: "MULTI-4",
    });
    expect(reEmitted).toContainEqual({
      name: "task/deploying",
      linearIssueId: "MULTI-5",
    });

    // Verify phase 1 tasks were reset to ready
    expect(getTask(db, "MULTI-1")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-2")?.orcaStatus).toBe("ready");
    // Verify phase 2 task was reset to ready
    expect(getTask(db, "MULTI-3")?.orcaStatus).toBe("ready");
  });
});
