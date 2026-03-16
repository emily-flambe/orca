// ---------------------------------------------------------------------------
// stuck-task-detector tests — adversarial, meant to expose bugs
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  processSnapshot,
  loadTrackingState,
  saveTrackingState,
  detectAndAlertStuckTasks,
  STUCK_THRESHOLDS,
  TERMINAL_STATUSES,
  DEFAULT_TRACKING_FILE,
  type TaskTrackingState,
  type StuckTaskAlert,
} from "../src/scheduler/stuck-task-detector.js";
import { resetHealingCounters } from "../src/scheduler/alerts.js";
import { createDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 3600,
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
    cleanupIntervalMin: 10000,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    projectRepoMap: new Map(),
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    ...overrides,
  };
}

function makeDeps() {
  const db = createDb(":memory:");
  return {
    db,
    config: testConfig(),
    graph: {
      isDispatchable: vi.fn().mockReturnValue(true),
      computeEffectivePriority: vi.fn(),
      rebuild: vi.fn(),
    } as any,
    client: {
      createComment: vi.fn().mockResolvedValue(undefined),
      createAttachment: vi.fn().mockResolvedValue(undefined),
    } as any,
    stateMap: new Map(),
  };
}

// ---------------------------------------------------------------------------
// processSnapshot — pure logic
// ---------------------------------------------------------------------------

describe("processSnapshot", () => {
  // --- Basic tracking ---

  test("empty task list returns empty state and no alerts", () => {
    const { updatedState, alerts } = processSnapshot([], {});
    expect(updatedState).toEqual({});
    expect(alerts).toEqual([]);
  });

  test("first snapshot: task enters non-terminal status, consecutiveSnapshots=1, no alert", () => {
    const tasks = [{ linearIssueId: "T-1", orcaStatus: "running", retryCount: 0 }];
    const { updatedState, alerts } = processSnapshot(tasks, {});
    expect(updatedState["T-1"]).toBeDefined();
    expect(updatedState["T-1"]!.consecutiveSnapshots).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  test("second snapshot in same status: consecutiveSnapshots=2, alert fires for threshold=2", () => {
    const tasks = [{ linearIssueId: "T-2", orcaStatus: "running", retryCount: 0 }];
    const state: TaskTrackingState = {
      "T-2": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(updatedState["T-2"]!.consecutiveSnapshots).toBe(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].linearIssueId).toBe("T-2");
  });

  // --- Terminal status removal ---

  test("terminal statuses are removed from updatedState", () => {
    for (const status of TERMINAL_STATUSES) {
      const tasks = [{ linearIssueId: "T-term", orcaStatus: status, retryCount: 0 }];
      const state: TaskTrackingState = {
        "T-term": {
          status: "running",
          firstSeenAt: new Date().toISOString(),
          consecutiveSnapshots: 5,
          retryCount: 0,
        },
      };
      const { updatedState, alerts } = processSnapshot(tasks, state);
      expect(updatedState["T-term"]).toBeUndefined();
      expect(alerts).toHaveLength(0);
    }
  });

  // --- Disappearing tasks ---

  test("task not in currentTasks is dropped from updatedState", () => {
    const state: TaskTrackingState = {
      "T-gone": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 0,
      },
    };
    const { updatedState } = processSnapshot([], state);
    expect(updatedState["T-gone"]).toBeUndefined();
  });

  // --- Status change resets state ---

  test("status change resets consecutiveSnapshots to 1 and no alert fires", () => {
    const state: TaskTrackingState = {
      "T-change": {
        status: "running",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 5,
        retryCount: 0,
      },
    };
    const tasks = [{ linearIssueId: "T-change", orcaStatus: "in_review", retryCount: 0 }];
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(updatedState["T-change"]!.consecutiveSnapshots).toBe(1);
    expect(updatedState["T-change"]!.status).toBe("in_review");
    expect(alerts).toHaveLength(0);
  });

  test("status change resets firstSeenAt to now", () => {
    const oldTime = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    const state: TaskTrackingState = {
      "T-time": {
        status: "running",
        firstSeenAt: oldTime,
        consecutiveSnapshots: 10,
        retryCount: 0,
      },
    };
    const now = new Date();
    const tasks = [{ linearIssueId: "T-time", orcaStatus: "in_review", retryCount: 0 }];
    const { updatedState } = processSnapshot(tasks, state, now);
    expect(updatedState["T-time"]!.firstSeenAt).toBe(now.toISOString());
  });

  // retryCount change with same status does NOT reset consecutiveSnapshots.
  // This is intentional: in practice, a retried task transitions through
  // ready → dispatched → running, resetting the counter via status change.
  // If status stays the same but retryCount changes, the task is still stuck
  // in the same state and the counter should keep accumulating.

  test("retryCount increment with same status does not reset consecutiveSnapshots", () => {
    const state: TaskTrackingState = {
      "T-retry": {
        status: "running",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 5,
        retryCount: 0,
      },
    };
    // Same status, retryCount bumped — counter continues accumulating
    const tasks = [{ linearIssueId: "T-retry", orcaStatus: "running", retryCount: 1 }];
    const { updatedState } = processSnapshot(tasks, state);
    expect(updatedState["T-retry"]!.consecutiveSnapshots).toBe(6);
    expect(updatedState["T-retry"]!.retryCount).toBe(1);
  });

  // --- awaiting_ci threshold is 4 ---

  test("awaiting_ci: no alert at snapshot 3 (entering with 2, incrementing to 3)", () => {
    // State entering with consecutiveSnapshots=2. After processing becomes 3. Threshold=4.
    // 3 >= 4 is false, so no alert should fire.
    const tasks = [{ linearIssueId: "T-ci", orcaStatus: "awaiting_ci", retryCount: 0 }];
    const state: TaskTrackingState = {
      "T-ci": {
        status: "awaiting_ci",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 2, // becomes 3, below threshold of 4
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    expect(alerts).toHaveLength(0);
  });

  test("awaiting_ci: alert fires at snapshot 4 (entering with 3, incrementing to 4 which meets threshold)", () => {
    // State entering with consecutiveSnapshots=3. After processing becomes 4. Threshold=4.
    // 4 >= 4 = true, so alert fires.
    const tasks = [{ linearIssueId: "T-ci4", orcaStatus: "awaiting_ci", retryCount: 0 }];
    const state: TaskTrackingState = {
      "T-ci4": {
        status: "awaiting_ci",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3, // becomes 4, equals threshold of 4
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    // snapshot becomes 4, threshold is 4: 4 >= 4 fires
    expect(alerts).toHaveLength(1);
  });

  // --- BUG: alerts fire on EVERY snapshot >= threshold, not just at exact threshold ---
  // A task at consecutiveSnapshots=10 will always fire an alert on every new snapshot,
  // even if it already fired at snapshot 2. The cooldown in sendAlertThrottled provides
  // some relief but that's async/side-effectful; processSnapshot itself returns an alert
  // on every call where consecutiveSnapshots >= threshold.

  test("BUG: alert fires on EVERY snapshot past threshold, not just the threshold boundary", () => {
    const tasks = [{ linearIssueId: "T-spam", orcaStatus: "running", retryCount: 0 }];
    const state: TaskTrackingState = {
      "T-spam": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 10, // well past threshold of 2
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    // This is a design issue: alert fires on snapshot 11 even though it already
    // fired at snapshot 2. The processSnapshot function always includes it.
    // NOTE: This test documents the behavior — it PASSES currently (alert fires),
    // but exposes the design concern that callers must rely entirely on the
    // external cooldown in sendAlertThrottled to prevent spam.
    expect(alerts).toHaveLength(1); // documents that alert fires at snapshot 11
  });

  // --- Alert payload completeness ---

  test("alert includes all required fields", () => {
    const firstSeenAt = new Date(Date.now() - 120_000).toISOString(); // 2min ago
    const tasks = [{ linearIssueId: "T-fields", orcaStatus: "running", retryCount: 2 }];
    const state: TaskTrackingState = {
      "T-fields": {
        status: "running",
        firstSeenAt,
        consecutiveSnapshots: 1,
        retryCount: 2,
      },
    };
    const now = new Date(new Date(firstSeenAt).getTime() + 120_000);
    const { alerts } = processSnapshot(tasks, state, now);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert.linearIssueId).toBe("T-fields");
    expect(alert.status).toBe("running");
    expect(alert.consecutiveSnapshots).toBe(2);
    expect(alert.firstSeenAt).toBe(firstSeenAt);
    expect(alert.retryCount).toBe(2);
    expect(alert.durationMinutes).toBe(2);
  });

  // --- Unknown/untracked status (not in STUCK_THRESHOLDS, not in TERMINAL_STATUSES) ---

  test("unknown status accumulates in state indefinitely without alert", () => {
    // e.g., if a new status is added to the system without updating STUCK_THRESHOLDS
    const tasks = [{ linearIssueId: "T-unk", orcaStatus: "some_new_status", retryCount: 0 }];
    const state: TaskTrackingState = {
      "T-unk": {
        status: "some_new_status",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 100, // been stuck forever
        retryCount: 0,
      },
    };
    const { updatedState, alerts } = processSnapshot(tasks, state);
    // No alert because threshold is undefined for unknown statuses
    expect(alerts).toHaveLength(0);
    // But still tracked in state — leaks memory
    expect(updatedState["T-unk"]).toBeDefined();
    expect(updatedState["T-unk"]!.consecutiveSnapshots).toBe(101);
  });

  // --- firstSeenAt preserved across same-status snapshots ---

  test("firstSeenAt is preserved when status stays same", () => {
    const originalTime = new Date(Date.now() - 300_000).toISOString();
    const state: TaskTrackingState = {
      "T-preserve": {
        status: "dispatched",
        firstSeenAt: originalTime,
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const tasks = [{ linearIssueId: "T-preserve", orcaStatus: "dispatched", retryCount: 0 }];
    const { updatedState } = processSnapshot(tasks, state);
    expect(updatedState["T-preserve"]!.firstSeenAt).toBe(originalTime);
  });

  // --- Multiple tasks in one snapshot ---

  test("multiple tasks processed correctly in same snapshot", () => {
    const tasks = [
      { linearIssueId: "T-a", orcaStatus: "running", retryCount: 0 },
      { linearIssueId: "T-b", orcaStatus: "awaiting_ci", retryCount: 1 },
      { linearIssueId: "T-c", orcaStatus: "done", retryCount: 0 },
    ];
    const state: TaskTrackingState = {
      "T-a": { status: "running", firstSeenAt: new Date().toISOString(), consecutiveSnapshots: 1, retryCount: 0 },
      "T-b": { status: "awaiting_ci", firstSeenAt: new Date().toISOString(), consecutiveSnapshots: 3, retryCount: 1 },
    };
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(updatedState["T-a"]!.consecutiveSnapshots).toBe(2); // alert fires
    expect(updatedState["T-b"]!.consecutiveSnapshots).toBe(4); // alert fires
    expect(updatedState["T-c"]).toBeUndefined(); // terminal
    expect(alerts).toHaveLength(2);
  });

  // --- All tasks terminal: empty state ---

  test("all tasks terminal: updatedState is empty", () => {
    const tasks = [
      { linearIssueId: "T-done1", orcaStatus: "done", retryCount: 0 },
      { linearIssueId: "T-done2", orcaStatus: "failed", retryCount: 3 },
      { linearIssueId: "T-done3", orcaStatus: "canceled", retryCount: 0 },
    ];
    const { updatedState, alerts } = processSnapshot(tasks, {});
    expect(Object.keys(updatedState)).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  // --- processSnapshot is pure: does not mutate input state ---

  test("processSnapshot does not mutate the input state object", () => {
    const state: TaskTrackingState = {
      "T-pure": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const frozen = { ...state };
    const tasks = [{ linearIssueId: "T-pure", orcaStatus: "running", retryCount: 0 }];
    processSnapshot(tasks, state);
    // Input state should not be mutated
    expect(state["T-pure"]!.consecutiveSnapshots).toBe(frozen["T-pure"]!.consecutiveSnapshots);
  });

  // --- durationMinutes accuracy ---

  test("durationMinutes correctly calculated from firstSeenAt to now", () => {
    const firstSeenAt = new Date(0).toISOString(); // epoch
    const now = new Date(10 * 60 * 1000); // 10 minutes later
    const state: TaskTrackingState = {
      "T-dur": {
        status: "running",
        firstSeenAt,
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const tasks = [{ linearIssueId: "T-dur", orcaStatus: "running", retryCount: 0 }];
    const { alerts } = processSnapshot(tasks, state, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.durationMinutes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// loadTrackingState — sync I/O using require() in ESM context
// ---------------------------------------------------------------------------

describe("loadTrackingState", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-test-"));
    tmpFile = path.join(tmpDir, "tracking.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // BUG: loadTrackingState uses require("node:fs") inside an ESM module.
  // In ESM, require() is not defined. This will throw ReferenceError.
  test("BUG: loadTrackingState uses require() which is not available in ESM — throws or returns {}", () => {
    // The implementation attempts require("node:fs") in an ESM context.
    // Expected behavior per spec: returns {} when file not found (graceful).
    // Actual behavior: may throw ReferenceError: require is not defined
    // in strict ESM environments.
    const result = loadTrackingState("/nonexistent/path/tracking.json");
    // If require() is somehow polyfilled/available, it should return {}
    expect(result).toEqual({});
  });

  test("BUG: loadTrackingState with valid file uses require() — may fail in ESM", async () => {
    const state: TaskTrackingState = {
      "T-load": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 1,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(state), "utf8");

    // If require() works (e.g., in a tsx/transform environment), it should return the state
    const result = loadTrackingState(tmpFile);
    expect(result).toEqual(state);
  });

  test("loadTrackingState returns empty object when file does not exist", () => {
    const result = loadTrackingState("/nonexistent/path/tracking.json");
    expect(result).toEqual({});
  });

  test("BUG: loadTrackingState silently returns {} on invalid JSON instead of reporting error", async () => {
    await fs.writeFile(tmpFile, "THIS IS NOT JSON {{{{", "utf8");
    // The implementation swallows the JSON.parse error silently.
    // State is lost with no warning to the caller.
    const result = loadTrackingState(tmpFile);
    expect(result).toEqual({});
    // There's no way for the caller to know that a corrupted file was read.
    // This is a silent data loss bug.
  });
});

// ---------------------------------------------------------------------------
// saveTrackingState — sync I/O using require() in ESM context
// ---------------------------------------------------------------------------

describe("saveTrackingState", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-test-"));
    tmpFile = path.join(tmpDir, "tracking.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // BUG: saveTrackingState uses require("node:fs") in an ESM context.
  // This may fail silently (it catches errors) or throw before the catch.
  test("BUG: saveTrackingState uses require() in ESM — file may not be written", async () => {
    const state: TaskTrackingState = {
      "T-save": {
        status: "dispatched",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    saveTrackingState(state, tmpFile);
    // Verify file was actually written
    const written = await fs.readFile(tmpFile, "utf8").catch(() => null);
    // If require() fails in ESM, the file won't exist
    expect(written).not.toBeNull();
    expect(JSON.parse(written!)).toEqual(state);
  });

  test("saveTrackingState creates parent directory if missing", async () => {
    const deepFile = path.join(tmpDir, "deep", "nested", "tracking.json");
    const state: TaskTrackingState = {};
    saveTrackingState(state, deepFile);
    const written = await fs.readFile(deepFile, "utf8").catch(() => null);
    expect(written).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectAndAlertStuckTasks — top-level async, never throws
// ---------------------------------------------------------------------------

describe("detectAndAlertStuckTasks", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-detect-"));
    tmpFile = path.join(tmpDir, "tracking.json");
    resetHealingCounters();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test("never throws — file not found on first run is handled gracefully", async () => {
    const deps = makeDeps();
    await expect(
      detectAndAlertStuckTasks(deps, [], tmpFile),
    ).resolves.toBeUndefined();
  });

  test("never throws even if currentTasks is empty", async () => {
    const deps = makeDeps();
    await expect(
      detectAndAlertStuckTasks(deps, [], tmpFile),
    ).resolves.toBeUndefined();
  });

  test("never throws even if state file contains invalid JSON", async () => {
    await fs.writeFile(tmpFile, "NOT JSON AT ALL {{{", "utf8");
    const deps = makeDeps();
    const tasks = [{ linearIssueId: "T-bad", orcaStatus: "running", retryCount: 0 }];
    await expect(
      detectAndAlertStuckTasks(deps, tasks, tmpFile),
    ).resolves.toBeUndefined();
  });

  test("BUG: invalid JSON in state file silently resets all tracking state", async () => {
    // Pre-populate corrupted state file
    await fs.writeFile(tmpFile, "CORRUPTED JSON", "utf8");

    const deps = makeDeps();
    const tasks = [{ linearIssueId: "T-corrupt", orcaStatus: "running", retryCount: 0 }];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    // After the call, state file should be rewritten with just the current snapshot
    const written = await fs.readFile(tmpFile, "utf8");
    const savedState = JSON.parse(written) as TaskTrackingState;

    // Because corrupted JSON caused state to reset to {}, this task will start
    // at consecutiveSnapshots=1 instead of continuing from where it left off.
    // This is silent data loss — no error thrown, no warning to caller.
    expect(savedState["T-corrupt"]).toBeDefined();
    expect(savedState["T-corrupt"]!.consecutiveSnapshots).toBe(1);
    // The test exposes the silent reset — a corrupted file destroys tracking history.
  });

  test("state file is written after processing", async () => {
    const deps = makeDeps();
    const tasks = [{ linearIssueId: "T-write", orcaStatus: "running", retryCount: 0 }];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-write"]).toBeDefined();
    expect(state["T-write"]!.consecutiveSnapshots).toBe(1);
  });

  test("second call increments consecutiveSnapshots and fires alert", async () => {
    const deps = makeDeps();
    const tasks = [{ linearIssueId: "T-inc", orcaStatus: "running", retryCount: 0 }];

    // First call
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);
    // Second call — should increment to 2 and fire alert
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    // Alert should have been sent (sendAlertThrottled is called, which calls sendAlert,
    // which inserts a system event)
    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const events = getRecentSystemEvents(deps.db);
    expect(events.length).toBeGreaterThan(0);
  });

  test("terminal status task is removed from state file", async () => {
    // Seed state file with a task
    const initialState: TaskTrackingState = {
      "T-terminal": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const deps = makeDeps();
    // Task is now "done"
    const tasks = [{ linearIssueId: "T-terminal", orcaStatus: "done", retryCount: 0 }];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-terminal"]).toBeUndefined();
  });

  test("task disappearing between snapshots is removed from state file", async () => {
    const initialState: TaskTrackingState = {
      "T-vanish": {
        status: "running",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 2,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const deps = makeDeps();
    // T-vanish is no longer in currentTasks
    await detectAndAlertStuckTasks(deps, [], tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-vanish"]).toBeUndefined();
  });

  test("BUG: alert key changes when status changes, resetting 30min cooldown", async () => {
    // The alert key is `stuck-task-${linearIssueId}-${status}`.
    // If a task goes running -> in_review -> running, each status change
    // creates a NEW cooldown key. The 30min throttle restarts from 0.
    // This means a task that oscillates between two stuck statuses can
    // generate alerts more frequently than intended.
    // This is a design flaw: the cooldown should be per-task, not per-task+status.
    const deps = makeDeps();

    // Simulate: T-osc has been "running" for many snapshots
    const state1: TaskTrackingState = {
      "T-osc": {
        status: "running",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 5,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(state1), "utf8");

    // Call 1: T-osc is still running (alert with key stuck-task-T-osc-running fires)
    await detectAndAlertStuckTasks(
      deps,
      [{ linearIssueId: "T-osc", orcaStatus: "running", retryCount: 0 }],
      tmpFile,
    );

    // Call 2: T-osc switches to in_review (new key stuck-task-T-osc-in_review)
    await detectAndAlertStuckTasks(
      deps,
      [{ linearIssueId: "T-osc", orcaStatus: "in_review", retryCount: 0 }],
      tmpFile,
    );

    // Call 3: back to in_review at snapshot 2 — another alert for stuck-task-T-osc-in_review
    // if cooldown hasn't expired
    // This is documenting the behavior, not necessarily a hard failure
    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const events = getRecentSystemEvents(deps.db);
    // First call fires alert for running (snapshot 6), second call resets to in_review snap=1 (no alert)
    // This is actually correct behavior for the status-change reset
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // --- Alert sends correct taskId to Linear ---

  test("alert taskId matches linearIssueId used for Linear comment", async () => {
    const deps = makeDeps();
    const initialState: TaskTrackingState = {
      "LINEAR-42": {
        status: "running",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const tasks = [{ linearIssueId: "LINEAR-42", orcaStatus: "running", retryCount: 0 }];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // The Linear comment should be called with the correct task ID
    expect(deps.client.createComment).toHaveBeenCalledWith(
      "LINEAR-42",
      expect.stringContaining("LINEAR-42"),
    );
  });
});

// ---------------------------------------------------------------------------
// STUCK_THRESHOLDS and TERMINAL_STATUSES completeness checks
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("all expected active statuses have thresholds", () => {
    const expectedStatuses = ["running", "dispatched", "in_review", "awaiting_ci", "changes_requested", "deploying"];
    for (const status of expectedStatuses) {
      expect(STUCK_THRESHOLDS[status]).toBeDefined();
    }
  });

  test("terminal statuses don't overlap with STUCK_THRESHOLDS", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(STUCK_THRESHOLDS[status]).toBeUndefined();
    }
  });

  test("awaiting_ci threshold is higher than others (4 vs 2)", () => {
    expect(STUCK_THRESHOLDS["awaiting_ci"]).toBe(4);
    expect(STUCK_THRESHOLDS["running"]).toBe(2);
    expect(STUCK_THRESHOLDS["dispatched"]).toBe(2);
  });
});
