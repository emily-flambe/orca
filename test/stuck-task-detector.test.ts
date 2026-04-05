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
  STUCK_THRESHOLDS,
  type TaskTrackingState,
} from "../src/scheduler/stuck-task-detector.js";
import {
  _getHealingCounters,
  _getAlertCooldowns,
} from "../src/scheduler/alerts.js";
import { createDb } from "../src/db/index.js";

/** Test-only helper: clears all healing counters and alert cooldowns. */
function resetHealingCounters(): void {
  _getHealingCounters().clear();
  _getAlertCooldowns().clear();
}
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a task with lifecycleStage/currentPhase for processSnapshot tests. */
function activeTask(linearIssueId: string, phase: string, retryCount = 0) {
  return {
    linearIssueId,
    
    lifecycleStage: "active" as const,
    currentPhase: phase,
    retryCount,
  };
}

function terminalTask(
  linearIssueId: string,
  stage: "done" | "failed" | "canceled",
  retryCount = 0,
) {
  return {
    linearIssueId,
    
    lifecycleStage: stage,
    currentPhase: null,
    retryCount,
  };
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    model: "sonnet",
    reviewModel: "haiku",
    deployStrategy: "none",
    maxDeployPollAttempts: 60,
    maxCiPollAttempts: 240,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    projectRepoMap: new Map(),
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
// processSnapshot -- pure logic
// ---------------------------------------------------------------------------

describe("processSnapshot", () => {
  // --- Basic tracking ---

  test("empty task list returns empty state and no alerts", () => {
    const { updatedState, alerts } = processSnapshot([], {});
    expect(updatedState).toEqual({});
    expect(alerts).toEqual([]);
  });

  test("first snapshot: task enters non-terminal status, consecutiveSnapshots=1, no alert", () => {
    const tasks = [activeTask("T-1", "implement")];
    const { updatedState, alerts } = processSnapshot(tasks, {});
    expect(updatedState["T-1"]).toBeDefined();
    expect(updatedState["T-1"]!.consecutiveSnapshots).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  test("second snapshot in same status: consecutiveSnapshots=2, alert fires for threshold=2", () => {
    const tasks = [activeTask("T-2", "implement")];
    const state: TaskTrackingState = {
      "T-2": {
        status: "implement",
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
    const terminalStages = ["done", "failed", "canceled"] as const;
    for (const stage of terminalStages) {
      const tasks = [terminalTask("T-term", stage)];
      const state: TaskTrackingState = {
        "T-term": {
          status: "implement",
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
        status: "implement",
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
        status: "implement",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 5,
        retryCount: 0,
      },
    };
    const tasks = [activeTask("T-change", "review")];
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(updatedState["T-change"]!.consecutiveSnapshots).toBe(1);
    expect(updatedState["T-change"]!.status).toBe("review");
    expect(alerts).toHaveLength(0);
  });

  test("status change resets firstSeenAt to now", () => {
    const oldTime = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    const state: TaskTrackingState = {
      "T-time": {
        status: "implement",
        firstSeenAt: oldTime,
        consecutiveSnapshots: 10,
        retryCount: 0,
      },
    };
    const now = new Date();
    const tasks = [activeTask("T-time", "review")];
    const { updatedState } = processSnapshot(tasks, state, now);
    expect(updatedState["T-time"]!.firstSeenAt).toBe(now.toISOString());
  });

  test("retryCount increment with same status does not reset consecutiveSnapshots", () => {
    const state: TaskTrackingState = {
      "T-retry": {
        status: "implement",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 5,
        retryCount: 0,
      },
    };
    const tasks = [activeTask("T-retry", "implement", 1)];
    const { updatedState } = processSnapshot(tasks, state);
    expect(updatedState["T-retry"]!.consecutiveSnapshots).toBe(6);
    expect(updatedState["T-retry"]!.retryCount).toBe(1);
  });

  // --- ci threshold is 4 ---

  test("ci: no alert at snapshot 3 (entering with 2, incrementing to 3)", () => {
    const tasks = [activeTask("T-ci", "ci")];
    const state: TaskTrackingState = {
      "T-ci": {
        status: "ci",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 2,
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    expect(alerts).toHaveLength(0);
  });

  test("ci: alert fires at snapshot 4 (entering with 3, incrementing to 4 which meets threshold)", () => {
    const tasks = [activeTask("T-ci4", "ci")];
    const state: TaskTrackingState = {
      "T-ci4": {
        status: "ci",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    expect(alerts).toHaveLength(1);
  });

  test("no alert fires past the threshold boundary (snapshot 11, threshold 2)", () => {
    const tasks = [activeTask("T-spam", "implement")];
    const state: TaskTrackingState = {
      "T-spam": {
        status: "implement",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 10,
        retryCount: 0,
      },
    };
    const { alerts } = processSnapshot(tasks, state);
    expect(alerts).toHaveLength(0);
  });

  test("alert includes all required fields", () => {
    const firstSeenAt = new Date(Date.now() - 120_000).toISOString();
    const tasks = [activeTask("T-fields", "implement", 2)];
    const state: TaskTrackingState = {
      "T-fields": {
        status: "implement",
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
    expect(alert.status).toBe("implement");
    expect(alert.consecutiveSnapshots).toBe(2);
    expect(alert.firstSeenAt).toBe(firstSeenAt);
    expect(alert.retryCount).toBe(2);
    expect(alert.durationMinutes).toBe(2);
  });

  test("unknown status accumulates in state indefinitely without alert", () => {
    const tasks = [activeTask("T-unk", "some_new_phase")];
    const state: TaskTrackingState = {
      "T-unk": {
        status: "some_new_phase",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 100,
        retryCount: 0,
      },
    };
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(alerts).toHaveLength(0);
    expect(updatedState["T-unk"]).toBeDefined();
    expect(updatedState["T-unk"]!.consecutiveSnapshots).toBe(101);
  });

  test("firstSeenAt is preserved when status stays same", () => {
    const originalTime = new Date(Date.now() - 300_000).toISOString();
    const state: TaskTrackingState = {
      "T-preserve": {
        status: "implement",
        firstSeenAt: originalTime,
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const tasks = [activeTask("T-preserve", "implement")];
    const { updatedState } = processSnapshot(tasks, state);
    expect(updatedState["T-preserve"]!.firstSeenAt).toBe(originalTime);
  });

  test("multiple tasks processed correctly in same snapshot", () => {
    const tasks = [
      activeTask("T-a", "implement"),
      activeTask("T-b", "ci", 1),
      terminalTask("T-c", "done"),
    ];
    const state: TaskTrackingState = {
      "T-a": {
        status: "implement",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
      "T-b": {
        status: "ci",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 1,
      },
    };
    const { updatedState, alerts } = processSnapshot(tasks, state);
    expect(updatedState["T-a"]!.consecutiveSnapshots).toBe(2);
    expect(updatedState["T-b"]!.consecutiveSnapshots).toBe(4);
    expect(updatedState["T-c"]).toBeUndefined();
    expect(alerts).toHaveLength(2);
  });

  test("all tasks terminal: updatedState is empty", () => {
    const tasks = [
      terminalTask("T-done1", "done"),
      terminalTask("T-done2", "failed", 3),
      terminalTask("T-done3", "canceled"),
    ];
    const { updatedState, alerts } = processSnapshot(tasks, {});
    expect(Object.keys(updatedState)).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  test("processSnapshot does not mutate the input state object", () => {
    const state: TaskTrackingState = {
      "T-pure": {
        status: "implement",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const frozen = { ...state };
    const tasks = [activeTask("T-pure", "implement")];
    processSnapshot(tasks, state);
    expect(state["T-pure"]!.consecutiveSnapshots).toBe(
      frozen["T-pure"]!.consecutiveSnapshots,
    );
  });

  test("durationMinutes correctly calculated from firstSeenAt to now", () => {
    const firstSeenAt = new Date(0).toISOString();
    const now = new Date(10 * 60 * 1000);
    const state: TaskTrackingState = {
      "T-dur": {
        status: "implement",
        firstSeenAt,
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    const tasks = [activeTask("T-dur", "implement")];
    const { alerts } = processSnapshot(tasks, state, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.durationMinutes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// detectAndAlertStuckTasks -- top-level async, never throws
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

  test("never throws -- file not found on first run is handled gracefully", async () => {
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
    const tasks = [activeTask("T-bad", "implement")];
    await expect(
      detectAndAlertStuckTasks(deps, tasks, tmpFile),
    ).resolves.toBeUndefined();
  });

  test("BUG: invalid JSON in state file silently resets all tracking state", async () => {
    await fs.writeFile(tmpFile, "CORRUPTED JSON", "utf8");

    const deps = makeDeps();
    const tasks = [activeTask("T-corrupt", "implement")];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const savedState = JSON.parse(written) as TaskTrackingState;

    expect(savedState["T-corrupt"]).toBeDefined();
    expect(savedState["T-corrupt"]!.consecutiveSnapshots).toBe(1);
  });

  test("state file is written after processing", async () => {
    const deps = makeDeps();
    const tasks = [activeTask("T-write", "implement")];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-write"]).toBeDefined();
    expect(state["T-write"]!.consecutiveSnapshots).toBe(1);
  });

  test("second call increments consecutiveSnapshots and fires alert", async () => {
    const deps = makeDeps();
    const tasks = [activeTask("T-inc", "implement")];

    await detectAndAlertStuckTasks(deps, tasks, tmpFile);
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const events = getRecentSystemEvents(deps.db);
    expect(events.length).toBeGreaterThan(0);
  });

  test("terminal status task is removed from state file", async () => {
    const initialState: TaskTrackingState = {
      "T-terminal": {
        status: "implement",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 3,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const deps = makeDeps();
    const tasks = [terminalTask("T-terminal", "done")];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-terminal"]).toBeUndefined();
  });

  test("task disappearing between snapshots is removed from state file", async () => {
    const initialState: TaskTrackingState = {
      "T-vanish": {
        status: "implement",
        firstSeenAt: new Date().toISOString(),
        consecutiveSnapshots: 2,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const deps = makeDeps();
    await detectAndAlertStuckTasks(deps, [], tmpFile);

    const written = await fs.readFile(tmpFile, "utf8");
    const state = JSON.parse(written) as TaskTrackingState;
    expect(state["T-vanish"]).toBeUndefined();
  });

  test("alert key is per-task only (not per-task+status), so cooldown persists across status changes", async () => {
    const deps = makeDeps();

    const state1: TaskTrackingState = {
      "T-osc": {
        status: "implement",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(state1), "utf8");

    await detectAndAlertStuckTasks(
      deps,
      [activeTask("T-osc", "implement")],
      tmpFile,
    );

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const eventsAfterFirst = getRecentSystemEvents(deps.db);
    expect(eventsAfterFirst.length).toBeGreaterThanOrEqual(1);
  });

  test("alert taskId matches linearIssueId used for Linear comment", async () => {
    const deps = makeDeps();
    const initialState: TaskTrackingState = {
      "LINEAR-42": {
        status: "implement",
        firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
        consecutiveSnapshots: 1,
        retryCount: 0,
      },
    };
    await fs.writeFile(tmpFile, JSON.stringify(initialState), "utf8");

    const tasks = [activeTask("LINEAR-42", "implement")];
    await detectAndAlertStuckTasks(deps, tasks, tmpFile);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(deps.client.createComment).toHaveBeenCalledWith(
      "LINEAR-42",
      expect.stringContaining("LINEAR-42"),
    );
  });
});

// ---------------------------------------------------------------------------
// STUCK_THRESHOLDS completeness checks
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("all expected active phases have thresholds", () => {
    const expectedPhases = ["implement", "review", "ci", "fix", "deploy"];
    for (const phase of expectedPhases) {
      expect(STUCK_THRESHOLDS[phase]).toBeDefined();
    }
  });

  test("terminal stages don't overlap with STUCK_THRESHOLDS", () => {
    const terminalStages = ["done", "failed", "canceled"];
    for (const stage of terminalStages) {
      expect(STUCK_THRESHOLDS[stage]).toBeUndefined();
    }
  });

  test("ci threshold is higher than others (4 vs 2)", () => {
    expect(STUCK_THRESHOLDS["ci"]).toBe(4);
    expect(STUCK_THRESHOLDS["implement"]).toBe(2);
  });
});
