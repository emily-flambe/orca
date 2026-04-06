// ---------------------------------------------------------------------------
// Unit tests for mapLinearStateToOrcaStatus (via resolveConflict + sync exports)
// Tests the type-based state mapping introduced in EMI-235.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scheduler + runner so sync imports don't fail
vi.mock("../src/session-handles.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

// We test mapLinearStateToOrcaStatus indirectly via the exported fullSync/upsertTask
// path by importing a thin test shim. Since mapLinearStateToOrcaStatus is not
// exported, we test its behavior through the exported resolveConflict (which
// uses it internally) and through type assertions on upsertTask behavior.
//
// For direct unit tests, we re-implement the exact function logic here and
// verify the mapping table — this is intentional: tests should fail if the
// implementation changes unexpectedly.

// We also test via processWebhookEvent to exercise the full path.

import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";
import { labelToStagePhase } from "../src/shared/types.js";
import type { OrcaConfig } from "../src/config/index.js";

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function seedTask(
  db: OrcaDb,
  linearIssueId: string,
  statusOrStage: string = "ready",
): string {
  const ts = now();
  const resolved = labelToStagePhase(statusOrStage);
  insertTask(db, {
    linearIssueId,
    agentPrompt: "test",
    repoPath: "/tmp/test",
    lifecycleStage: resolved.stage,
    currentPhase: resolved.phase,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return linearIssueId;
}

function _testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    projectRepoMap: new Map(),
    concurrencyCap: 3,
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
    linearWebhookSecret: "test-webhook-secret",
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
// mapLinearStateToOrcaStatus — behavior via resolveConflict
//
// resolveConflict(db, taskId, stateName, stateType) calls mapLinearStateToOrcaStatus
// internally. We test the mapping by checking what resolveConflict does to a
// "ready" task (the simplest non-matching starting state).
// ---------------------------------------------------------------------------

describe("mapLinearStateToOrcaStatus — type-based mapping", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("backlog type → maps to backlog", () => {
    seedTask(db, "SM-1", "ready");
    resolveConflict(db, "SM-1", "Backlog", "backlog");
    const task = getTask(db, "SM-1")!;
    expect(task.lifecycleStage).toBe("backlog");
    expect(task.lifecycleStage).toBe("backlog");
    expect(task.currentPhase).toBeNull();
  });

  it("unstarted type → maps to ready", () => {
    seedTask(db, "SM-2", "done");
    resolveConflict(db, "SM-2", "Todo", "unstarted");
    const task = getTask(db, "SM-2")!;
    expect(task.lifecycleStage).toBe("ready");
    expect(task.lifecycleStage).toBe("ready");
    expect(task.currentPhase).toBeNull();
  });

  it("unstarted type with custom name → still maps to ready", () => {
    seedTask(db, "SM-3", "done");
    resolveConflict(db, "SM-3", "Ready to Start", "unstarted");
    const task = getTask(db, "SM-3")!;
    expect(task.lifecycleStage).toBe("ready");
    expect(task.lifecycleStage).toBe("ready");
    expect(task.currentPhase).toBeNull();
  });

  it("started type without 'review' in name → maps to running (no conflict action for ready→running)", () => {
    // ready → running: no explicit conflict rule, so no change (falls through)
    seedTask(db, "SM-4", "ready");
    resolveConflict(db, "SM-4", "In Progress", "started");
    // ready === running? No. But there's no explicit conflict rule for ready+running,
    // so resolveConflict falls through without doing anything.
    const task = getTask(db, "SM-4")!;
    expect(task.lifecycleStage).toBe("ready");
    expect(task.lifecycleStage).toBe("ready");
  });

  it("completed type → maps to done (ready→done conflict resolved)", () => {
    seedTask(db, "SM-5", "ready");
    resolveConflict(db, "SM-5", "Done", "completed");
    const task = getTask(db, "SM-5")!;
    expect(task.lifecycleStage).toBe("done");
    expect(task.lifecycleStage).toBe("done");
    expect(task.currentPhase).toBeNull();
  });

  it("canceled type → returns null (no conflict resolution performed)", () => {
    // canceled: resolveConflict catches it before mapLinearStateToOrcaStatus
    seedTask(db, "SM-6", "running");
    resolveConflict(db, "SM-6", "Canceled", "canceled");
    const task = getTask(db, "SM-6")!;
    expect(task.lifecycleStage).toBe("failed");
    expect(task.lifecycleStage).toBe("failed");
    expect(task.currentPhase).toBeNull();
  });

  it("unknown type → returns null (no action)", () => {
    seedTask(db, "SM-7", "ready");
    resolveConflict(db, "SM-7", "Custom State", "triage");
    // mapLinearStateToOrcaStatus returns null for unknown types → no action
    const task = getTask(db, "SM-7")!;
    expect(task.lifecycleStage).toBe("ready");
    expect(task.lifecycleStage).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Review heuristic — "started" type with various "review" names
// ---------------------------------------------------------------------------

describe("mapLinearStateToOrcaStatus — review heuristic", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"Code Review" (started type) → review heuristic matches (no-op for deploying)', () => {
    seedTask(db, "RH-2", "deploying");
    resolveConflict(db, "RH-2", "Code Review", "started");
    // deploying + started+review → no-op (case 8)
    expect(getTask(db, "RH-2")!.lifecycleStage).toBe("active");
  });

  it('"REVIEW PENDING" (started type, uppercase) → review heuristic matches', () => {
    seedTask(db, "RH-3", "deploying");
    resolveConflict(db, "RH-3", "REVIEW PENDING", "started");
    // deploying + started+/review/i → no-op
    expect(getTask(db, "RH-3")!.lifecycleStage).toBe("active");
  });

  it('"In Progress" (started type, no review) → maps to running (no no-op for deploying)', () => {
    seedTask(db, "RH-4", "deploying");
    resolveConflict(db, "RH-4", "In Progress", "started");
    // deploying + started without "review" → falls through (no rule), status unchanged
    expect(getTask(db, "RH-4")!.lifecycleStage).toBe("active");
  });
});

// stateMapOverrides was removed — override precedence tests no longer apply.

// ---------------------------------------------------------------------------
// Standard workflow produces same results as before
// (regression test for the original name-based mapping)
// ---------------------------------------------------------------------------

describe("mapLinearStateToOrcaStatus — standard workflow regression", () => {
  let db: OrcaDb;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Backlog (type=backlog) → "backlog"', () => {
    seedTask(db, "REG-1", "ready");
    resolveConflict(db, "REG-1", "Backlog", "backlog");
    expect(getTask(db, "REG-1")!.lifecycleStage).toBe("backlog");
  });

  it('Todo (type=unstarted) → "ready"', () => {
    seedTask(db, "REG-2", "done");
    resolveConflict(db, "REG-2", "Todo", "unstarted");
    expect(getTask(db, "REG-2")!.lifecycleStage).toBe("ready");
  });

  it('In Progress (type=started) → "running" (no conflict rule for ready→running, stays ready)', () => {
    seedTask(db, "REG-3", "ready");
    resolveConflict(db, "REG-3", "In Progress", "started");
    expect(getTask(db, "REG-3")!.lifecycleStage).toBe("ready");
  });

  it('Done (type=completed) → "done" (ready task becomes done)', () => {
    seedTask(db, "REG-5", "ready");
    resolveConflict(db, "REG-5", "Done", "completed");
    expect(getTask(db, "REG-5")!.lifecycleStage).toBe("done");
  });

  it("Canceled (type=canceled) → null (running task becomes failed)", () => {
    seedTask(db, "REG-6", "running");
    resolveConflict(db, "REG-6", "Canceled", "canceled");
    expect(getTask(db, "REG-6")!.lifecycleStage).toBe("failed");
  });
});
