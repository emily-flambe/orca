// ---------------------------------------------------------------------------
// Stuck-task reconciliation tests (EMI-321)
// ---------------------------------------------------------------------------
//
// Tests for runReconciliation() in src/inngest/workflows/reconcile-stuck-tasks.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, insertInvocation, getTask } from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
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

const { runReconciliation } = await import(
  "../src/inngest/workflows/reconcile-stuck-tasks.js"
);

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
    orcaStatus: TaskStatus;
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
    orcaStatus: overrides.orcaStatus ?? "ready",
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
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    strandedTaskThresholdMin: 60,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    invocationLogRetentionHours: 168,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    maxWorktreeRetries: 3,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-secret",
    linearProjectIds: ["proj-1"],
    taskFilterLabel: undefined,
    tunnelHostname: "test.example.com",
    githubWebhookSecret: undefined,
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    cronRetentionDays: 7,
    stateMapOverrides: undefined,
    logLevel: "info",
    projectRepoMap: new Map(),
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    ...overrides,
  } as OrcaConfig;
}

// ---------------------------------------------------------------------------

describe("runReconciliation — dispatched/running (handle-based detection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("dispatched task with no active handle (older than grace period) is reset to ready", async () => {
    const db = freshDb();
    // Must be older than the 2-minute grace period
    const id = seedTask(db, { orcaStatus: "dispatched", updatedAt: ago(5) });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  test("dispatched task within grace period (< 2 min old) is NOT reset", async () => {
    const db = freshDb();
    // Just dispatched — should not be reconciled yet
    const id = seedTask(db, { orcaStatus: "dispatched" }); // updatedAt defaults to now()
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("dispatched");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("running task with no active handle is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, { orcaStatus: "running", updatedAt: ago(5) });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
  });

  test("running task WITH an active handle is NOT reset", async () => {
    const db = freshDb();
    const id = seedTask(db, { orcaStatus: "running" });
    const invId = seedRunningInvocation(db, id);
    const handles = new Map<number, unknown>([[invId, { pid: 1234 }]]);

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("running");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("dispatched task with exhausted retries is marked failed", async () => {
    const db = freshDb();
    // retryCount=3, newStaleCount=1, totalAttempts=4 > maxRetries=3 → failed
    const id = seedTask(db, { orcaStatus: "dispatched", retryCount: 3, updatedAt: ago(5) });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig({ maxRetries: 3 }),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.orcaStatus).toBe("failed");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("runReconciliation — in_review (time-based, strandedTaskThresholdMin)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("in_review task older than threshold is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "in_review",
      updatedAt: ago(70), // 70 min > 60 min threshold
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task/ready" }),
    );
  });

  test("in_review task newer than threshold is left alone", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "in_review",
      updatedAt: ago(30), // 30 min < 60 min threshold
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("in_review");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("runReconciliation — awaiting_ci / deploying (time-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("awaiting_ci task older than threshold is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "awaiting_ci",
      updatedAt: ago(70),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
  });

  test("awaiting_ci task newer than threshold is NOT reset", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "awaiting_ci",
      updatedAt: ago(30),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("awaiting_ci");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  test("deploying task older than threshold is reset to ready", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "deploying",
      updatedAt: ago(70),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
  });

  test("awaiting_ci with exhausted retries is marked failed", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "awaiting_ci",
      updatedAt: ago(70),
      retryCount: 3,
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({
      db,
      config: makeConfig({ maxRetries: 3 }),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.orcaStatus).toBe("failed");
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
    const readyId = seedTask(db, { orcaStatus: "ready", updatedAt: ago(200) });
    const doneId = seedTask(db, { orcaStatus: "done", updatedAt: ago(200) });
    const failedId = seedTask(db, {
      orcaStatus: "failed",
      updatedAt: ago(200),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, readyId)?.orcaStatus).toBe("ready");
    expect(getTask(db, doneId)?.orcaStatus).toBe("done");
    expect(getTask(db, failedId)?.orcaStatus).toBe("failed");
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
    const t1 = seedTask(db, { orcaStatus: "dispatched", updatedAt: ago(5) });
    const t2 = seedTask(db, { orcaStatus: "running", updatedAt: ago(5) });
    const t3 = seedTask(db, { orcaStatus: "in_review", updatedAt: ago(70) });
    // This task has a live handle — should be left alone
    const t4 = seedTask(db, { orcaStatus: "running" });
    const inv4 = seedRunningInvocation(db, t4);
    const handles = new Map<number, unknown>([[inv4, { pid: 9999 }]]);

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

    expect(getTask(db, t1)?.orcaStatus).toBe("ready");
    expect(getTask(db, t2)?.orcaStatus).toBe("ready");
    expect(getTask(db, t3)?.orcaStatus).toBe("ready");
    expect(getTask(db, t4)?.orcaStatus).toBe("running"); // untouched
    expect(mockInngestSend).toHaveBeenCalledTimes(3);
  });

  test("configurable strandedTaskThresholdMin is respected", async () => {
    const db = freshDb();
    // Task is 20 min old — not caught by 60 min default
    const id = seedTask(db, {
      orcaStatus: "in_review",
      updatedAt: ago(20),
    });
    const handles = new Map<number, unknown>();

    // Override to 15 min — now it should be caught
    await runReconciliation({
      db,
      config: makeConfig({ strandedTaskThresholdMin: 15 }),
      activeHandles: handles,
    });

    expect(getTask(db, id)?.orcaStatus).toBe("ready");
  });

  test("task/ready event includes correct linearIssueId and repoPath", async () => {
    const db = freshDb();
    const id = seedTask(db, {
      orcaStatus: "dispatched",
      linearIssueId: "PROJ-42",
      updatedAt: ago(5),
    });
    const handles = new Map<number, unknown>();

    await runReconciliation({ db, config: makeConfig(), activeHandles: handles });

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
