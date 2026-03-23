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
vi.mock("../src/session-handles.js", () => ({
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

describe("fullSync — label filtering removed (all issues processed)", () => {
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

  test("all issues are upserted regardless of labels", async () => {
    const config = testConfig();

    const issue1 = makeIssue("PROJ-1", ["orca"]);
    const issue2 = makeIssue("PROJ-2", ["other-label"]);
    const issue3 = makeIssue("PROJ-3", []);

    const client = makeClient({
      fetchProjectIssues: vi
        .fn()
        .mockResolvedValue([issue1, issue2, issue3]),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
    );

    // All issues should be in DB (no label filtering)
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
    expect(getTask(db, "PROJ-3")).toBeDefined();

    // Graph should contain all issues
    expect(graph.rebuild).toHaveBeenCalledWith([issue1, issue2, issue3]);
  });

  test("issues with no labels are still processed", async () => {
    const config = testConfig();

    const issue1 = makeIssue("PROJ-1", []);
    const issue2 = makeIssue("PROJ-2", ["some-label"]);

    const client = makeClient({
      fetchProjectIssues: vi.fn().mockResolvedValue([issue1, issue2]),
    });

    const graph = makeGraph();

    await fullSync(
      db,
      client as any,
      graph as any,
      config,
    );

    // Both issues should be in DB
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
  });
});

// ===========================================================================
// processWebhookEvent with label filter
// ===========================================================================

describe("processWebhookEvent — label filtering removed (all events processed)", () => {
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

  test("webhook for unlabeled issue is always processed", async () => {
    const config = testConfig();

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    const event = makeEvent("PROJ-1", []);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
    );

    // Task should be created (no label filtering)
    expect(getTask(db, "PROJ-1")).toBeDefined();
  });

  test("webhook for labeled issue is always processed", async () => {
    const config = testConfig();

    const client = makeClient();
    const graph = makeGraph();
    const stateMap = new Map();

    const event = makeEvent("PROJ-2", ["label-id-123"]);

    await processWebhookEvent(
      db,
      client as any,
      graph as any,
      config,
      stateMap,
      event,
    );

    // Task should be created (no label filtering)
    expect(getTask(db, "PROJ-2")).toBeDefined();
  });
});
