// ---------------------------------------------------------------------------
// EMI-200: ORCA_TASK_FILTER_LABEL feature tests
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import { getTask } from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";
import { fullSync, processWebhookEvent } from "../src/linear/sync.js";
import { DependencyGraph } from "../src/linear/graph.js";

// ---------------------------------------------------------------------------
// Mock scheduler + runner so sync module imports don't fail
// ---------------------------------------------------------------------------

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
    projectRepoMap: new Map(),
    concurrencyCap: 1,
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
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    taskFilterLabel: undefined,
    tunnelHostname: "test.example.com",
    githubWebhookSecret: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    ...overrides,
  } as OrcaConfig;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "",
    priority: 2,
    state: { id: "s1", name: "Todo", type: "unstarted" },
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

function makeWebhookEvent(dataOverrides: Record<string, unknown> = {}) {
  return {
    action: "update" as const,
    type: "Issue",
    data: {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Test issue",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      projectId: "proj-1",
      teamId: "team-1",
      labelIds: [] as string[],
      ...dataOverrides,
    },
  };
}

// ===========================================================================
// fullSync label filtering
// ===========================================================================

describe("fullSync — label filtering", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no filter label: all issues are upserted", async () => {
    const config = testConfig({ taskFilterLabel: undefined });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
      makeIssue({ id: "issue-2", identifier: "PROJ-2", labels: ["orca"] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn(),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
    // fetchLabelIdByName should NOT be called when no filter is set
    expect(client.fetchLabelIdByName).not.toHaveBeenCalled();
  });

  test("filter label set, issue has label: issue is upserted", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: ["orca"] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn().mockResolvedValue("label-id-orca"),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(labelIdCache.get("orca")).toBe("label-id-orca");
  });

  test("filter label set, issue lacks label: issue is NOT upserted", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn().mockResolvedValue("label-id-orca"),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    expect(getTask(db, "PROJ-1")).toBeUndefined();
  });

  test("filter label set, only matching issues pass through", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: ["orca"] }),
      makeIssue({ id: "issue-2", identifier: "PROJ-2", labels: [] }),
      makeIssue({ id: "issue-3", identifier: "PROJ-3", labels: ["other-label"] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn().mockResolvedValue("label-id-orca"),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeUndefined();
    expect(getTask(db, "PROJ-3")).toBeUndefined();
  });

  test("fail open: label not found in Linear, all issues pass through", async () => {
    const config = testConfig({ taskFilterLabel: "nonexistent-label" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
      makeIssue({ id: "issue-2", identifier: "PROJ-2", labels: ["some-label"] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      // Label not found: returns undefined
      fetchLabelIdByName: vi.fn().mockResolvedValue(undefined),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    // Fail open — both issues pass through
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
    // Cache stays empty
    expect(labelIdCache.size).toBe(0);
  });

  test("cache is cleared and refreshed on each fullSync call", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [makeIssue({ identifier: "PROJ-1", labels: ["orca"] })];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn()
        .mockResolvedValueOnce("label-id-v1")
        .mockResolvedValueOnce("label-id-v2"),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);
    expect(labelIdCache.get("orca")).toBe("label-id-v1");

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);
    expect(labelIdCache.get("orca")).toBe("label-id-v2");

    // fetchLabelIdByName called once per sync
    expect(client.fetchLabelIdByName).toHaveBeenCalledTimes(2);
  });

  test("no labelIdCache provided: filter label is ignored", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn(),
    };
    const graph = new DependencyGraph();

    // No labelIdCache passed (5th arg is stateMap=undefined, 6th is omitted)
    await fullSync(db, client as any, graph as any, config, undefined);

    // Without cache, filtering is skipped — issue is upserted
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(client.fetchLabelIdByName).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// processWebhookEvent label filtering
// ===========================================================================

describe("processWebhookEvent — label filtering", () => {
  let db: OrcaDb;
  const stateMap = new Map<string, { id: string; type: string }>();

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no filter label: webhook is processed regardless of labelIds", async () => {
    const config = testConfig({ taskFilterLabel: undefined });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    const event = makeWebhookEvent({ identifier: "PROJ-1", labelIds: [] });

    // Should not throw and should process the event (upsert into DB)
    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    // Task should exist in DB (upserted by webhook)
    expect(getTask(db, "PROJ-1")).toBeDefined();
  });

  test("filter set, cache populated, event has matching label ID: webhook processed", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const labelIdCache = new Map([["orca", "label-id-orca"]]);

    const event = makeWebhookEvent({ identifier: "PROJ-1", labelIds: ["label-id-orca"] });

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    expect(getTask(db, "PROJ-1")).toBeDefined();
  });

  test("filter set, cache populated, event lacks label ID: webhook skipped", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const labelIdCache = new Map([["orca", "label-id-orca"]]);

    const event = makeWebhookEvent({ identifier: "PROJ-99", labelIds: [] });

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    // Should be skipped — not upserted into DB
    expect(getTask(db, "PROJ-99")).toBeUndefined();
  });

  test("filter set, cache populated, event has different label IDs: webhook skipped", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const labelIdCache = new Map([["orca", "label-id-orca"]]);

    const event = makeWebhookEvent({ identifier: "PROJ-88", labelIds: ["label-id-other"] });

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    expect(getTask(db, "PROJ-88")).toBeUndefined();
  });

  test("fail open: filter set but cache empty — webhook passes through", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    // Cache is empty (label was not found in Linear)
    const labelIdCache = new Map<string, string>();

    const event = makeWebhookEvent({ identifier: "PROJ-77", labelIds: [] });

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    // Fail open — event processed
    expect(getTask(db, "PROJ-77")).toBeDefined();
  });

  test("no labelIdCache provided: filter label is ignored, webhook processed", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();

    const event = makeWebhookEvent({ identifier: "PROJ-66", labelIds: [] });

    // No labelIdCache argument
    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event);

    // Without cache, filtering skipped — event processed
    expect(getTask(db, "PROJ-66")).toBeDefined();
  });

  test("skipped webhook logs the expected message", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const config = testConfig({ taskFilterLabel: "orca" });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const labelIdCache = new Map([["orca", "label-id-orca"]]);

    const event = makeWebhookEvent({ identifier: "PROJ-55", labelIds: [] });

    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event, labelIdCache);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipping webhook for PROJ-55: missing label "orca"'),
    );
  });
});
