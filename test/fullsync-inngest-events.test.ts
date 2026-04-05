// ---------------------------------------------------------------------------
// Tests for fullSync() emitting task/ready events to Inngest
// (EMI-317: fullSync never emits task/ready events)
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

vi.mock("../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitTasksRefreshed: vi.fn(),
}));

import { createDb, type OrcaDb } from "../src/db/index.js";
import { insertTask, getTask } from "../src/db/queries.js";
import { labelToStagePhase } from "../src/shared/types.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): void {
  const ts = now();
  const resolved = labelToStagePhase(statusOrStage);
  insertTask(db, {
    linearIssueId,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    lifecycleStage: resolved.stage,
    currentPhase: resolved.phase,
    priority: 0,
    retryCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    projectRepoMap: new Map([["proj-1", "/tmp/test"]]),
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

function makeInngest() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal LinearClient mock */
function makeClient(issues: LinearIssue[] = []) {
  return {
    updateIssueState: vi.fn().mockResolvedValue(undefined),
    fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    fetchLabelIdByName: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal DependencyGraph mock */
function makeGraph() {
  return { rebuild: vi.fn() };
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-id-1",
    identifier: "PROJ-1",
    title: "Test Issue",
    description: "desc",
    priority: 2,
    state: { id: "s-todo", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    projectName: "Test Project",
    childIds: [],
    labels: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fullSync — Inngest event emission", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Test 1: emits task/ready for newly inserted task with unstarted Linear state
  // ---------------------------------------------------------------------------

  it("emits task/ready for newly inserted task with unstarted Linear state", async () => {
    const inngest = makeInngest();
    const issue = makeIssue({
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    });
    const client = makeClient([issue]);

    await fullSync(
      db,
      client as any,
      makeGraph() as any,
      testConfig(),
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    const call = inngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/ready");
    expect(call.data.linearIssueId).toBe("PROJ-1");
    expect(call.data.repoPath).toBe("/tmp/test");
  });

  // ---------------------------------------------------------------------------
  // Test 2: emits task/ready when existing backlog task transitions to ready
  // ---------------------------------------------------------------------------

  it("emits task/ready when existing backlog task transitions to ready", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "backlog");

    const issue = makeIssue({
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    });
    const client = makeClient([issue]);

    await fullSync(
      db,
      client as any,
      makeGraph() as any,
      testConfig(),
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    const call = inngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/ready");
    expect(call.data.linearIssueId).toBe("PROJ-1");
  });

  // ---------------------------------------------------------------------------
  // Test 3: does NOT emit task/ready for task already in ready state
  // ---------------------------------------------------------------------------

  it("does NOT emit task/ready for task already in ready state", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "ready");

    const issue = makeIssue({
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    });
    const client = makeClient([issue]);

    await fullSync(
      db,
      client as any,
      makeGraph() as any,
      testConfig(),
      undefined,
      inngest as any,
    );

    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 4: does NOT emit task/ready for backlog tasks
  // ---------------------------------------------------------------------------

  it("does NOT emit task/ready for backlog tasks", async () => {
    const inngest = makeInngest();
    const issue = makeIssue({
      state: { id: "s-backlog", name: "Backlog", type: "backlog" },
    });
    const client = makeClient([issue]);

    await fullSync(
      db,
      client as any,
      makeGraph() as any,
      testConfig(),
      undefined,
      inngest as any,
    );

    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 5: emits task/ready for new task with "started" Linear state (mapped to ready on insert)
  // ---------------------------------------------------------------------------

  it("emits task/ready for new task with 'started' Linear state (mapped to ready on insert)", async () => {
    const inngest = makeInngest();
    const issue = makeIssue({
      state: { id: "s-progress", name: "In Progress", type: "started" },
    });
    const client = makeClient([issue]);

    await fullSync(
      db,
      client as any,
      makeGraph() as any,
      testConfig(),
      undefined,
      inngest as any,
    );

    // "started" state on insert → insertStatus = "ready" (since no agent is actually running)
    expect(inngest.send).toHaveBeenCalledOnce();
    const call = inngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/ready");
    expect(call.data.linearIssueId).toBe("PROJ-1");
  });

  // ---------------------------------------------------------------------------
  // Test 6: does not throw when inngest.send rejects
  // ---------------------------------------------------------------------------

  it("does not throw when inngest.send rejects (fire-and-forget)", async () => {
    const inngest = makeInngest();
    inngest.send.mockRejectedValue(new Error("Inngest server unreachable"));

    const issue = makeIssue({
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    });
    const client = makeClient([issue]);

    await expect(
      fullSync(
        db,
        client as any,
        makeGraph() as any,
        testConfig(),
        undefined,
        undefined,
        inngest as any,
      ),
    ).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 7: does not emit when inngest not provided
  // ---------------------------------------------------------------------------

  it("does not crash and emits nothing when inngest not provided", async () => {
    const issue = makeIssue({
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
    });
    const client = makeClient([issue]);

    await expect(
      fullSync(db, client as any, makeGraph() as any, testConfig()),
    ).resolves.toBeDefined();

    // Task should still be inserted correctly
    expect(getTask(db, "PROJ-1")?.lifecycleStage).toBe("ready");
  });
});
