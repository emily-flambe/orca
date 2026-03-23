// ---------------------------------------------------------------------------
// Failure observability tests — inferPhaseFromReason + updateTaskStatus failure metadata
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  updateTaskStatus,
  getTask,
  inferPhaseFromReason,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Helpers (match existing db.test.ts patterns)
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

let counter = 0;
function makeTaskId(): string {
  return `FAIL-${++counter}`;
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    orcaStatus: TaskStatus;
    retryCount: number;
  }> = {},
): string {
  const ts = new Date().toISOString();
  const id = overrides.linearIssueId ?? makeTaskId();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "test prompt",
    repoPath: "/tmp/test",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

// ---------------------------------------------------------------------------
// inferPhaseFromReason
// ---------------------------------------------------------------------------

describe("inferPhaseFromReason", () => {
  // Implement phase reasons
  test.each([
    ["session_timed_out", "implement"],
    ["session_failed_db_fallback", "implement"],
    ["implement_failed", "implement"],
    ["gate2_no_branch", "implement"],
    ["gate2_no_pr", "implement"],
    ["runner_error_db_fallback", "implement"],
  ])("%s → %s", (reason, expected) => {
    expect(inferPhaseFromReason(reason)).toBe(expected);
  });

  // Review phase reasons
  test("review_session_failed → review", () => {
    expect(inferPhaseFromReason("review_session_failed")).toBe("review");
  });

  // Fix phase reasons
  test("fix_session_failed → fix", () => {
    expect(inferPhaseFromReason("fix_session_failed")).toBe("fix");
  });

  // CI/merge phase reasons
  test.each([
    ["ci_timeout", "ci"],
    ["ci_poll_exhausted", "ci"],
    ["merge_conflict_cycles_exhausted", "ci"],
    ["merge_attempts_exhausted", "ci"],
  ])("%s → %s", (reason, expected) => {
    expect(inferPhaseFromReason(reason)).toBe(expected);
  });

  // Deploy phase reasons
  test.each([
    ["deploy_timeout", "deploy"],
    ["deploy_ci_failed", "deploy"],
    ["deploy_poll_exhausted", "deploy"],
  ])("%s → %s", (reason, expected) => {
    expect(inferPhaseFromReason(reason)).toBe(expected);
  });

  // Agent/cron task reasons
  test.each([
    ["agent_session_failed", "implement"],
    ["agent_session_timeout", "implement"],
    ["cron_session_failed", "implement"],
    ["cron_session_timeout", "implement"],
  ])("%s → %s", (reason, expected) => {
    expect(inferPhaseFromReason(reason)).toBe(expected);
  });

  // Unknown reasons
  test.each([
    "reconciled_stranded: something",
    "unknown_reason",
    "",
  ])("unknown reason '%s' → null", (reason) => {
    expect(inferPhaseFromReason(reason)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateTaskStatus failure metadata
// ---------------------------------------------------------------------------

describe("updateTaskStatus failure metadata", () => {
  let db: OrcaDb;

  beforeEach(() => {
    counter = 0;
    db = freshDb();
  });

  test("status=failed with reason populates all failure fields", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "failed", { reason: "implement_failed" });
    const task = getTask(db, id)!;

    expect(task.lastFailureReason).toBe("implement_failed");
    expect(task.lastFailedPhase).toBe("implement");
    expect(task.lastFailedAt).not.toBeNull();
  });

  test("status=failed without reason still sets lastFailedAt", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "failed");
    const task = getTask(db, id)!;

    expect(task.lastFailureReason).toBeNull();
    expect(task.lastFailedPhase).toBeNull();
    expect(task.lastFailedAt).not.toBeNull();
  });

  test("non-failed status does not set failure fields", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "done");
    const task = getTask(db, id)!;

    expect(task.lastFailureReason).toBeNull();
    expect(task.lastFailedPhase).toBeNull();
    expect(task.lastFailedAt).toBeNull();
  });

  test("failure fields persist through retry back to ready", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "failed", { reason: "ci_timeout" });
    const afterFail = getTask(db, id)!;

    // Reset to ready (retry)
    updateTaskStatus(db, id, "ready");
    const afterReady = getTask(db, id)!;

    // Failure fields should persist — they describe the last failure
    expect(afterReady.lastFailureReason).toBe(afterFail.lastFailureReason);
    expect(afterReady.lastFailedPhase).toBe(afterFail.lastFailedPhase);
    expect(afterReady.lastFailedAt).toBe(afterFail.lastFailedAt);
  });

  test("second failure with reason overwrites first failure fields", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "failed", { reason: "implement_failed" });

    // Retry and fail again with different reason
    updateTaskStatus(db, id, "ready");
    updateTaskStatus(db, id, "running");
    updateTaskStatus(db, id, "failed", { reason: "gate2_no_pr" });

    const task = getTask(db, id)!;
    expect(task.lastFailureReason).toBe("gate2_no_pr");
    expect(task.lastFailedPhase).toBe("implement");
  });

  test("status=failed with empty string reason still updates lastFailedAt", () => {
    const id = seedTask(db, { orcaStatus: "running" });
    updateTaskStatus(db, id, "failed", { reason: "" });
    const task = getTask(db, id)!;

    expect(task.lastFailureReason).toBeNull();
    expect(task.lastFailedPhase).toBeNull();
    expect(task.lastFailedAt).not.toBeNull();
  });
});
