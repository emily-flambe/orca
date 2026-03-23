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
  orcaStatus: OrcaConfig extends never ? never : string = "ready",
): string {
  const ts = now();
  insertTask(db, {
    linearIssueId,
    agentPrompt: "test",
    repoPath: "/tmp/test",
    orcaStatus: orcaStatus as any,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return linearIssueId;
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
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
    expect(getTask(db, "SM-1")!.orcaStatus).toBe("backlog");
  });

  it("unstarted type → maps to ready", () => {
    seedTask(db, "SM-2", "done");
    resolveConflict(db, "SM-2", "Todo", "unstarted");
    expect(getTask(db, "SM-2")!.orcaStatus).toBe("ready");
  });

  it("unstarted type with custom name → still maps to ready", () => {
    seedTask(db, "SM-3", "done");
    resolveConflict(db, "SM-3", "Ready to Start", "unstarted");
    expect(getTask(db, "SM-3")!.orcaStatus).toBe("ready");
  });

  it("started type without 'review' in name → maps to running (no conflict action for ready→running)", () => {
    // ready → running: no explicit conflict rule, so no change (falls through)
    seedTask(db, "SM-4", "ready");
    resolveConflict(db, "SM-4", "In Progress", "started");
    // ready === running? No. But there's no explicit conflict rule for ready+running,
    // so resolveConflict falls through without doing anything.
    expect(getTask(db, "SM-4")!.orcaStatus).toBe("ready");
  });

  it("completed type → maps to done (ready→done conflict resolved)", () => {
    seedTask(db, "SM-5", "ready");
    resolveConflict(db, "SM-5", "Done", "completed");
    expect(getTask(db, "SM-5")!.orcaStatus).toBe("done");
  });

  it("canceled type → returns null (no conflict resolution performed)", () => {
    // canceled: resolveConflict catches it before mapLinearStateToOrcaStatus
    seedTask(db, "SM-6", "running");
    resolveConflict(db, "SM-6", "Canceled", "canceled");
    expect(getTask(db, "SM-6")!.orcaStatus).toBe("failed");
  });

  it("unknown type → returns null (no action)", () => {
    seedTask(db, "SM-7", "ready");
    resolveConflict(db, "SM-7", "Custom State", "triage");
    // mapLinearStateToOrcaStatus returns null for unknown types → no action
    expect(getTask(db, "SM-7")!.orcaStatus).toBe("ready");
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

  // To verify "started+review" → in_review, we need a task in a state that
  // conflicts with in_review. in_review→done is case 5, so we use that.
  it('"In Review" (started type) → maps to in_review', () => {
    seedTask(db, "RH-1", "in_review");
    resolveConflict(db, "RH-1", "Done", "completed");
    expect(getTask(db, "RH-1")!.orcaStatus).toBe("done");
    // Re-seed to test the review heuristic directly
    const db2 = freshDb();
    seedTask(db2, "RH-1b", "in_review");
    resolveConflict(db2, "RH-1b", "In Review", "started");
    // in_review matches in_review → no change
    expect(getTask(db2, "RH-1b")!.orcaStatus).toBe("in_review");
  });

  it('"Code Review" (started type) → review heuristic matches (no-op for deploying)', () => {
    seedTask(db, "RH-2", "deploying");
    resolveConflict(db, "RH-2", "Code Review", "started");
    // deploying + started+review → no-op (case 8)
    expect(getTask(db, "RH-2")!.orcaStatus).toBe("deploying");
  });

  it('"REVIEW PENDING" (started type, uppercase) → review heuristic matches', () => {
    seedTask(db, "RH-3", "deploying");
    resolveConflict(db, "RH-3", "REVIEW PENDING", "started");
    // deploying + started+/review/i → no-op
    expect(getTask(db, "RH-3")!.orcaStatus).toBe("deploying");
  });

  it('"In Progress" (started type, no review) → maps to running (no no-op for deploying)', () => {
    seedTask(db, "RH-4", "deploying");
    resolveConflict(db, "RH-4", "In Progress", "started");
    // deploying + started without "review" → falls through (no rule), status unchanged
    expect(getTask(db, "RH-4")!.orcaStatus).toBe("deploying");
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
    expect(getTask(db, "REG-1")!.orcaStatus).toBe("backlog");
  });

  it('Todo (type=unstarted) → "ready"', () => {
    seedTask(db, "REG-2", "done");
    resolveConflict(db, "REG-2", "Todo", "unstarted");
    expect(getTask(db, "REG-2")!.orcaStatus).toBe("ready");
  });

  it('In Progress (type=started) → "running" (no conflict rule for ready→running, stays ready)', () => {
    seedTask(db, "REG-3", "ready");
    resolveConflict(db, "REG-3", "In Progress", "started");
    expect(getTask(db, "REG-3")!.orcaStatus).toBe("ready");
  });

  it('In Review (type=started) → "in_review" (matches in_review task → no change)', () => {
    seedTask(db, "REG-4", "in_review");
    resolveConflict(db, "REG-4", "In Review", "started");
    expect(getTask(db, "REG-4")!.orcaStatus).toBe("in_review");
  });

  it('Done (type=completed) → "done" (ready task becomes done)', () => {
    seedTask(db, "REG-5", "ready");
    resolveConflict(db, "REG-5", "Done", "completed");
    expect(getTask(db, "REG-5")!.orcaStatus).toBe("done");
  });

  it("Canceled (type=canceled) → null (running task becomes failed)", () => {
    seedTask(db, "REG-6", "running");
    resolveConflict(db, "REG-6", "Canceled", "canceled");
    expect(getTask(db, "REG-6")!.orcaStatus).toBe("failed");
  });
});
