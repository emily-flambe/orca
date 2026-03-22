// ---------------------------------------------------------------------------
// Adversarial tests for Inngest event emission in processWebhookEvent
// (EMI-299: Wire Linear webhooks to Inngest events)
// ---------------------------------------------------------------------------
//
// We test the 4 acceptance criteria plus known edge cases and potential bugs:
//   AC1: task/ready emitted when task transitions to ready
//   AC2: task/cancelled emitted when task is cancelled in Linear
//   AC3: conflict resolution logic preserved
//   AC4: echo prevention still works
//
// Additional adversarial cases:
//   - task/ready should NOT fire when already ready (previousStatus === "ready")
//   - task/ready should NOT fire when echo is consumed (early return)
//   - task/ready fires for brand-new task being created (previousStatus null) - potential false positive
//   - task/cancelled should NOT fire when no prior task exists in DB
//   - task/cancelled should NOT fire when echo is consumed (early return)
//   - task/cancelled DOES fire even when previousStatus is "failed" (already-failed task)
//   - task/ready should NOT fire when event action is "remove"
//   - task/ready should NOT fire when event has no state (event.data.state missing)
//   - task/cancelled with previousStatus "failed" emits a spurious event to Inngest
//   - inngest.send rejection is swallowed (fire-and-forget)
//   - inngest not provided: no event emitted (no crash)
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
import type { OrcaConfig } from "../src/config/index.js";
import type { WebhookEvent } from "../src/linear/sync.js";

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
  orcaStatus: string = "ready",
  retryCount: number = 0,
): void {
  const ts = now();
  insertTask(db, {
    linearIssueId,
    agentPrompt: "do something",
    repoPath: "/tmp/fake-repo",
    orcaStatus: orcaStatus as any,
    priority: 0,
    retryCount,
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
    budgetMaxCostUsd: 10.0,
    claudePath: "claude",
    defaultMaxTurns: 20,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
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
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    taskFilterLabel: undefined,
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    githubWebhookSecret: undefined,
    ...overrides,
  } as OrcaConfig;
}

/** Minimal WorkflowStateMap */
function makeStateMap(): Map<string, { id: string; type: string }> {
  return new Map([
    ["Backlog", { id: "s-backlog", type: "backlog" }],
    ["Todo", { id: "s-todo", type: "unstarted" }],
    ["In Progress", { id: "s-progress", type: "started" }],
    ["In Review", { id: "s-review", type: "started" }],
    ["Done", { id: "s-done", type: "completed" }],
    ["Canceled", { id: "s-canceled", type: "canceled" }],
  ]);
}

/** Minimal LinearClient mock */
function makeClient() {
  return {
    updateIssueState: vi.fn().mockResolvedValue(undefined),
    fetchProjectIssues: vi.fn().mockResolvedValue([]),
    fetchLabelIdByName: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal DependencyGraph mock */
function makeGraph() {
  return { rebuild: vi.fn() };
}

/** Create a fake inngest client */
function makeInngest() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeWebhookEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-id-1",
      identifier: "PROJ-1",
      title: "Test Issue",
      description: "desc",
      priority: 2,
      state: { id: "s-todo", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      projectId: "proj-1",
      labelIds: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processWebhookEvent — Inngest event emission", () => {
  let db: OrcaDb;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;
  let registerExpectedChange: typeof import("../src/linear/sync.js").registerExpectedChange;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    expectedChanges = syncMod.expectedChanges;
    registerExpectedChange = syncMod.registerExpectedChange;
    // Clear any leftover echo prevention state
    expectedChanges.clear();
    syncMod.clearStartupGrace();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expectedChanges.clear();
  });

  // ---------------------------------------------------------------------------
  // AC1: task/ready emitted when task transitions to ready
  // ---------------------------------------------------------------------------

  it("AC1: emits task/ready when existing task transitions from non-ready to ready", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "backlog");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    const call = inngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/ready");
    expect(call.data.linearIssueId).toBe("PROJ-1");
  });

  it("AC1: emits task/ready with correct payload fields", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 3,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    const payload = inngest.send.mock.calls[0][0];
    expect(payload.name).toBe("task/ready");
    expect(payload.data).toMatchObject({
      linearIssueId: "PROJ-1",
      repoPath: "/tmp/test",
    });
  });

  // ---------------------------------------------------------------------------
  // BUG: task/ready fires for brand-new tasks (previousStatus === null)
  // A newly created task with "unstarted" state triggers task/ready even though
  // there was no prior state to "transition from". This may cause duplicate
  // Inngest events if fullSync already handled the task.
  // ---------------------------------------------------------------------------

  it("BUG: task/ready is emitted for a brand-new task (action: create, previousStatus null)", async () => {
    const inngest = makeInngest();
    // Task does NOT exist in DB (new task being created via webhook)

    const event = makeWebhookEvent({
      action: "create",
      data: {
        id: "new-issue-id",
        identifier: "PROJ-99",
        title: "Brand New Issue",
        description: "desc",
        priority: 1,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // This WILL fire because previousStatus=null and null !== "ready"
    // This is a potential false-positive: a brand-new task triggers task/ready
    // even though fullSync may have already done so.
    expect(inngest.send).toHaveBeenCalledOnce();
    expect(inngest.send.mock.calls[0][0].name).toBe("task/ready");
  });

  // ---------------------------------------------------------------------------
  // task/ready should NOT fire when previousStatus is already "ready"
  // ---------------------------------------------------------------------------

  it("does NOT emit task/ready when task is already ready (no transition)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "ready");

    const event = makeWebhookEvent(); // unstarted → ready (same as current)

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // previousStatus === "ready" so condition is false — should NOT fire
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC4: echo prevention — task/ready must NOT fire when event is an echo
  // ---------------------------------------------------------------------------

  it("AC4: does NOT emit task/ready when event is an echo (write-back prevention)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    // Register the echo before the webhook arrives
    registerExpectedChange("PROJ-1", "Todo");

    const event = makeWebhookEvent(); // state: Todo (unstarted)

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // Echo consumed — processWebhookEvent returns early, no Inngest events
    expect(inngest.send).not.toHaveBeenCalled();
    // DB status should remain unchanged
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("running");
  });

  it("AC4: does NOT emit task/cancelled when cancelled event is an echo", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "failed");

    // Register echo for the canceled state
    registerExpectedChange("PROJ-1", "Canceled");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // AC2: task/cancelled emitted when task is cancelled in Linear
  // ---------------------------------------------------------------------------

  it("AC2: emits task/cancelled when a running task is cancelled in Linear", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running", 1);

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    const call = inngest.send.mock.calls[0][0];
    expect(call.name).toBe("task/cancelled");
    expect(call.data.linearIssueId).toBe("PROJ-1");
    expect(call.data.reason).toBe("cancelled in Linear");
    expect(call.data.retryCount).toBe(1);
    expect(call.data.previousStatus).toBe("running");
  });

  it("AC2: emits task/cancelled for a ready task cancelled in Linear", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "ready");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    expect(inngest.send).toHaveBeenCalledOnce();
    expect(inngest.send.mock.calls[0][0].name).toBe("task/cancelled");
    expect(inngest.send.mock.calls[0][0].data.previousStatus).toBe("ready");
  });

  // ---------------------------------------------------------------------------
  // task/cancelled should NOT fire when no prior task exists in DB
  // ---------------------------------------------------------------------------

  it("does NOT emit task/cancelled when cancelled webhook arrives for unknown task", async () => {
    const inngest = makeInngest();
    // Task does NOT exist in DB

    const event = makeWebhookEvent({
      data: {
        id: "ghost-id",
        identifier: "PROJ-GHOST",
        title: "Ghost Issue",
        description: "desc",
        priority: 0,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // previousTask is null → condition `previousTask && previousStatus` is false
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // BUG: task/cancelled fires even when task was already "failed"
  // A task in "failed" status getting a cancel webhook triggers task/cancelled.
  // This could cause spurious cancellation signals to Inngest workflows that
  // already completed (they were already in failed/terminal state).
  // ---------------------------------------------------------------------------

  it("does NOT emit task/cancelled when previousStatus is already 'failed' (terminal state)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "failed");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // task was already in terminal state "failed" — no active workflow to cancel.
    // task/cancelled must NOT fire.
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // BUG: task/cancelled fires even when previousStatus is "done"
  // ---------------------------------------------------------------------------

  it("does NOT emit task/cancelled when previousStatus is 'done' (terminal state)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "done");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Done Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // task was already in terminal state "done" — no active workflow to cancel.
    // task/cancelled must NOT fire.
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // "remove" action: NO Inngest events should fire
  // ---------------------------------------------------------------------------

  it("does NOT emit any Inngest events for 'remove' action", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event: WebhookEvent = {
      action: "remove",
      type: "Issue",
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    };

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // "remove" returns early — no state block entered
    expect(inngest.send).not.toHaveBeenCalled();
    // DB should be untouched
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("running");
  });

  // ---------------------------------------------------------------------------
  // Missing state in event.data: NO Inngest events should fire
  // ---------------------------------------------------------------------------

  it("does NOT emit any Inngest events when event.data.state is missing", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event: WebhookEvent = {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Updated title",
        description: "desc",
        priority: 2,
        // no state field
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    };

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // event.data.state is undefined → if (event.data.state) block is not entered
    expect(inngest.send).not.toHaveBeenCalled();
    // DB should be untouched
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("running");
  });

  // ---------------------------------------------------------------------------
  // AC3: Conflict resolution logic preserved — cancellation resolves conflict
  // ---------------------------------------------------------------------------

  it("AC3: conflict resolution sets task to failed before upsert on cancel", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // Task should be failed after cancel
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("failed");
  });

  it("AC3: conflict resolution resets to ready when Linear moves task to Todo from running", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event = makeWebhookEvent(); // unstarted/Todo

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // Conflict resolution: running → Linear unstarted → reset to ready
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("ready");
  });

  // ---------------------------------------------------------------------------
  // No inngest provided: no crash, no events
  // ---------------------------------------------------------------------------

  it("does not crash and emits nothing when inngest is not provided", async () => {
    seedTask(db, "PROJ-1", "backlog");

    const event = makeWebhookEvent(); // unstarted → ready transition

    await expect(
      processWebhookEvent(
        db,
        makeClient() as any,
        makeGraph() as any,
        testConfig(),
        makeStateMap() as any,
        event,
        undefined,
        undefined, // no inngest
      ),
    ).resolves.toBeUndefined();

    // DB should still be updated
    expect(getTask(db, "PROJ-1")?.orcaStatus).toBe("ready");
  });

  // ---------------------------------------------------------------------------
  // inngest.send rejection is swallowed (fire-and-forget)
  // The process should not throw even if inngest.send rejects
  // ---------------------------------------------------------------------------

  it("does not throw when inngest.send rejects (fire-and-forget)", async () => {
    const inngest = makeInngest();
    inngest.send.mockRejectedValue(new Error("Inngest server unreachable"));

    seedTask(db, "PROJ-1", "backlog");

    const event = makeWebhookEvent(); // unstarted → triggers task/ready

    await expect(
      processWebhookEvent(
        db,
        makeClient() as any,
        makeGraph() as any,
        testConfig(),
        makeStateMap() as any,
        event,
        undefined,
        inngest as any,
      ),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // webhook.ts: inngest is passed through when provided in deps
  // This test is isolated in its own describe block below to avoid
  // vi.resetModules() polluting the module registry for subsequent tests.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Only one event per webhook call when transitioning to ready
  // (not task/ready AND task/cancelled simultaneously)
  // ---------------------------------------------------------------------------

  it("does not emit task/cancelled when transitioning from running to ready (non-cancel event)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "running");

    const event = makeWebhookEvent(); // unstarted/Todo

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // task/ready fires, but task/cancelled must NOT fire
    const calls = inngest.send.mock.calls;
    const cancelledCalls = calls.filter(
      (c: any[]) => c[0].name === "task/cancelled",
    );
    expect(cancelledCalls).toHaveLength(0);
  });

  it("does not emit task/ready when task is cancelled (cancel sets status to failed, not ready)", async () => {
    const inngest = makeInngest();
    seedTask(db, "PROJ-1", "backlog");

    const event = makeWebhookEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test Issue",
        description: "desc",
        priority: 2,
        state: { id: "s-canceled", name: "Canceled", type: "canceled" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: [],
      },
    });

    await processWebhookEvent(
      db,
      makeClient() as any,
      makeGraph() as any,
      testConfig(),
      makeStateMap() as any,
      event,
      undefined,
      inngest as any,
    );

    // Only task/cancelled fires; task/ready must NOT fire (finalTask.orcaStatus is "failed")
    const calls = inngest.send.mock.calls;
    const readyCalls = calls.filter((c: any[]) => c[0].name === "task/ready");
    expect(readyCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Isolated describe: webhook route passes inngest through to processWebhookEvent
// Uses vi.resetModules() — must be isolated to avoid contaminating module cache
// ---------------------------------------------------------------------------

describe("webhook route — inngest passthrough (isolated)", () => {
  it("passes inngest from deps to processWebhookEvent as the 8th argument", async () => {
    vi.resetModules();

    const syncMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/linear/sync.js", () => ({
      processWebhookEvent: syncMock,
    }));

    const { createWebhookRoute } = await import("../src/linear/webhook.js");
    const { createHmac } = await import("node:crypto");

    const secret = "test-secret-isolated";
    const inngest = makeInngest();
    const db = freshDb();
    const deps = {
      db,
      client: makeClient(),
      graph: makeGraph(),
      config: testConfig({ linearWebhookSecret: secret }),
      stateMap: makeStateMap(),
      inngest,
    };

    const app = createWebhookRoute(deps as any);

    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test",
        priority: 0,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: [],
      },
    });
    const sig = createHmac("sha256", secret).update(body).digest("hex");

    const req = new Request("http://localhost/api/webhooks/linear", {
      method: "POST",
      headers: { "linear-signature": sig, "content-type": "application/json" },
      body,
    });

    await app.request(req);

    expect(syncMock).toHaveBeenCalledOnce();
    const args = syncMock.mock.calls[0];
    // 8th argument (index 7) should be the inngest instance
    expect(args[7]).toBe(inngest);
  });
});
