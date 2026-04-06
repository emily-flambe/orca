// ---------------------------------------------------------------------------
// Stuck-task reconciliation tests (EMI-321)
// ---------------------------------------------------------------------------
//
// Tests for runReconciliation() in src/inngest/workflows/reconcile-stuck-tasks.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  getTask,
  updateTaskFields,
  getFailedTasksWithRetriesRemaining,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

const mockInngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    send: mockInngestSend,
    createFunction: () => ({ id: "reconcile-stuck-tasks" }),
  },
}));

vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
  sweepExitedHandles: vi.fn(),
}));

const { runReconciliation } =
  await import("../src/inngest/workflows/reconcile-stuck-tasks.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    lifecycleStage: string;
    currentPhase: string | null;
    retryCount: number;
    updatedAt: string;
    createdAt: string;
  }> = {},
): string {
  const id =
    overrides.linearIssueId ??
    `TEST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const ts = overrides.createdAt ?? now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    lifecycleStage: (overrides.lifecycleStage ?? "ready") as any,
    currentPhase: (overrides.currentPhase ?? null) as any,
    priority: 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: ts,
    updatedAt: overrides.updatedAt ?? ts,
  });
  return id;
}

function seedRunningInvocation(db: OrcaDb, taskId: string): number {
  return insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    status: "running",
  });
}

function makeConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    projectRepoMap: new Map(),
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    fixSystemPrompt: "",
    disallowedTools: "",
    model: "sonnet",
    deployStrategy: "none",
    maxDeployPollAttempts: 60,
    maxCiPollAttempts: 240,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("runReconciliation — running (handle-based detection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("running task with no active handle (older than grace period) is reset to ready", async () => {
    const db = freshDb();
    // Must be older than the 2-minute grace period
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      updatedAt: ago(5),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    const task = getTask(db, id)!;
    expect(task.lifecycleStage).toBe("ready");
    expect(task.currentPhase).toBeNull();
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  test("running task within grace period (< 2 min old) is NOT reset", async () => {
    const db = freshDb();
    // Just claimed — should not be reconciled yet
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
    }); // updatedAt defaults to now()
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    const task = getTask(db, id)!;
    expect(task.lifecycleStage).toBe("active");
    expect(task.currentPhase).toBe("implement");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("running task with no active handle is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      updatedAt: ago(5),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    const task = getTask(db, id)!;
    expect(task.lifecycleStage).toBe("ready");
  });

  test("running task WITH an active handle is NOT reset", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
    });
    const invId = seedRunningInvocation(db, id);
    const handles = new Map<number, unknown>([[invId, { pid: 1234 }]]);

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("active");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("running task with exhausted retries is marked failed", async () => {
    const db = freshDb();
    // retryCount=3, newStaleCount=1, totalAttempts=4 > maxRetries=3 → failed
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      retryCount: 3,
      updatedAt: ago(5),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig({ maxRetries: 3 }),
      activeHandles: handles,
    });

    const task = getTask(db, id)!;
    expect(task.lifecycleStage).toBe("failed");
    expect(task.currentPhase).toBeNull();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// Review reconciliation tests removed in EMI-504 (review phase removal)

describe("runReconciliation — awaiting_ci / deploying (time-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("awaiting_ci task older than threshold is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "ci",
      updatedAt: ago(70),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("ready");
  });

  test("awaiting_ci task newer than threshold is NOT reset", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "ci",
      updatedAt: ago(25),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("active");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("deploying task older than threshold is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "deploy",
      updatedAt: ago(70),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("ready");
  });

  test("active/fix task older than threshold is reset to ready", async () => {
    // Regression: getDispatchableTasks("changes_requested") previously fell
    // to the default case and queried lifecycleStage='changes_requested',
    // which never matches anything. Tasks stuck in active/fix after a merge
    // conflict would be invisible to the reconciler and strand forever.
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "fix",
      updatedAt: ago(70),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("ready");
  });

  test("active/fix task newer than threshold is NOT reset", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "fix",
      updatedAt: ago(25),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("active");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("awaiting_ci with exhausted retries is marked failed", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "ci",
      updatedAt: ago(70),
      retryCount: 3,
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig({ maxRetries: 3 }),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.lifecycleStage).toBe("failed");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("runReconciliation — terminal states are never touched", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("ready, done, failed tasks are left unchanged", async () => {
    const db = freshDb();
    const readyId = seedTask(db, {
      lifecycleStage: "ready",
      updatedAt: ago(200),
    });
    const doneId = seedTask(db, {
      lifecycleStage: "done",
      updatedAt: ago(200),
    });
    const failedId = seedTask(db, {
      lifecycleStage: "failed",
      updatedAt: ago(200),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, readyId)?.lifecycleStage).toBe("ready");
    expect(getTask(db, doneId)?.lifecycleStage).toBe("done");
    expect(getTask(db, failedId)?.lifecycleStage).toBe("failed");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("no tasks at all results in no errors", async () => {
    const db = freshDb();
    const handles = new Map<number, unknown>();
    await expect(
      runReconciliation({ db, config: makeConfig(), activeHandles: handles }),
    ).resolves.not.toThrow();
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("runReconciliation — multiple tasks in one pass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("reconciles all stranded tasks in a single pass", async () => {
    const db = freshDb();
    const t1 = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      updatedAt: ago(5),
    });
    const t2 = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      updatedAt: ago(5),
    });
    const t3 = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "ci",
      updatedAt: ago(70),
    });
    // This task has a live handle — should be left alone
    const t4 = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
    });
    const inv4 = seedRunningInvocation(db, t4);
    const handles = new Map<number, unknown>([[inv4, { pid: 9999 }]]);

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(getTask(db, t1)?.lifecycleStage).toBe("ready");
    expect(getTask(db, t2)?.lifecycleStage).toBe("ready");
    expect(getTask(db, t3)?.lifecycleStage).toBe("ready");
    expect(getTask(db, t4)?.lifecycleStage).toBe("active"); // untouched
    expect(mockInngestSend).toHaveBeenCalledTimes(3);
  });

  test("task/ready event includes correct linearIssueId and repoPath", async () => {
    const db = freshDb();
    const _id = seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      linearIssueId: "PROJ-42",
      updatedAt: ago(5),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig(),
      activeHandles: handles,
    });

    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "task/ready",
        data: expect.objectContaining({
          linearIssueId: "PROJ-42",
          repoPath: "/tmp/fake-repo",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------

// stale count reset tests removed in EMI-504 (staleSessionRetryCount removed)

// ---------------------------------------------------------------------------

describe("auto-retry-failed-tasks — getFailedTasksWithRetriesRemaining", () => {
  test("failed task with retries remaining is returned", () => {
    const db = freshDb();
    // retryCount=1, staleSessionRetryCount=0, sum=1 < maxRetries=3 → included
    const id = seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 1,
    });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(1);
    expect(result[0].linearIssueId).toBe(id);
  });

  test("failed task at max retries is NOT returned", () => {
    const db = freshDb();
    // retryCount=3, not < 3 → excluded
    seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 3,
    });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(0);
  });

  test("cron_claude task is excluded even if under retry limit", () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 0,
    });
    updateTaskFields(db, id, { taskType: "cron_claude" });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(0);
  });

  test("cron_shell task is excluded even if under retry limit", () => {
    const db = freshDb();
    const id = seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 0,
    });
    updateTaskFields(db, id, { taskType: "cron_shell" });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(0);
  });

  test("non-failed tasks (ready, running, done) are not returned", () => {
    const db = freshDb();
    seedTask(db, {
      lifecycleStage: "ready",
      retryCount: 0,
    });
    seedTask(db, {
      lifecycleStage: "active",
      currentPhase: "implement",
      retryCount: 0,
    });
    seedTask(db, {
      lifecycleStage: "done",
      retryCount: 0,
    });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(0);
  });

  test("multiple tasks — only those under retry limit are returned", () => {
    const db = freshDb();
    // Under limit — should be returned
    const underLimit1 = seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 1,
    });
    const underLimit2 = seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 0,
    });
    // At or over limit — excluded
    seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 3,
    });
    seedTask(db, {
      lifecycleStage: "failed",
      retryCount: 4,
    });

    const result = getFailedTasksWithRetriesRemaining(db, 3);

    expect(result).toHaveLength(2);
    const ids = result.map((t) => t.linearIssueId);
    expect(ids).toContain(underLimit1);
    expect(ids).toContain(underLimit2);
  });
});
