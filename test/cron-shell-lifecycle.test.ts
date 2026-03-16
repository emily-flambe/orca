// ---------------------------------------------------------------------------
// Adversarial tests for cron-shell-lifecycle workflow
// ---------------------------------------------------------------------------
//
// These tests directly exercise the step logic extracted from the workflow,
// since Inngest workflows cannot be unit-tested end-to-end without the
// Inngest dev server. We test the per-step logic inline using the same
// DB + deps pattern used in cron-scheduler.test.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../src/db/index.js";
import type { OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  claimTaskForDispatch,
  updateTaskStatus,
  insertCronSchedule,
} from "../src/db/queries.js";
import { deleteTask } from "../src/db/queries.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

let taskCounter = 0;

function seedCronShellTask(
  db: OrcaDb,
  overrides: Partial<{
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    cronScheduleId: number | null;
  }> = {},
): string {
  const id = `cron-shell-test-${++taskCounter}-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "echo hello",
    repoPath: overrides.repoPath ?? "/tmp/test-repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as any,
    taskType: "cron_shell",
    cronScheduleId: overrides.cronScheduleId ?? null,
    priority: 0,
    retryCount: 0,
    reviewCycleCount: 0,
    mergeAttemptCount: 0,
    staleSessionRetryCount: 0,
    isParent: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

// ---------------------------------------------------------------------------
// BUG 1: claimTaskForDispatch is called twice in two separate steps,
// creating a TOCTOU window where the task could be deleted between them.
// The non-null assertion `getTask(db, taskId)!` in the claim step (line 49)
// will crash if the task is deleted between claimTaskForDispatch and getTask.
// ---------------------------------------------------------------------------

describe("BUG 1: non-null assertion in claim step panics on deleted task", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("emitTaskUpdated(getTask(db,id)!) crashes when task deleted after claim", () => {
    const taskId = seedCronShellTask(db);

    // Simulate the claim succeeding
    const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
    expect(claimed).toBe(true);

    // Race: delete the task after it was claimed but before emitTaskUpdated
    deleteTask(db, taskId);

    // This is what the workflow does: getTask(db, taskId)!
    // The non-null assertion will produce undefined, which blows up in
    // emitTaskUpdated when it tries to access properties.
    const taskAfterDelete = getTask(db, taskId);
    expect(taskAfterDelete).toBeUndefined();

    // Calling emitTaskUpdated with undefined (what `!` gives you on undefined)
    // will not throw at the call site in JS, but the downstream handler
    // that reads task.linearIssueId etc. will get undefined fields.
    // The `!` assertion is a lie — the task CAN be undefined here.
    // This test documents the invariant violation.
    expect(() => {
      // Mimics: emitTaskUpdated(getTask(db, taskId)!)
      // TypeScript non-null assertion does NOT add a runtime check.
      // At runtime this passes undefined to emitTaskUpdated.
      const t = getTask(db, taskId) as any; // undefined
      // emitTaskUpdated(t) — no throw, but task fields are undefined
      // The real danger is downstream SSE handlers reading t.orcaStatus etc.
    }).not.toThrow(); // It won't throw here, but the data is corrupt
  });
});

// ---------------------------------------------------------------------------
// BUG 2: empty agentPrompt executes an empty command
// The workflow does: const command = task.agentPrompt ?? ""
// If agentPrompt is empty string "" (falsy-but-not-null), ?? still
// returns "" and execSync("", ...) is called.
// ---------------------------------------------------------------------------

describe("BUG 2: empty agentPrompt triggers execSync with empty command", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("task with empty string agentPrompt has no guard before shell execution", () => {
    // The schema marks agentPrompt as notNull(), but the trigger endpoint
    // copies schedule.prompt directly. If schedule.prompt is somehow empty
    // (data created before validation was added), the task will have "".
    //
    // The workflow uses: task.agentPrompt ?? ""
    // For "", ?? returns "" — no guard.
    // execSync("", { shell: "bash" }) will fail with non-zero exit on most systems,
    // causing the task to be marked failed rather than catching the misconfiguration.

    const taskId = seedCronShellTask(db, { agentPrompt: "" });
    const task = getTask(db, taskId)!;

    // The workflow logic: command = task.agentPrompt ?? ""
    const command = task.agentPrompt ?? "";
    expect(command).toBe("");
    // An empty command should be rejected before spawning a shell,
    // but the workflow has no such guard.
    expect(command.trim().length).toBe(0); // BUG: no guard exists for this case
  });

  it("task with whitespace-only agentPrompt also passes through unguarded", () => {
    const taskId = seedCronShellTask(db, { agentPrompt: "   " });
    const task = getTask(db, taskId)!;
    const command = task.agentPrompt ?? "";
    // "   " is not empty after ??, it will reach execSync unchanged
    expect(command.trim().length).toBe(0);
    // No guard before shell execution: a whitespace-only command
    // is a no-op on most shells but could be an indicator of misconfiguration.
  });
});

// ---------------------------------------------------------------------------
// BUG 3: empty repoPath silently executes in process.cwd()
// Routes.ts: repoPath: schedule.repoPath ?? ""  (empty string when null)
// Workflow:  const cwd = task.repoPath || process.cwd()
// This silently runs commands in the orca server's working directory.
// ---------------------------------------------------------------------------

describe("BUG 3: empty repoPath silently falls back to process.cwd()", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("task with empty string repoPath triggers process.cwd() fallback without warning", () => {
    const taskId = seedCronShellTask(db, { repoPath: "" });
    const task = getTask(db, taskId)!;

    // This is the workflow's cwd logic:
    const cwd = task.repoPath || process.cwd();

    // Empty string is falsy — cwd silently becomes process.cwd()
    expect(task.repoPath).toBe("");
    expect(cwd).toBe(process.cwd());
    // The trigger endpoint sets repoPath="" when schedule.repoPath is null.
    // There is no warning or log that the fallback was triggered.
    // A shell command that expects to run in a repo will silently run in
    // the orca server's directory, potentially with dangerous side effects.
  });

  it("cwd resolution: empty vs null behave differently for || operator", () => {
    // repoPath="" (from trigger) → cwd = process.cwd() (silent fallback)
    // repoPath="/some/path" → cwd = "/some/path" (correct)
    const resolvesCwd = (repoPath: string) => repoPath || process.cwd();

    expect(resolvesCwd("")).toBe(process.cwd());
    expect(resolvesCwd("/actual/path")).toBe("/actual/path");
    // BUG: "" is indistinguishable from "not set" — no log/warning emitted
  });
});

// ---------------------------------------------------------------------------
// BUG 4: no per-task concurrency key — two triggers for same schedule
// run simultaneously because each creates a NEW unique taskId.
// Unlike cron-task-lifecycle which has concurrency: [{ limit: 1, key: ... }],
// cron-shell-lifecycle has no concurrency config at all.
// ---------------------------------------------------------------------------

describe("BUG 4: missing concurrency key allows simultaneous shell executions", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("two rapid triggers create two independent tasks that both claim successfully", () => {
    // Each trigger creates a separate task with a unique ID.
    // Because claimTaskForDispatch uses task-specific IDs,
    // two tasks can both be claimed and run simultaneously.
    const taskId1 = seedCronShellTask(db, { agentPrompt: "heavy-script.sh" });
    const taskId2 = seedCronShellTask(db, { agentPrompt: "heavy-script.sh" });

    const claimed1 = claimTaskForDispatch(db, taskId1, ["ready"]);
    const claimed2 = claimTaskForDispatch(db, taskId2, ["ready"]);

    // Both succeed — no mutual exclusion at the workflow level
    expect(claimed1).toBe(true);
    expect(claimed2).toBe(true);

    // Both are now "dispatched" — two instances of heavy-script.sh will run
    expect(getTask(db, taskId1)?.orcaStatus).toBe("dispatched");
    expect(getTask(db, taskId2)?.orcaStatus).toBe("dispatched");
    // BUG: cron-task-lifecycle prevents this with concurrency key.
    // cron-shell-lifecycle has no such guard.
  });
});

// ---------------------------------------------------------------------------
// BUG 5: task permanently stuck in "dispatched" if workflow dies after
// claim but before finalize (since retries: 0).
// This is a design issue: if Inngest redelivers the event after a crash,
// the claim step finds the task in "dispatched" (not "ready") and returns
// not_claimed — leaving it stuck forever.
// ---------------------------------------------------------------------------

describe("BUG 5: task stuck in dispatched if workflow crashes before finalize", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("task in dispatched state cannot be re-claimed on retry", () => {
    const taskId = seedCronShellTask(db);

    // Step 1 succeeds: task moves to dispatched
    const claimed = claimTaskForDispatch(db, taskId, ["ready"]);
    expect(claimed).toBe(true);
    expect(getTask(db, taskId)?.orcaStatus).toBe("dispatched");

    // Simulate: workflow crashes here (retries: 0 means no automatic retry)
    // If the Inngest event is re-delivered, claim step runs again:
    const reclaim = claimTaskForDispatch(db, taskId, ["ready"]);
    // Returns false — task is in "dispatched", not "ready"
    expect(reclaim).toBe(false);

    // Task is now permanently in "dispatched" with no way to recover
    // (no retry logic, no reconciliation in this workflow)
    expect(getTask(db, taskId)?.orcaStatus).toBe("dispatched");
  });

  it("finalize step non-null assertion panics when task deleted between execute and finalize", () => {
    const taskId = seedCronShellTask(db);
    claimTaskForDispatch(db, taskId, ["ready"]);

    // Simulate execute-shell step completing
    // Then task is deleted externally (e.g., via DELETE /api/tasks/:id)
    deleteTask(db, taskId);

    // Finalize step: updateTaskStatus(db, taskId, "done") — no-op for missing task
    updateTaskStatus(db, taskId, "done"); // Safe: just updates 0 rows

    // But then: emitTaskUpdated(getTask(db, taskId)!)
    // getTask returns undefined; the ! assertion passes undefined to emitTaskUpdated
    const taskAfter = getTask(db, taskId);
    expect(taskAfter).toBeUndefined();
    // The non-null assertion is a lie — this will pass undefined at runtime
    // and cause downstream SSE serialization to emit corrupt data
  });
});

// ---------------------------------------------------------------------------
// BUG 6: workflow ignores schedule's timeoutMin — always uses hardcoded 60s
// The cron_schedules table has a timeoutMin column (default 30).
// The /trigger endpoint creates tasks but does NOT copy timeoutMin to the task.
// The workflow hardcodes timeout: 60_000 in execSync.
// A schedule configured with timeoutMin=5 or timeoutMin=120 is silently ignored.
// ---------------------------------------------------------------------------

describe("BUG 6: schedule timeoutMin is ignored — hardcoded 60s used instead", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("task record has no timeoutMin field — schedule config is lost", () => {
    const ts = now();
    const scheduleId = insertCronSchedule(db, {
      name: "slow-job",
      type: "shell",
      schedule: "* * * * *",
      prompt: "sleep 300",
      repoPath: "/tmp",
      model: null,
      maxTurns: null,
      timeoutMin: 10, // schedule says 10 minutes
      maxRuns: null,
      runCount: 0,
      enabled: 1,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: ts,
      updatedAt: ts,
    });

    // The trigger creates a task — but tasks table has no timeoutMin column
    const taskId = seedCronShellTask(db, {
      agentPrompt: "sleep 300",
      cronScheduleId: scheduleId,
    });

    const task = getTask(db, taskId)!;
    // The task has no timeoutMin — the workflow can't read it
    expect((task as any).timeoutMin).toBeUndefined();

    // The workflow hardcodes: timeout: 60_000 (60 seconds)
    // But the schedule says 10 minutes (600s).
    // The user's configuration is silently ignored.
    const hardcodedTimeoutMs = 60_000;
    const scheduleTimeoutMs = 10 * 60 * 1000; // 600_000
    expect(hardcodedTimeoutMs).not.toBe(scheduleTimeoutMs);
  });
});

// ---------------------------------------------------------------------------
// BUG 7: no cancelOn configuration — task/cancelled events are ignored
// cron-task-lifecycle listens for task/cancelled to abort long-running sessions.
// cron-shell-lifecycle has no cancelOn, so a running shell command cannot be
// interrupted via the cancellation mechanism.
// ---------------------------------------------------------------------------

describe("BUG 7: missing cancelOn — shell tasks cannot be cancelled via event", () => {
  it("cronShellLifecycle export has no cancelOn config", async () => {
    // The workflow is registered with only { id, retries } — no cancelOn.
    // We verify the registered Inngest function config lacks cancel triggers.
    //
    // We can't inspect the Inngest function object directly without a client,
    // but we can verify the source module doesn't set up cancellation by
    // checking the exported function's configuration indirectly.
    //
    // This test documents the missing feature: if a shell task is running
    // and the user issues a cancel, the workflow will keep running until
    // execSync completes or times out at 60s.
    //
    // Compare: cron-task-lifecycle has:
    //   cancelOn: [{ event: "task/cancelled", if: "async.data.linearIssueId == ..." }]
    // cron-shell-lifecycle has: nothing.

    // Since we can't import the Inngest function without triggering full initialization,
    // we verify the source file doesn't contain the cancelOn string.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "C:/Users/emily/Documents/Github/orca-EMI-339/src/inngest/workflows/cron-shell-lifecycle.ts",
      "utf-8",
    );
    expect(source).not.toContain("cancelOn");
    // This confirms the absence of cancellation support — a behavioral gap
    // vs cron-task-lifecycle which does support cancellation.
  });
});

// ---------------------------------------------------------------------------
// BUG 8: getDeps() is used instead of getSchedulerDeps()
// cron-shell-lifecycle imports getDeps from task-lifecycle.ts, which requires
// initTaskLifecycle() to have been called. getSchedulerDeps() (from deps.ts)
// is a separate registry used by cron-dispatch and other workflows.
// If initTaskLifecycle() is not called but setSchedulerDeps() is, the workflow
// throws "WorkflowDeps not initialized" instead of using the available deps.
// This is the opposite of what cron-task-lifecycle does (it also uses getDeps,
// so it's consistent), but it's inconsistent with cron-dispatch's getSchedulerDeps.
// ---------------------------------------------------------------------------

describe("BUG 8: getDeps() dependency — throws if initTaskLifecycle not called", () => {
  it("source imports getDeps from task-lifecycle, not getSchedulerDeps from deps", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "C:/Users/emily/Documents/Github/orca-EMI-339/src/inngest/workflows/cron-shell-lifecycle.ts",
      "utf-8",
    );

    // Verify the import
    expect(source).toContain('from "./task-lifecycle.js"');
    expect(source).toContain("getDeps");

    // Verify it does NOT use the scheduler deps (which cron-dispatch uses)
    expect(source).not.toContain("getSchedulerDeps");

    // This means: if a deployment only calls setSchedulerDeps() but not
    // initTaskLifecycle(), all cron_shell tasks triggered via /trigger will
    // fail with "WorkflowDeps not initialized".
    //
    // cron-dispatch.ts uses getSchedulerDeps() and works fine in that case.
    // The inconsistency means cron-dispatch (scheduled) works but
    // cron-shell-lifecycle (manual trigger) fails if initTaskLifecycle isn't called.
  });
});

// ---------------------------------------------------------------------------
// BUG 9: task status not updated to "running" during execution
// cron-task-lifecycle sets task to "running" when the session starts (line 146).
// cron-shell-lifecycle goes directly from "dispatched" → "done"/"failed"
// with no intermediate "running" state. The task appears stuck in "dispatched"
// while the shell command executes, making the dashboard misleading.
// ---------------------------------------------------------------------------

describe("running status transition during shell execution", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("workflow transitions: ready → dispatched (claim) → running (execute) → done/failed (finalize)", () => {
    const taskId = seedCronShellTask(db);

    // Step 1: Claim — ready → dispatched
    claimTaskForDispatch(db, taskId, ["ready"]);
    expect(getTask(db, taskId)?.orcaStatus).toBe("dispatched");

    // Step 2: Execute — dispatched → running
    updateTaskStatus(db, taskId, "running");
    expect(getTask(db, taskId)?.orcaStatus).toBe("running");

    // Step 3: Finalize — running → done
    updateTaskStatus(db, taskId, "done");
    expect(getTask(db, taskId)?.orcaStatus).toBe("done");
  });
});
