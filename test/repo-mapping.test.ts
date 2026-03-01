// ---------------------------------------------------------------------------
// Per-project repo mapping tests
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
import { parseRepoPath } from "../src/config/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import { fullSync } from "../src/linear/sync.js";
import { DependencyGraph } from "../src/linear/graph.js";

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
    projectNameMap: new Map(),
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
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    ...overrides,
  };
}

// ===========================================================================
// parseRepoPath
// ===========================================================================

describe("parseRepoPath", () => {
  test("extracts repo path from description", () => {
    const desc =
      "repo: C:\\Users\\emily\\Documents\\Github\\orca\n\nSome other text.";
    expect(parseRepoPath(desc)).toBe(
      "C:\\Users\\emily\\Documents\\Github\\orca",
    );
  });

  test("extracts repo path with extra whitespace", () => {
    expect(parseRepoPath("repo:   /home/user/project  ")).toBe(
      "/home/user/project",
    );
  });

  test("extracts repo path from middle of description", () => {
    const desc = "This project does stuff.\nrepo: /opt/myrepo\nMore text.";
    expect(parseRepoPath(desc)).toBe("/opt/myrepo");
  });

  test("case insensitive match", () => {
    expect(parseRepoPath("Repo: /tmp/test")).toBe("/tmp/test");
    expect(parseRepoPath("REPO: /tmp/test")).toBe("/tmp/test");
  });

  test("returns undefined when no repo line", () => {
    expect(parseRepoPath("Just a regular description.")).toBeUndefined();
  });

  test("returns undefined for empty description", () => {
    expect(parseRepoPath("")).toBeUndefined();
  });

  test("returns undefined for repo: with no path", () => {
    expect(parseRepoPath("repo:   ")).toBeUndefined();
  });

  test("first repo: line wins", () => {
    const desc = "repo: /first\nrepo: /second";
    expect(parseRepoPath(desc)).toBe("/first");
  });
});

// ===========================================================================
// Repo path resolution in upsertTask (via fullSync)
// ===========================================================================

// Mock scheduler + runner so resolveConflict imports don't fail
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

describe("Repo path resolution in upsertTask", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeMockClient(issues: any[]) {
    return {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    } as any;
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
      ...overrides,
    };
  }

  test("uses projectRepoMap when project ID matches", async () => {
    const config = testConfig({
      defaultCwd: "/fallback",
      projectRepoMap: new Map([["proj-1", "/mapped/repo"]]),
    });
    const client = makeMockClient([makeIssue({ projectId: "proj-1" })]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "PROJ-1");
    expect(task).toBeDefined();
    expect(task!.repoPath).toBe("/mapped/repo");
  });

  test("falls back to defaultCwd when project not in map", async () => {
    const config = testConfig({
      defaultCwd: "/fallback",
      projectRepoMap: new Map([["other-proj", "/other/repo"]]),
    });
    const client = makeMockClient([makeIssue({ projectId: "proj-1" })]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "PROJ-1");
    expect(task).toBeDefined();
    expect(task!.repoPath).toBe("/fallback");
  });

  test("skips issue when no map entry and no defaultCwd", async () => {
    const config = testConfig({
      defaultCwd: undefined,
      projectRepoMap: new Map(),
    });
    const client = makeMockClient([makeIssue({ projectId: "proj-1" })]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "PROJ-1");
    expect(task).toBeUndefined();
  });

  test("updates repoPath on existing task during re-sync", async () => {
    const config = testConfig({
      defaultCwd: "/old-path",
      projectRepoMap: new Map(),
    });
    const client = makeMockClient([makeIssue({ projectId: "proj-1" })]);
    const graph = new DependencyGraph();

    // First sync: task gets /old-path
    await fullSync(db, client, graph, config);
    expect(getTask(db, "PROJ-1")!.repoPath).toBe("/old-path");

    // Update map, re-sync: task should get new path
    config.projectRepoMap.set("proj-1", "/new-path");
    await fullSync(db, client, graph, config);
    expect(getTask(db, "PROJ-1")!.repoPath).toBe("/new-path");
  });
});
