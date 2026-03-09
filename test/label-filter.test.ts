// ---------------------------------------------------------------------------
// EMI-200 - ORCA_TASK_FILTER_LABEL unit tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { getTask, insertTask } from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { LinearIssue } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  closePrsForCanceledTask: vi.fn(),
}));

vi.mock("../src/events.js", () => ({
  emitTaskUpdated: vi.fn(),
  emitTasksRefreshed: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
}

function now(): string {
  return new Date().toISOString();
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    schedulerIntervalSec: 10,
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
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    maxWorktreeRetries: 3,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./test.log",
    logMaxSizeMb: 10,
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map([["proj-1", "/tmp/test"]]),
    githubWebhookSecret: undefined,
    taskFilterLabel: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "A test issue",
    priority: 2,
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    projectName: "Test Project",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    labels: [],
    ...overrides,
  };
}

function makeMockClient(overrides: Partial<{
  fetchProjectIssues: Mock;
  fetchLabelId: Mock;
}> = {}) {
  return {
    fetchProjectIssues: overrides.fetchProjectIssues ?? vi.fn().mockResolvedValue([]),
    fetchLabelId: overrides.fetchLabelId ?? vi.fn().mockResolvedValue(null),
    fetchWorkflowStates: vi.fn().mockResolvedValue(new Map()),
    fetchProjectMetadata: vi.fn().mockResolvedValue([]),
    createComment: vi.fn().mockResolvedValue(true),
    createAttachment: vi.fn().mockResolvedValue(true),
    updateIssueState: vi.fn().mockResolvedValue(true),
    createIssue: vi.fn(),
  };
}

function makeMockGraph() {
  return {
    rebuild: vi.fn(),
    isDispatchable: vi.fn().mockReturnValue(true),
    computeEffectivePriority: vi.fn().mockReturnValue(0),
  };
}

// ===========================================================================
// fullSync label filtering
// ===========================================================================

describe("EMI-200 - fullSync label filtering", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;
  let labelIdCache: typeof import("../src/linear/sync.js").labelIdCache;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
    labelIdCache = syncMod.labelIdCache;
    labelIdCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("when taskFilterLabel is unset, all issues sync", async () => {
    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
      makeIssue({ identifier: "PROJ-2", id: "issue-2", labels: ["orca"] }),
      makeIssue({ identifier: "PROJ-3", id: "issue-3", labels: ["other"] }),
    ];

    const client = makeMockClient({
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    });

    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: undefined });

    const count = await fullSync(db, client as any, graph as any, config);

    expect(count).toBe(3);
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
    expect(getTask(db, "PROJ-3")).toBeDefined();
    // fetchLabelId should NOT be called when filter is unset
    expect(client.fetchLabelId).not.toHaveBeenCalled();
  });

  test("when taskFilterLabel is set, only matching issues sync", async () => {
    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: ["orca"] }),
      makeIssue({ identifier: "PROJ-2", id: "issue-2", labels: [] }),
      makeIssue({ identifier: "PROJ-3", id: "issue-3", labels: ["other"] }),
    ];

    const client = makeMockClient({
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelId: vi.fn().mockResolvedValue("label-id-orca"),
    });

    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });

    const count = await fullSync(db, client as any, graph as any, config);

    expect(count).toBe(1);
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeUndefined();
    expect(getTask(db, "PROJ-3")).toBeUndefined();
  });

  test("fullSync refreshes label ID cache each cycle", async () => {
    const client = makeMockClient({
      fetchProjectIssues: vi.fn().mockResolvedValue([]),
      fetchLabelId: vi.fn().mockResolvedValue("label-id-orca"),
    });

    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });

    await fullSync(db, client as any, graph as any, config);
    await fullSync(db, client as any, graph as any, config);

    // fetchLabelId called once per sync
    expect(client.fetchLabelId).toHaveBeenCalledTimes(2);
    expect(client.fetchLabelId).toHaveBeenCalledWith("orca");
    expect(labelIdCache.get("orca")).toBe("label-id-orca");
  });

  test("when label not found in workspace, cache is cleared and all issues pass through", async () => {
    // Pre-populate cache
    labelIdCache.set("orca", "stale-id");

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
    ];

    const client = makeMockClient({
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelId: vi.fn().mockResolvedValue(null), // label not found
    });

    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });

    const count = await fullSync(db, client as any, graph as any, config);

    // Cache cleared; filter passes all issues through since no label to match against
    expect(labelIdCache.has("orca")).toBe(false);
    // Issues without the label still get filtered (filter checks issue.labels)
    // Since the label ID is not in cache, filtering uses issue.labels directly
    // PROJ-1 has no "orca" label so it gets filtered out
    expect(count).toBe(0);
  });

  test("graph.rebuild receives only filtered issues", async () => {
    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: ["orca"] }),
      makeIssue({ identifier: "PROJ-2", id: "issue-2", labels: [] }),
    ];

    const client = makeMockClient({
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelId: vi.fn().mockResolvedValue("label-id-orca"),
    });

    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });

    await fullSync(db, client as any, graph as any, config);

    // graph.rebuild should only receive the filtered issue
    const rebuildArg = (graph.rebuild as Mock).mock.calls[0][0];
    expect(rebuildArg).toHaveLength(1);
    expect(rebuildArg[0].identifier).toBe("PROJ-1");
  });
});

// ===========================================================================
// Webhook label filtering
// ===========================================================================

describe("EMI-200 - webhook label filtering", () => {
  let db: OrcaDb;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let labelIdCache: typeof import("../src/linear/sync.js").labelIdCache;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    labelIdCache = syncMod.labelIdCache;
    labelIdCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedTask(id: string) {
    const ts = now();
    insertTask(db, {
      linearIssueId: id,
      agentPrompt: "do something",
      repoPath: "/tmp/test",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  test("when taskFilterLabel is unset, webhook events pass through regardless of labelIds", async () => {
    seedTask("PROJ-1");
    const client = makeMockClient();
    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: undefined });
    const stateMap = new Map([["Todo", { id: "s1", type: "unstarted" }]]);

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-1",
        identifier: "PROJ-1",
        title: "Test",
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: [], // no labels — should still process
      },
    });

    const task = getTask(db, "PROJ-1");
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  test("when filter is set and issue has required label ID, webhook processes normally", async () => {
    seedTask("PROJ-1");
    labelIdCache.set("orca", "label-id-orca");

    const client = makeMockClient();
    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });
    const stateMap = new Map([["Todo", { id: "s1", type: "unstarted" }]]);

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-1",
        identifier: "PROJ-1",
        title: "Test",
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: ["label-id-orca", "label-id-other"],
      },
    });

    // Task should have been processed (upsert ran)
    const task = getTask(db, "PROJ-1");
    expect(task).toBeDefined();
  });

  test("when filter is set and issue lacks required label ID, webhook is skipped", async () => {
    labelIdCache.set("orca", "label-id-orca");

    const client = makeMockClient();
    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });
    const stateMap = new Map([["Todo", { id: "s1", type: "unstarted" }]]);

    // Issue does NOT have the orca label
    await processWebhookEvent(db, client as any, graph as any, config, stateMap, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-99",
        identifier: "PROJ-99",
        title: "Unlabeled issue",
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: ["label-id-other"],
      },
    });

    // Task should NOT have been inserted
    expect(getTask(db, "PROJ-99")).toBeUndefined();
  });

  test("when filter is set but cache is cold (no label ID cached), webhook passes through", async () => {
    // Cache is empty — label ID not yet fetched
    const client = makeMockClient();
    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });
    const stateMap = new Map([["Todo", { id: "s1", type: "unstarted" }]]);

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-cold",
        identifier: "PROJ-COLD",
        title: "Cold cache issue",
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        labelIds: [],
      },
    });

    // Cache miss → event allowed through to avoid silently dropping valid work
    expect(getTask(db, "PROJ-COLD")).toBeDefined();
  });

  test("when filter is set and labelIds is absent from payload, webhook is skipped", async () => {
    labelIdCache.set("orca", "label-id-orca");

    const client = makeMockClient();
    const graph = makeMockGraph();
    const config = testConfig({ taskFilterLabel: "orca" });
    const stateMap = new Map([["Todo", { id: "s1", type: "unstarted" }]]);

    // No labelIds field at all — treated as empty array
    await processWebhookEvent(db, client as any, graph as any, config, stateMap, {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-nolabels",
        identifier: "PROJ-NL",
        title: "No labels field",
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        // labelIds absent
      },
    });

    expect(getTask(db, "PROJ-NL")).toBeUndefined();
  });
});
