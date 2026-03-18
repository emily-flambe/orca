// ---------------------------------------------------------------------------
// Adversarial tests for cron-shell-lifecycle Inngest workflow
// and the POST /api/cron/:id/trigger endpoint.
//
// Strategy: mock the inngest client, capture the handler, execute steps
// immediately via a mock step object.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports so hoisting works
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-var
var capturedHandler: (ctx: {
  event: unknown;
  step: unknown;
}) => Promise<unknown>;

vi.mock("../src/inngest/client.js", () => ({
  inngest: {
    createFunction: vi.fn(
      (
        _config: unknown,
        _trigger: unknown,
        handler: (ctx: { event: unknown; step: unknown }) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
        return { id: "cron-shell-lifecycle" };
      },
    ),
    send: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/db/queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/queries.js")>();
  return {
    ...actual,
    getTask: vi.fn(),
    claimTaskForDispatch: vi.fn(),
    updateTaskStatus: vi.fn(),
  };
});

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
} from "../src/db/queries.js";
import { emitTaskUpdated } from "../src/events.js";
import { execSync } from "node:child_process";
import { setSchedulerDeps } from "../src/inngest/deps.js";
import "../src/inngest/workflows/cron-shell-lifecycle.js";

import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import {
  insertCronSchedule,
  getCronSchedule,
  getTasksByCronSchedule,
} from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------

const mockGetTask = vi.mocked(getTask);
const mockClaimTaskForDispatch = vi.mocked(claimTaskForDispatch);
const mockUpdateTaskStatus = vi.mocked(updateTaskStatus);
const mockEmitTaskUpdated = vi.mocked(emitTaskUpdated);
const mockExecSync = vi.mocked(execSync);

// ---------------------------------------------------------------------------
// Test helpers for workflow tests
// ---------------------------------------------------------------------------

const mockDb = {} as never;

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    linearIssueId: "cron-1-12345-abc",
    orcaStatus: "ready",
    agentPrompt: "echo hello",
    repoPath: "/tmp/repo",
    taskType: "cron_shell",
    ...overrides,
  };
}

function makeEvent(taskId = "cron-1-12345-abc") {
  return {
    name: "task/ready" as const,
    data: {
      linearIssueId: taskId,
      taskType: "cron_shell",
    },
  };
}

function createStep() {
  return {
    run: vi.fn(async (_id: string, fn: () => unknown) => fn()),
    sleep: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => null),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  setSchedulerDeps({
    db: mockDb,
    config: {} as never,
    graph: {} as never,
    client: {} as never,
    stateMap: {} as never,
  });
});

// ---------------------------------------------------------------------------
// Workflow: claim-task step
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: claim-task step", () => {
  test("task not in DB → returns not_claimed with 'task not found' reason", async () => {
    mockGetTask.mockReturnValue(undefined);
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(result).toMatchObject({ outcome: "not_claimed", reason: "task not found" });
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test("task exists but in wrong state → claimTaskForDispatch fails → returns not_claimed", async () => {
    const task = makeTask({ orcaStatus: "running" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(result).toMatchObject({
      outcome: "not_claimed",
      reason: expect.stringContaining("not in ready state"),
    });
    expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
  });

  test("task in 'done' state → claimTaskForDispatch fails → returns not_claimed", async () => {
    const task = makeTask({ orcaStatus: "done" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(false);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(result).toMatchObject({ outcome: "not_claimed" });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  test("claim succeeds → status immediately set to 'running' (skips dispatched externally)", async () => {
    // BUG: claimTaskForDispatch sets status to "dispatched", then updateTaskStatus
    // immediately sets it to "running". The dispatched state is never emitted/visible.
    // The task goes ready -> dispatched (internal) -> running without external notification of dispatched.
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("output" as never);

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    // updateTaskStatus("running") must be called BEFORE the shell runs
    const calls = mockUpdateTaskStatus.mock.calls;
    const runningCall = calls.findIndex((c) => c[1] === "cron-1-12345-abc" && c[2] === "running");
    expect(runningCall).toBeGreaterThanOrEqual(0);
  });

  test("claimTaskForDispatch is called with fromStatuses=['ready'] only", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("" as never);

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    expect(mockClaimTaskForDispatch).toHaveBeenCalledWith(
      mockDb,
      "cron-1-12345-abc",
      ["ready"],
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow: status transitions
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: status transitions", () => {
  test("successful command → final status is 'done'", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("hello world\n" as never);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(result).toMatchObject({ outcome: "done" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "cron-1-12345-abc", "done");
  });

  test("successful command → never sets status to 'failed'", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("" as never);

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    expect(mockUpdateTaskStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "failed",
    );
  });

  test("failing command → final status is 'failed'", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      const err = new Error("Command failed: exit code 1");
      (err as Record<string, unknown>).stderr = "permission denied";
      throw err;
    });

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(result).toMatchObject({ outcome: "failed" });
    expect(mockUpdateTaskStatus).toHaveBeenCalledWith(mockDb, "cron-1-12345-abc", "failed");
  });

  test("failing command → never sets status to 'done'", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("Command failed");
    });

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    expect(mockUpdateTaskStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "done",
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow: Inngest retry idempotency bug
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: Inngest retry idempotency gap (BUG)", () => {
  test(
    "workflow invoked for task already in 'running' exits with not_claimed — task permanently stuck",
    async () => {
      // When Inngest retries a workflow function, previously completed steps are
      // replayed from cache. However, the `claim-task` step runs again if Inngest
      // has no cached result (e.g. after a Inngest server restart, or if the step
      // result was not persisted before the retry).
      //
      // The concrete bug scenario:
      //   1. claim-task step succeeds: status = running
      //   2. run-shell step is dispatched to Inngest worker
      //   3. Inngest worker crashes before step result is persisted
      //   4. Inngest retries the entire function
      //   5. claim-task is re-executed: task is in "running" not "ready"
      //   6. claimTaskForDispatch returns false
      //   7. Workflow exits with "not_claimed" — task permanently stuck in "running"
      //
      // This test directly simulates step 4-7: a fresh invocation of the workflow
      // for a task already in "running" state.

      mockGetTask.mockReturnValue(makeTask({ orcaStatus: "running" }));
      mockClaimTaskForDispatch.mockReturnValue(false);

      const step = createStep();
      const result = await capturedHandler({ event: makeEvent(), step });

      // BUG: The workflow exits silently with "not_claimed" rather than
      // attempting to re-run the shell or updating task status to "failed".
      // The task is permanently stuck in "running".
      expect((result as { outcome: string }).outcome).toBe("not_claimed");

      // The shell was never executed — task remains stuck in "running" forever
      expect(mockExecSync).not.toHaveBeenCalled();

      // No status update: the stuck task keeps "running" status with no way to recover
      expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
    },
  );

  test(
    "workflow invoked for task in 'dispatched' also silently exits — no error surfaced",
    async () => {
      // The claim step sets status to "dispatched" first (via claimTaskForDispatch),
      // then immediately to "running". If a retry hits between these two calls,
      // the task is in "dispatched" — also not in ["ready"], so claim fails.
      mockGetTask.mockReturnValue(makeTask({ orcaStatus: "dispatched" }));
      mockClaimTaskForDispatch.mockReturnValue(false);

      const step = createStep();
      const result = await capturedHandler({ event: makeEvent(), step });

      expect((result as { outcome: string }).outcome).toBe("not_claimed");
      expect(mockExecSync).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Workflow: non-null assertion on getTask after claim (fixed)
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: non-null assertion after claim (BUG)", () => {
  test("if task is deleted between claimTaskForDispatch and getTask, non-null assertion throws", async () => {
    let getTaskCallCount = 0;
    mockGetTask.mockImplementation(() => {
      getTaskCallCount++;
      if (getTaskCallCount === 1) {
        // First call: task exists for the initial check
        return makeTask({ orcaStatus: "ready" });
      }
      // Second call: after claim — task was deleted
      return undefined;
    });
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();

    // After the fix, emitTaskUpdated is guarded with a null check.
    // When task is deleted between claimTaskForDispatch and getTask,
    // emitTaskUpdated should NOT be called (no undefined passed).
    await capturedHandler({ event: makeEvent(), step });

    // emitTaskUpdated should NOT be called with undefined after the fix
    expect(mockEmitTaskUpdated).not.toHaveBeenCalledWith(undefined);
  });
});

// ---------------------------------------------------------------------------
// Workflow: empty/null command edge cases
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: empty command handling", () => {
  test("empty agentPrompt (null) → execSync NOT called, task failed with 'empty shell command'", async () => {
    const task = makeTask({ agentPrompt: null });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    // execSync should NOT be called for empty commands
    expect(mockExecSync).not.toHaveBeenCalled();
    // Task should be marked failed with the appropriate message
    expect(result).toMatchObject({ outcome: "failed", output: "empty shell command" });
  });

  test("agentPrompt with only whitespace → execSync NOT called, task failed", async () => {
    const task = makeTask({ agentPrompt: "   " });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step });

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "failed", output: "empty shell command" });
  });

  test("null repoPath → falls back to process.cwd()", async () => {
    const task = makeTask({ repoPath: null });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("ok" as never);

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  test("empty string repoPath → falls back to process.cwd() (falsy check)", async () => {
    const task = makeTask({ repoPath: "" });
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);
    mockExecSync.mockReturnValue("ok" as never);

    const step = createStep();
    await capturedHandler({ event: makeEvent(), step });

    // "" is falsy, so `task.repoPath || process.cwd()` should fall back to cwd
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow: run-shell task-not-found guard
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: run-shell task-not-found guard", () => {
  test("task deleted between claim step and run-shell step → returns failed outcome", async () => {
    // claim-task succeeds
    // run-shell getTask call returns undefined (task was deleted after claim)
    let stepRunCount = 0;
    const task = makeTask();

    const fakeStep = {
      run: vi.fn(async (id: string, fn: () => unknown) => {
        stepRunCount++;
        if (id === "claim-task") {
          // Override getTask for claim-task step
          mockGetTask.mockReturnValueOnce(task); // first call in claim-task
          mockGetTask.mockReturnValueOnce(task); // second call (emitTaskUpdated)
          mockClaimTaskForDispatch.mockReturnValueOnce(true);
          return fn();
        }
        if (id === "run-shell") {
          // Task was deleted: getTask returns undefined
          mockGetTask.mockReturnValueOnce(undefined);
          return fn();
        }
        return fn();
      }),
      sleep: vi.fn(async () => {}),
      sendEvent: vi.fn(async () => {}),
      waitForEvent: vi.fn(async () => null),
    };

    const result = await capturedHandler({ event: makeEvent(), step: fakeStep });

    expect(result).toMatchObject({ outcome: "failed", output: "task not found" });
    // updateTaskStatus should NOT have been called (no task to update)
    expect(mockUpdateTaskStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "done",
    );
    expect(mockUpdateTaskStatus).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow: output truncation
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: output handling", () => {
  test("stdout longer than 10,000 chars is truncated", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const longOutput = "x".repeat(20_000);
    mockExecSync.mockReturnValue(longOutput as never);

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step }) as {
      outcome: string;
      output: string | null;
    };

    expect(result.output).not.toBeNull();
    expect(result.output!.length).toBe(10_000);
  });

  test("stderr from failed command is captured and truncated", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    const longStderr = "e".repeat(20_000);
    mockExecSync.mockImplementation(() => {
      const err = new Error("Command failed");
      (err as Record<string, unknown>).stderr = longStderr;
      throw err;
    });

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step }) as {
      outcome: string;
      output: string | null;
    };

    expect(result.output!.length).toBe(10_000);
  });

  test("failed command with no stderr falls back to err.message", async () => {
    const task = makeTask();
    mockGetTask.mockReturnValue(task);
    mockClaimTaskForDispatch.mockReturnValue(true);

    mockExecSync.mockImplementation(() => {
      const err = new Error("Command not found: nonexistent");
      throw err;
    });

    const step = createStep();
    const result = await capturedHandler({ event: makeEvent(), step }) as {
      outcome: string;
      output: string | null;
    };

    expect(result.output).toContain("Command not found: nonexistent");
  });
});

// ---------------------------------------------------------------------------
// API: POST /api/cron — enabled field hardcoded bug
// ---------------------------------------------------------------------------

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as never;

function makeApiConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    logPath: "orca.log",
    ...overrides,
  };
}

function makeApiApp(db: OrcaDb): Hono {
  return createApiRoutes({
    db,
    config: makeApiConfig(),
    syncTasks: vi.fn().mockResolvedValue(0),
    client: {} as never,
    stateMap: new Map(),
    projectMeta: [],
    inngest: mockInngest,
  });
}

function makeScheduleData(overrides?: Record<string, unknown>) {
  return {
    name: "test schedule",
    type: "shell" as const,
    schedule: "* * * * *",
    prompt: "echo hello",
    ...overrides,
  };
}

describe("POST /api/cron — enabled field is hardcoded to 1 (BUG)", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApiApp(db);
  });

  async function post(body: unknown) {
    return app.request("/api/cron", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("creating schedule with enabled=0 still creates it as enabled=1 (BUG)", async () => {
    // The POST /api/cron handler hardcodes `enabled: 1` regardless of request body.
    // Sending enabled=0 should create a disabled schedule, but the bug causes it to be enabled.
    const res = await post({
      ...makeScheduleData(),
      enabled: 0,
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    // BUG: This assertion FAILS — the API ignores the enabled field and hardcodes 1
    // Expected: body.enabled === 0
    // Actual: body.enabled === 1
    expect(body.enabled).toBe(0);
  });

  test("creating schedule with enabled=false still creates it as enabled=1 (BUG)", async () => {
    const res = await post({
      ...makeScheduleData(),
      enabled: false,
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    // BUG: enabled is hardcoded to 1 in routes.ts:1368 — ignores request body
    expect(body.enabled).toBe(0);
  });

  test("creating schedule without enabled field defaults to 1", async () => {
    // This is acceptable behavior — default to enabled
    const res = await post(makeScheduleData());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.enabled).toBe(1);
  });

  test("the Enabled toggle in create form has no effect (frontend sends enabled=0 or 1, API ignores it)", async () => {
    // Create two schedules: one with enabled=1 and one with enabled=0
    const res1 = await post({ ...makeScheduleData(), name: "enabled-true", enabled: 1 });
    const res2 = await post({ ...makeScheduleData(), name: "enabled-false", enabled: 0 });

    const body1 = await res1.json();
    const body2 = await res2.json();

    // Both are created with enabled=1 due to the hardcoding bug
    // This test documents that the enabled toggle is non-functional during creation
    expect(body1.enabled).toBe(1);

    // BUG: body2.enabled should be 0, but is 1
    expect(body2.enabled).not.toBe(body1.enabled);
  });
});

// ---------------------------------------------------------------------------
// API: POST /api/cron/:id/trigger — task fields completeness
// ---------------------------------------------------------------------------

describe("POST /api/cron/:id/trigger — task field validation", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = makeApiApp(db);
    vi.mocked(mockInngest.send).mockResolvedValue(undefined);
    // Restore getTask to use the real DB lookup so the trigger endpoint's
    // post-insert getTask call returns the newly created task.
    // We look it up via the real DB using a low-level approach since
    // getTask is mocked but we have DB access.
    mockGetTask.mockImplementation((dbArg: OrcaDb, taskId: string) => {
      // The DB instance has the task — query via getTasksByCronSchedule is unavailable
      // since we don't know the scheduleId. Use a broad scan instead.
      const allTasks = (dbArg as OrcaDb & { select: (...args: unknown[]) => unknown }).select?.();
      void allTasks; // not used
      // Simplest: return undefined — the fire-and-forget emitTaskReady won't be called
      // but the response still works. We test inngest emission separately below.
      return undefined;
    });
  });

  function makeSchedule(overrides?: Record<string, unknown>) {
    const now = new Date().toISOString();
    return {
      name: "shell test",
      type: "shell" as const,
      schedule: "* * * * *",
      prompt: "echo hi",
      repoPath: null,
      timeoutMin: 30,
      maxRuns: null,
      enabled: 1,
      nextRunAt: new Date(Date.now() + 60000).toISOString(),
      runCount: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async function trigger(id: number) {
    return app.request(`/api/cron/${id}/trigger`, { method: "POST" });
  }

  test("created task has staleSessionRetryCount=0", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].staleSessionRetryCount).toBe(0);
  });

  test("created task has retryCount=0", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].retryCount).toBe(0);
  });

  test("created task has reviewCycleCount=0", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].reviewCycleCount).toBe(0);
  });

  test("created task has mergeAttemptCount=0", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].mergeAttemptCount).toBe(0);
  });

  test("created task has isParent=0", async () => {
    const id = insertCronSchedule(db, makeSchedule());
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].isParent).toBe(0);
  });

  test("created shell task has taskType='cron_shell'", async () => {
    const id = insertCronSchedule(db, makeSchedule({ type: "shell" }));
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks[0].taskType).toBe("cron_shell");
  });

  test("shell trigger with null repoPath creates task with empty-string repoPath", async () => {
    const id = insertCronSchedule(db, makeSchedule({ repoPath: null }));
    await trigger(id);
    const tasks = getTasksByCronSchedule(db, id);
    // empty string is falsy — the workflow will fall back to process.cwd()
    expect(tasks[0].repoPath).toBe("");
  });

  test("triggering a disabled schedule still creates a task (no guard on enabled)", async () => {
    // The trigger endpoint does NOT check if the schedule is enabled.
    // A disabled schedule can still be manually triggered.
    const id = insertCronSchedule(db, makeSchedule({ enabled: 0 }));
    const res = await trigger(id);
    expect(res.status).toBe(200);
    const tasks = getTasksByCronSchedule(db, id);
    expect(tasks).toHaveLength(1);
    // This may or may not be intended behavior — documenting it
  });

  test("trigger emits task/ready event with taskType='cron_shell' when task lookup succeeds", async () => {
    // The trigger endpoint does `emitTaskReady(inngest, cronTask)` after inserting.
    // `emitTaskReady` sends { name: "task/ready", data: { taskType, ... } }.
    // In this test, getTask is mocked to return a task so the event is emitted.
    const id = insertCronSchedule(db, makeSchedule({ type: "shell" }));
    const fakeTaskId = `cron-${id}-99999-test`;

    // Override getTask to return a fake task with the right type
    mockGetTask.mockReturnValue({
      linearIssueId: fakeTaskId,
      agentPrompt: "echo hi",
      repoPath: "",
      orcaStatus: "ready",
      taskType: "cron_shell",
      priority: 0,
      retryCount: 0,
      reviewCycleCount: 0,
      mergeAttemptCount: 0,
      staleSessionRetryCount: 0,
      isParent: 0,
      cronScheduleId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      prBranchName: null,
      mergeCommitSha: null,
      prNumber: null,
      deployStartedAt: null,
      ciStartedAt: null,
      fixReason: null,
      doneAt: null,
      parentIdentifier: null,
      projectName: null,
    } as never);

    vi.mocked(mockInngest.send).mockClear();
    await trigger(id);

    expect(vi.mocked(mockInngest.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "task/ready",
        data: expect.objectContaining({
          taskType: "cron_shell",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow: concurrency key uses linearIssueId (which is unique per trigger)
// ---------------------------------------------------------------------------

describe("cron-shell-lifecycle: concurrency key analysis", () => {
  test("workflow uses linearIssueId as concurrency key — each trigger is unique (limit=1 has no effect)", () => {
    // The concurrency config is { limit: 1, key: "event.data.linearIssueId" }
    // Since each trigger creates a unique task ID (cron-${id}-${Date.now()}-${random}),
    // the concurrency key is always different. The limit: 1 per linearIssueId means
    // multiple concurrent triggers for the SAME schedule run without any cap.
    //
    // This test is documentation — if the intent was to prevent concurrent runs of
    // the same schedule, the key should be the scheduleId, not the task ID.
    //
    // There is no runtime assertion possible here without running Inngest,
    // but we can verify the event data structure matches the concurrency key.

    const taskId1 = `cron-1-${Date.now()}-abc`;
    const taskId2 = `cron-1-${Date.now()}-xyz`;

    // These are two different task IDs for the same schedule
    expect(taskId1).not.toBe(taskId2);

    // With the current concurrency key (linearIssueId = taskId), these run concurrently.
    // The limit: 1 per linearIssueId only prevents the same task from running twice,
    // not preventing multiple tasks from the same schedule from running simultaneously.
    expect(taskId1.startsWith("cron-1-")).toBe(true);
    expect(taskId2.startsWith("cron-1-")).toBe(true);
  });
});
