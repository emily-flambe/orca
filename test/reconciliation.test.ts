// ---------------------------------------------------------------------------
// Stuck-task reconciliation tests
//
// Tests the DB state mutations of the reconciliation logic WITHOUT using
// Inngest. The runReconciliation helper mirrors the logic in
// src/inngest/workflows/reconciliation.ts but skips inngest.send() calls.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateTaskStatus,
  updateTaskFields,
  getTask,
  getAllTasks,
  getRunningInvocations,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const testConfig = {
  sessionTimeoutMin: 45,
  deployTimeoutMin: 30,
  awaitingCiTimeoutMin: 180,
  maxRetries: 3,
};
// sessionThresholdMs = (45 + 10) * 60 * 1000 = 3,300,000ms
// deployThresholdMs  = (30 + 10) * 60 * 1000 = 2,400,000ms
// awaitingCiThresholdMs = 180 * 60 * 1000 = 10,800,000ms

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

/** Returns an ISO timestamp that is `ms` milliseconds in the past. */
function ageAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function seedTask(
  db: OrcaDb,
  id: string,
  status: TaskStatus,
  updatedAt: string,
  retryCount = 0,
): void {
  const ts = new Date().toISOString();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test",
    repoPath: "/tmp/repo",
    orcaStatus: status,
    priority: 0,
    retryCount,
    createdAt: ts,
    updatedAt,
  });
}

/**
 * Mirrors the core reconciliation logic from
 * src/inngest/workflows/reconciliation.ts, but omits inngest.send() calls
 * so it is testable without Inngest.
 *
 * @param activeHandleIds - Set of invocation IDs that have an active handle
 *   (simulates what the activeHandles Map contains in production).
 */
function runReconciliation(
  db: OrcaDb,
  config: {
    sessionTimeoutMin: number;
    deployTimeoutMin: number;
    awaitingCiTimeoutMin: number;
    maxRetries: number;
  },
  activeHandleIds: Set<number>,
): { reconciled: string[]; failed: string[] } {
  const now = Date.now();
  const sessionThresholdMs = (config.sessionTimeoutMin + 10) * 60 * 1000;
  const deployThresholdMs = (config.deployTimeoutMin + 10) * 60 * 1000;
  const awaitingCiThresholdMs = config.awaitingCiTimeoutMin * 60 * 1000;

  const allTasks = getAllTasks(db);
  const runningInvocations = getRunningInvocations(db);

  const reconciled: string[] = [];
  const failed: string[] = [];

  for (const task of allTasks) {
    const taskId = task.linearIssueId;
    const updatedAt = new Date(task.updatedAt).getTime();
    const ageMs = now - updatedAt;

    let shouldReconcile = false;

    if (task.orcaStatus === "running" || task.orcaStatus === "dispatched") {
      if (ageMs > sessionThresholdMs) {
        const taskInvocations = runningInvocations.filter(
          (inv) => inv.linearIssueId === taskId,
        );
        const hasActiveHandle = taskInvocations.some((inv) =>
          activeHandleIds.has(inv.id),
        );
        if (!hasActiveHandle) {
          shouldReconcile = true;
        }
      }
    } else if (task.orcaStatus === "in_review") {
      if (ageMs > sessionThresholdMs) shouldReconcile = true;
    } else if (task.orcaStatus === "awaiting_ci") {
      if (ageMs > awaitingCiThresholdMs) shouldReconcile = true;
    } else if (task.orcaStatus === "deploying") {
      if (ageMs > deployThresholdMs) shouldReconcile = true;
    }

    if (!shouldReconcile) continue;

    if (task.retryCount >= config.maxRetries) {
      updateTaskStatus(db, taskId, "failed");
      failed.push(taskId);
    } else {
      updateTaskStatus(db, taskId, "ready");
      reconciled.push(taskId);
    }
  }

  return { reconciled, failed };
}

// ---------------------------------------------------------------------------
// Threshold constants (derived from testConfig — kept here for clarity)
// ---------------------------------------------------------------------------
const SESSION_THRESHOLD_MS = (testConfig.sessionTimeoutMin + 10) * 60 * 1000; // 3,300,000
const DEPLOY_THRESHOLD_MS = (testConfig.deployTimeoutMin + 10) * 60 * 1000; // 2,400,000
const AWAITING_CI_THRESHOLD_MS = testConfig.awaitingCiTimeoutMin * 60 * 1000; // 10,800,000

// ---------------------------------------------------------------------------
// Tests: running / dispatched state
// ---------------------------------------------------------------------------

describe("reconciliation — running/dispatched tasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("running task with old updatedAt and no active handle is reset to ready", () => {
    seedTask(db, "TASK-R1", "running", ageAgo(SESSION_THRESHOLD_MS + 1000));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-R1");
    expect(failed).not.toContain("TASK-R1");
    expect(getTask(db, "TASK-R1")?.orcaStatus).toBe("ready");
  });

  test("running task with old updatedAt but active handle is NOT reconciled", () => {
    seedTask(db, "TASK-R2", "running", ageAgo(SESSION_THRESHOLD_MS + 1000));
    // Insert a running invocation and treat its ID as having an active handle
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-R2",
      startedAt: new Date().toISOString(),
      status: "running",
      phase: "implement",
    });

    const { reconciled, failed } = runReconciliation(
      db,
      testConfig,
      new Set([invId]),
    );

    expect(reconciled).not.toContain("TASK-R2");
    expect(failed).not.toContain("TASK-R2");
    expect(getTask(db, "TASK-R2")?.orcaStatus).toBe("running");
  });

  test("dispatched task with old updatedAt and no active handle is reset to ready", () => {
    seedTask(db, "TASK-D1", "dispatched", ageAgo(SESSION_THRESHOLD_MS + 5000));

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-D1");
    expect(getTask(db, "TASK-D1")?.orcaStatus).toBe("ready");
  });

  test("running task with RECENT updatedAt is NOT reconciled", () => {
    // 1 second inside the threshold
    seedTask(db, "TASK-R3", "running", ageAgo(SESSION_THRESHOLD_MS - 1000));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-R3");
    expect(failed).not.toContain("TASK-R3");
    expect(getTask(db, "TASK-R3")?.orcaStatus).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Tests: in_review state
// ---------------------------------------------------------------------------

describe("reconciliation — in_review tasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("in_review task with old updatedAt is reset to ready", () => {
    seedTask(db, "TASK-IR1", "in_review", ageAgo(SESSION_THRESHOLD_MS + 2000));

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-IR1");
    expect(getTask(db, "TASK-IR1")?.orcaStatus).toBe("ready");
  });

  test("in_review task with recent updatedAt is NOT reconciled", () => {
    seedTask(db, "TASK-IR2", "in_review", ageAgo(SESSION_THRESHOLD_MS - 1000));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-IR2");
    expect(failed).not.toContain("TASK-IR2");
    expect(getTask(db, "TASK-IR2")?.orcaStatus).toBe("in_review");
  });
});

// ---------------------------------------------------------------------------
// Tests: awaiting_ci state
// ---------------------------------------------------------------------------

describe("reconciliation — awaiting_ci tasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("awaiting_ci task older than 3 hours is reset to ready", () => {
    seedTask(
      db,
      "TASK-AC1",
      "awaiting_ci",
      ageAgo(AWAITING_CI_THRESHOLD_MS + 5000),
    );

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-AC1");
    expect(getTask(db, "TASK-AC1")?.orcaStatus).toBe("ready");
  });

  test("awaiting_ci task with recent updatedAt is NOT reconciled", () => {
    // Just inside the 3-hour threshold
    seedTask(
      db,
      "TASK-AC2",
      "awaiting_ci",
      ageAgo(AWAITING_CI_THRESHOLD_MS - 60_000),
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-AC2");
    expect(failed).not.toContain("TASK-AC2");
    expect(getTask(db, "TASK-AC2")?.orcaStatus).toBe("awaiting_ci");
  });
});

// ---------------------------------------------------------------------------
// Tests: deploying state
// ---------------------------------------------------------------------------

describe("reconciliation — deploying tasks", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("deploying task older than deployThreshold is reset to ready", () => {
    seedTask(db, "TASK-DEP1", "deploying", ageAgo(DEPLOY_THRESHOLD_MS + 3000));

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-DEP1");
    expect(getTask(db, "TASK-DEP1")?.orcaStatus).toBe("ready");
  });

  test("deploying task with recent updatedAt is NOT reconciled", () => {
    seedTask(db, "TASK-DEP2", "deploying", ageAgo(DEPLOY_THRESHOLD_MS - 1000));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-DEP2");
    expect(failed).not.toContain("TASK-DEP2");
    expect(getTask(db, "TASK-DEP2")?.orcaStatus).toBe("deploying");
  });
});

// ---------------------------------------------------------------------------
// Tests: retry exhaustion → permanent failure
// ---------------------------------------------------------------------------

describe("reconciliation — retry exhaustion", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("task at maxRetries is marked failed, not ready", () => {
    seedTask(
      db,
      "TASK-FAIL1",
      "running",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
      testConfig.maxRetries, // retryCount === maxRetries
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(failed).toContain("TASK-FAIL1");
    expect(reconciled).not.toContain("TASK-FAIL1");
    expect(getTask(db, "TASK-FAIL1")?.orcaStatus).toBe("failed");
  });

  test("task exceeding maxRetries is also marked failed", () => {
    seedTask(
      db,
      "TASK-FAIL2",
      "in_review",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
      testConfig.maxRetries + 5,
    );

    const { failed } = runReconciliation(db, testConfig, new Set());

    expect(failed).toContain("TASK-FAIL2");
    expect(getTask(db, "TASK-FAIL2")?.orcaStatus).toBe("failed");
  });

  test("task one below maxRetries is reset to ready (not failed)", () => {
    seedTask(
      db,
      "TASK-RETRY",
      "running",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
      testConfig.maxRetries - 1,
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-RETRY");
    expect(failed).not.toContain("TASK-RETRY");
    expect(getTask(db, "TASK-RETRY")?.orcaStatus).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Tests: terminal and non-intermediate states are never reconciled
// ---------------------------------------------------------------------------

describe("reconciliation — terminal and non-intermediate states", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("done task is never reconciled regardless of age", () => {
    seedTask(db, "TASK-DONE", "done", ageAgo(SESSION_THRESHOLD_MS + 999_999));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-DONE");
    expect(failed).not.toContain("TASK-DONE");
    expect(getTask(db, "TASK-DONE")?.orcaStatus).toBe("done");
  });

  test("failed task is never reconciled regardless of age", () => {
    seedTask(
      db,
      "TASK-PERM-FAIL",
      "failed",
      ageAgo(SESSION_THRESHOLD_MS + 999_999),
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-PERM-FAIL");
    expect(failed).not.toContain("TASK-PERM-FAIL");
    // Status must remain "failed" (not re-failed, not reset)
    expect(getTask(db, "TASK-PERM-FAIL")?.orcaStatus).toBe("failed");
  });

  test("backlog task is never reconciled", () => {
    seedTask(
      db,
      "TASK-BACKLOG",
      "backlog",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-BACKLOG");
    expect(failed).not.toContain("TASK-BACKLOG");
    expect(getTask(db, "TASK-BACKLOG")?.orcaStatus).toBe("backlog");
  });

  test("ready task is never reconciled", () => {
    seedTask(db, "TASK-READY", "ready", ageAgo(SESSION_THRESHOLD_MS + 1000));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-READY");
    expect(failed).not.toContain("TASK-READY");
    expect(getTask(db, "TASK-READY")?.orcaStatus).toBe("ready");
  });

  test("changes_requested task is never reconciled", () => {
    seedTask(
      db,
      "TASK-CR",
      "changes_requested",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
    );

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).not.toContain("TASK-CR");
    expect(failed).not.toContain("TASK-CR");
    expect(getTask(db, "TASK-CR")?.orcaStatus).toBe("changes_requested");
  });
});

// ---------------------------------------------------------------------------
// Tests: multi-task pass
// ---------------------------------------------------------------------------

describe("reconciliation — multiple stranded tasks in one pass", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("all stranded tasks across different states are reconciled in a single pass", () => {
    const OLD = SESSION_THRESHOLD_MS + 5000;
    const OLD_CI = AWAITING_CI_THRESHOLD_MS + 5000;
    const OLD_DEPLOY = DEPLOY_THRESHOLD_MS + 5000;

    seedTask(db, "MULTI-RUNNING", "running", ageAgo(OLD));
    seedTask(db, "MULTI-DISPATCHED", "dispatched", ageAgo(OLD));
    seedTask(db, "MULTI-IN_REVIEW", "in_review", ageAgo(OLD));
    seedTask(db, "MULTI-AWAITING_CI", "awaiting_ci", ageAgo(OLD_CI));
    seedTask(db, "MULTI-DEPLOYING", "deploying", ageAgo(OLD_DEPLOY));
    // This one has retries exhausted — should be failed
    seedTask(
      db,
      "MULTI-EXHAUSTED",
      "running",
      ageAgo(OLD),
      testConfig.maxRetries,
    );
    // Terminal tasks should be untouched
    seedTask(db, "MULTI-DONE", "done", ageAgo(OLD));
    seedTask(db, "MULTI-FAILED", "failed", ageAgo(OLD));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    // Five tasks reset to ready
    expect(reconciled).toContain("MULTI-RUNNING");
    expect(reconciled).toContain("MULTI-DISPATCHED");
    expect(reconciled).toContain("MULTI-IN_REVIEW");
    expect(reconciled).toContain("MULTI-AWAITING_CI");
    expect(reconciled).toContain("MULTI-DEPLOYING");
    expect(reconciled).toHaveLength(5);

    // One permanently failed
    expect(failed).toContain("MULTI-EXHAUSTED");
    expect(failed).toHaveLength(1);

    // Terminal tasks untouched
    expect(getTask(db, "MULTI-DONE")?.orcaStatus).toBe("done");
    expect(getTask(db, "MULTI-FAILED")?.orcaStatus).toBe("failed");

    // Verify final statuses
    expect(getTask(db, "MULTI-RUNNING")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-DISPATCHED")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-IN_REVIEW")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-AWAITING_CI")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-DEPLOYING")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MULTI-EXHAUSTED")?.orcaStatus).toBe("failed");
  });

  test("a mix of stuck and healthy tasks only reconciles the stuck ones", () => {
    const OLD = SESSION_THRESHOLD_MS + 5000;
    const RECENT = SESSION_THRESHOLD_MS - 60_000;

    seedTask(db, "MIX-STUCK", "running", ageAgo(OLD));
    seedTask(db, "MIX-HEALTHY", "running", ageAgo(RECENT));

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("MIX-STUCK");
    expect(reconciled).not.toContain("MIX-HEALTHY");
    expect(getTask(db, "MIX-STUCK")?.orcaStatus).toBe("ready");
    expect(getTask(db, "MIX-HEALTHY")?.orcaStatus).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("reconciliation — edge cases", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("empty DB returns no reconciled or failed tasks", () => {
    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());
    expect(reconciled).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  test("task exactly at the session threshold boundary is NOT reconciled", () => {
    // updatedAt == now - SESSION_THRESHOLD_MS means ageMs == SESSION_THRESHOLD_MS,
    // which is NOT greater than the threshold — requires strict inequality.
    seedTask(db, "TASK-BOUNDARY", "running", ageAgo(SESSION_THRESHOLD_MS));

    const { reconciled, failed } = runReconciliation(db, testConfig, new Set());

    // Exact boundary: ageMs === threshold, so ageMs > threshold is FALSE
    expect(reconciled).not.toContain("TASK-BOUNDARY");
    expect(failed).not.toContain("TASK-BOUNDARY");
  });

  test("running task with inactive running invocation (no active handle) is reconciled", () => {
    // A running invocation exists in DB but its ID is NOT in activeHandleIds —
    // this simulates a zombie invocation record after a crash.
    seedTask(db, "TASK-ZOMBIE", "running", ageAgo(SESSION_THRESHOLD_MS + 1000));
    insertInvocation(db, {
      linearIssueId: "TASK-ZOMBIE",
      startedAt: new Date().toISOString(),
      status: "running",
      phase: "implement",
    });

    // Pass empty set — the invocation is in DB but has no active handle
    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-ZOMBIE");
    expect(getTask(db, "TASK-ZOMBIE")?.orcaStatus).toBe("ready");
  });

  test("dispatched task with active handle on its running invocation is NOT reconciled", () => {
    seedTask(
      db,
      "TASK-DISP-ACTIVE",
      "dispatched",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
    );
    const invId = insertInvocation(db, {
      linearIssueId: "TASK-DISP-ACTIVE",
      startedAt: new Date().toISOString(),
      status: "running",
      phase: "implement",
    });

    const { reconciled, failed } = runReconciliation(
      db,
      testConfig,
      new Set([invId]),
    );

    expect(reconciled).not.toContain("TASK-DISP-ACTIVE");
    expect(failed).not.toContain("TASK-DISP-ACTIVE");
    expect(getTask(db, "TASK-DISP-ACTIVE")?.orcaStatus).toBe("dispatched");
  });

  test("retryCount of 0 (default) is still reset to ready when stuck", () => {
    seedTask(
      db,
      "TASK-ZERO-RETRY",
      "running",
      ageAgo(SESSION_THRESHOLD_MS + 1000),
      0,
    );

    const { reconciled } = runReconciliation(db, testConfig, new Set());

    expect(reconciled).toContain("TASK-ZERO-RETRY");
    expect(getTask(db, "TASK-ZERO-RETRY")?.orcaStatus).toBe("ready");
  });
});
