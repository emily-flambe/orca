// ---------------------------------------------------------------------------
// Label filter tests — ORCA_TASK_FILTER_LABEL feature
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
import { getTask } from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { LinearIssue } from "../src/linear/client.js";

// Mock scheduler + runner so sync imports don't fail
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): OrcaDb {
  return createDb(":memory:");
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
  };
}

function makeIssue(
  id: string,
  labels: string[] = [],
  overrides: Partial<LinearIssue> = {},
): LinearIssue {
  return {
    id,
    identifier: id,
    title: `Issue ${id}`,
    description: "desc",
    priority: 0,
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    teamId: "team-1",
    projectId: "proj-1",
    relations: [],
    inverseRelations: [],
    parentId: null,
    parentTitle: null,
    parentDescription: null,
    childIds: [],
    projectName: "Test Project",
    labels,
    ...overrides,
  };
}

// Minimal DependencyGraph mock
function makeGraph() {
  return { rebuild: vi.fn() };
}

// Minimal LinearClient mock
function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    fetchProjectIssues: vi.fn(),
    fetchLabelIdByName: vi.fn(),
    updateIssueState: vi.fn(),
    ...overrides,
  };
}

// ===========================================================================
// fullSync with label filter
// ===========================================================================

describe("fullSync — label filter active", () => {
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

  test("only issues matching the label are upserted", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const labelIdCache = new Map<string, string>();

    const matchingIssue = makeIssue("PROJ-1", ["orca"]);
    const unmatchedIssue = makeIssue("PROJ-2", ["other-label"]);
    const noLabelIssue = makeIssue("PROJ-3", []);

    const client = makeClient({
      fetchProjectIssues: vi
        .fn()
        .mockResolvedValue([matchingIssue, unmatchedIssue, noLabelIssue]),
      fetchLabelIdByName: vi.fn().mockResolvedValue("label-id-123"),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
      undefined,
      labelIdCache,
    );

    // Only matching issue should be in DB
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeUndefined();
    expect(getTask(db, "PROJ-3")).toBeUndefined();

    // Label cache should be populated
    expect(labelIdCache.get("orca")).toBe("label-id-123");

    // Graph should only contain filtered issues
    expect(graph.rebuild).toHaveBeenCalledWith([matchingIssue]);
  });

  test("all issues upserted when no filter configured", async () => {
    const config = testConfig({ taskFilterLabel: undefined });
    const labelIdCache = new Map<string, string>();

    const issue1 = makeIssue("PROJ-1", []);
    const issue2 = makeIssue("PROJ-2", ["some-label"]);

    const client = makeClient({
      fetchProjectIssues: vi.fn().mockResolvedValue([issue1, issue2]),
      fetchLabelIdByName: vi.fn().mockResolvedValue(undefined),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
      undefined,
      labelIdCache,
    );

    // Both issues should be in DB
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();

    // fetchLabelIdByName should NOT be called when no filter
    expect(client.fetchLabelIdByName).not.toHaveBeenCalled();
  });

  test("all issues pass through when label not found in Linear", async () => {
    const config = testConfig({ taskFilterLabel: "nonexistent-label" });
    const labelIdCache = new Map<string, string>();

    const issue1 = makeIssue("PROJ-1", []);
    const issue2 = makeIssue("PROJ-2", ["some-label"]);

    const client = makeClient({
      fetchProjectIssues: vi.fn().mockResolvedValue([issue1, issue2]),
      // Label not found in Linear → returns undefined
      fetchLabelIdByName: vi.fn().mockResolvedValue(undefined),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
      undefined,
      labelIdCache,
    );

    // Label cache should be empty (label not found)
    expect(labelIdCache.size).toBe(0);

    // Fail open: when the label doesn't exist in Linear, all issues pass through.
    // This matches webhook behavior (also fails open when cache is empty) and
    // prevents silently dropping everything on a misconfigured label name.
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
  });

  test("label cache is refreshed on each fullSync call", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const labelIdCache = new Map<string, string>([["old-label", "old-id"]]);

    const client = makeClient({
      fetchProjectIssues: vi
        .fn()
        .mockResolvedValue([makeIssue("PROJ-1", ["orca"])]),
      fetchLabelIdByName: vi.fn().mockResolvedValue("new-label-id"),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
      undefined,
      labelIdCache,
    );

    // Old entry should be gone, new one set
    expect(labelIdCache.has("old-label")).toBe(false);
    expect(labelIdCache.get("orca")).toBe("new-label-id");
  });
});

// ===========================================================================
// processWebhookEvent with label filter
// ===========================================================================

describe("processWebhookEvent — label filter", () => {
  let db: OrcaDb;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;

  beforeEach(async () => {
    db = freshDb();
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    syncMod.clearStartupGrace();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEvent(identifier: string, labelIds: string[] = []) {
    return {
      action: "update" as const,
      type: "Issue",
      data: {
        id: `issue-${identifier}`,
        identifier,
        title: `Issue ${identifier}`,
        priority: 0,
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "proj-1",
        labelIds,
      },
    };
  }

  test("webhook for unlabeled issue is skipped when filter active", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    // Cache populated — label found in Linear
    const labelIdCache = new Map([["orca", "label-id-123"]]);

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    // Event with no labelIds — should be skipped
    const event = makeEvent("PROJ-1", []);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
      labelIdCache,
    );

    // Task should NOT be created (webhook was skipped)
    expect(getTask(db, "PROJ-1")).toBeUndefined();
  });

  test("webhook passes through when issue has the required label", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const labelIdCache = new Map([["orca", "label-id-123"]]);

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    // Event WITH the required label ID
    const event = makeEvent("PROJ-2", ["label-id-123"]);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
      labelIdCache,
    );

    // Task should be created (webhook was processed)
    expect(getTask(db, "PROJ-2")).toBeDefined();
  });

  test("webhook passes through when no filter configured", async () => {
    const config = testConfig({ taskFilterLabel: undefined });
    const labelIdCache = new Map<string, string>();

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    const event = makeEvent("PROJ-3", []);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
      labelIdCache,
    );

    // Task should be created — no filter active
    expect(getTask(db, "PROJ-3")).toBeDefined();
  });

  test("webhook passes through when labelIdCache is empty (fail open)", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    // Empty cache means label was not found in Linear — fail open
    const labelIdCache = new Map<string, string>();

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    const event = makeEvent("PROJ-4", []);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
      labelIdCache,
    );

    // Task should be created — fail open when cache is empty
    expect(getTask(db, "PROJ-4")).toBeDefined();
  });

  test("webhook passes through when labelIdCache not provided", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    const event = makeEvent("PROJ-5", []);

    // No labelIdCache passed at all
    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
      // labelIdCache omitted
    );

    // Task should be created — no cache means filter is skipped
    expect(getTask(db, "PROJ-5")).toBeDefined();
  });
});
