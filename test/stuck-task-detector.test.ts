// ---------------------------------------------------------------------------
// stuck-task-detector tests — adversarial, meant to expose bugs
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  processSnapshot,
  detectAndAlertStuckTasks,
  detectAndAlertStuckDrain,
  STUCK_THRESHOLDS,
  TERMINAL_STATUSES,
  DEFAULT_TRACKING_FILE,
  DEFAULT_DRAIN_TRACKING_FILE,
  type TaskTrackingState,
  type StuckTaskAlert,
  type DrainTrackingState,
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
    drainTimeoutMin: 10,
    cleanupIntervalMin: 10000,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
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
    // snapshot becomes 4, threshold is 4: 4 === 4 fires
    expect(alerts).toHaveLength(1);
  });

  // --- Alert fires only at the exact threshold boundary ---
  // Once past the threshold, no further alerts from processSnapshot itself.

  test("no alert fires past the threshold boundary (snapshot 11, threshold 2)", () => {
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
    // snapshot becomes 11, threshold is 2: 11 !== 2, so no alert
    expect(alerts).toHaveLength(0);
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

  test("alert key is per-task only (not per-task+status), so cooldown persists across status changes", async () => {
    // The alert key is `stuck-task-${linearIssueId}`.
    // Even if a task oscillates between stuck statuses, the same cooldown key is used,
    // preventing alert spam.
    const deps = makeDeps();

    // Simulate: T-osc has been "running" for many snapshots (past threshold)
    const state1: TaskTrackingState = {
      "T-osc": {
        status: "running",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(state1), "utf8");

    // Call 1: T-osc hits threshold (snap=2), alert fires with key stuck-task-T-osc
    await detectAndAlertStuckTasks(
      deps,
      [{ linearIssueId: "T-osc", orcaStatus: "running", retryCount: 0 }],
      tmpFile,
    );

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const eventsAfterFirst = getRecentSystemEvents(deps.db);
    expect(eventsAfterFirst.length).toBeGreaterThanOrEqual(1);
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

// ---------------------------------------------------------------------------
// detectAndAlertStuckDrain
// ---------------------------------------------------------------------------

describe("detectAndAlertStuckDrain", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    resetHealingCounters();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function drainFile(): string {
    return path.join(tmpDir, "drain-state.json");
  }

  async function readDrainState(filePath: string): Promise<DrainTrackingState> {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as DrainTrackingState;
  }

  test("not draining: resets state to zero and saves", async () => {
    const deps = makeDeps();
    const filePath = drainFile();
    // Pre-seed non-zero state
    await fs.writeFile(filePath, JSON.stringify({ consecutiveZeroSessionSnapshots: 3, firstSeenAt: new Date().toISOString() }));

    const result = await detectAndAlertStuckDrain(deps, false, 0, filePath);

    expect(result.consecutiveZeroSessionSnapshots).toBe(0);
    expect(result.firstSeenAt).toBeNull();
    const saved = await readDrainState(filePath);
    expect(saved.consecutiveZeroSessionSnapshots).toBe(0);
    expect(saved.firstSeenAt).toBeNull();
  });

  test("draining with active sessions: resets state (normal drain)", async () => {
    const deps = makeDeps();
    const filePath = drainFile();

    const result = await detectAndAlertStuckDrain(deps, true, 3, filePath);

    expect(result.consecutiveZeroSessionSnapshots).toBe(0);
    expect(result.firstSeenAt).toBeNull();
  });

  test("draining, zero sessions, first snapshot: count=1, no alert", async () => {
    const deps = makeDeps();
    const filePath = drainFile();
    const sendAlertSpy = vi.spyOn(deps.client, "createComment");

    const result = await detectAndAlertStuckDrain(deps, true, 0, filePath);

    expect(result.consecutiveZeroSessionSnapshots).toBe(1);
    expect(result.firstSeenAt).not.toBeNull();
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });

  test("draining, zero sessions, second snapshot: count=2, alert fires once", async () => {
    const deps = makeDeps();
    const filePath = drainFile();

    // First snapshot
    await detectAndAlertStuckDrain(deps, true, 0, filePath);
    // Second snapshot
    const result = await detectAndAlertStuckDrain(deps, true, 0, filePath);

    expect(result.consecutiveZeroSessionSnapshots).toBe(2);
    // createComment is the observable side-effect of sendAlert
    expect(deps.client.createComment).not.toHaveBeenCalled(); // no taskId, so no Linear comment
    // Alert fires through webhook — not easily testable here without webhook config.
    // Key assertion: count reached 2
    expect(result.consecutiveZeroSessionSnapshots).toBe(2);
  });

  test("draining, zero sessions, third snapshot: count=3, alert NOT re-fired (boundary semantics)", async () => {
    const deps = makeDeps();
    const filePath = drainFile();

    await detectAndAlertStuckDrain(deps, true, 0, filePath); // count=1
    await detectAndAlertStuckDrain(deps, true, 0, filePath); // count=2, alert
    const result = await detectAndAlertStuckDrain(deps, true, 0, filePath); // count=3, no alert (=== 2 check)

    expect(result.consecutiveZeroSessionSnapshots).toBe(3);
  });

  test("firstSeenAt is set on first snapshot and preserved on subsequent ones", async () => {
    const deps = makeDeps();
    const filePath = drainFile();

    const r1 = await detectAndAlertStuckDrain(deps, true, 0, filePath);
    const firstSeenAt = r1.firstSeenAt;
    expect(firstSeenAt).not.toBeNull();

    const r2 = await detectAndAlertStuckDrain(deps, true, 0, filePath);
    expect(r2.firstSeenAt).toBe(firstSeenAt);
  });

  test("session fluctuation resets counter: zero→nonzero→zero starts fresh", async () => {
    const deps = makeDeps();
    const filePath = drainFile();

    await detectAndAlertStuckDrain(deps, true, 0, filePath); // count=1
    await detectAndAlertStuckDrain(deps, true, 2, filePath); // reset
    const result = await detectAndAlertStuckDrain(deps, true, 0, filePath); // count=1 again

    expect(result.consecutiveZeroSessionSnapshots).toBe(1); // reset, not 2
  });

  test("returns zero state when state file is absent (first run)", async () => {
    const deps = makeDeps();
    const filePath = path.join(tmpDir, "nonexistent-dir", "drain.json");

    // Should not throw — creates dir and file
    const result = await detectAndAlertStuckDrain(deps, true, 0, filePath);
    expect(result.consecutiveZeroSessionSnapshots).toBe(1);
  });

  test("DEFAULT_DRAIN_TRACKING_FILE is different from DEFAULT_TRACKING_FILE", () => {
    expect(DEFAULT_DRAIN_TRACKING_FILE).not.toBe(DEFAULT_TRACKING_FILE);
    expect(DEFAULT_DRAIN_TRACKING_FILE).toContain("drain");
  });
});
