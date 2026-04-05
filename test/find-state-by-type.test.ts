// ---------------------------------------------------------------------------
// Tests for findStateByType (src/linear/sync.ts) and its integration in
// POST /api/tasks (src/api/routes.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { findStateByType } from "../src/linear/sync.js";
import { createApiRoutes } from "../src/api/routes.js";
import { createDb } from "../src/db/index.js";
import type { WorkflowStateMap } from "../src/linear/client.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { OrcaDb } from "../src/db/index.js";
import type { ProjectMetadata } from "../src/linear/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateMap(
  entries: Array<[string, { id: string; type: string }]>,
): WorkflowStateMap {
  return new Map(entries);
}

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
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
    linearApiKey: "test",
    linearWebhookSecret: "test",
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
// findStateByType — unit tests
// ---------------------------------------------------------------------------

describe("findStateByType", () => {
  it("returns undefined when no entry matches the type", () => {
    const stateMap = makeStateMap([
      ["Backlog", { id: "s1", type: "backlog" }],
      ["Todo", { id: "s2", type: "unstarted" }],
    ]);
    const result = findStateByType(stateMap, "completed");
    expect(result).toBeUndefined();
  });

  it("returns the matching entry for a single match", () => {
    const stateMap = makeStateMap([
      ["Backlog", { id: "s1", type: "backlog" }],
      ["Todo", { id: "s2", type: "unstarted" }],
    ]);
    const result = findStateByType(stateMap, "unstarted");
    expect(result).toEqual({ id: "s2", type: "unstarted", name: "Todo" });
  });

  it("returns the FIRST entry when multiple entries share the same type", () => {
    // Maps iterate in insertion order, so "Todo" should be returned before "Todo (sprint)"
    const stateMap = makeStateMap([
      ["Backlog", { id: "s0", type: "backlog" }],
      ["Todo", { id: "s1", type: "unstarted" }],
      ["Todo (sprint)", { id: "s2", type: "unstarted" }],
    ]);
    const result = findStateByType(stateMap, "unstarted");
    expect(result).toEqual({ id: "s1", type: "unstarted", name: "Todo" });
    // Must NOT return the second one
    expect(result?.id).not.toBe("s2");
  });

  it("does NOT perform case-insensitive matching — type is case-sensitive", () => {
    const stateMap = makeStateMap([["Backlog", { id: "s1", type: "Backlog" }]]);
    // Linear API returns lowercase types ("backlog", "unstarted", etc.)
    // The call site passes lowercase; this test documents the behavior.
    expect(findStateByType(stateMap, "backlog")).toBeUndefined();
    expect(findStateByType(stateMap, "Backlog")).toEqual({
      id: "s1",
      type: "Backlog",
      name: "Backlog",
    });
  });

  // ---------------------------------------------------------------------------
  // New tests for 3-step preference order
  // ---------------------------------------------------------------------------

  it("completed type prefers exact 'Done' match over 'Done Pending Deployment'", () => {
    const stateMap = makeStateMap([
      ["Done Pending Deployment", { id: "s1", type: "completed" }],
      ["Done", { id: "s2", type: "completed" }],
    ]);
    const result = findStateByType(stateMap, "completed");
    expect(result).toEqual({ id: "s2", type: "completed", name: "Done" });
  });

  it("matchReview=true prefers 'In Review' over 'In Progress' (both started)", () => {
    const stateMap = makeStateMap([
      ["In Progress", { id: "s1", type: "started" }],
      ["In Review", { id: "s2", type: "started" }],
    ]);
    const result = findStateByType(stateMap, "started", true);
    expect(result).toEqual({ id: "s2", type: "started", name: "In Review" });
  });

  it("matchReview=false prefers 'In Progress' over 'In Review' (both started)", () => {
    const stateMap = makeStateMap([
      ["In Review", { id: "s1", type: "started" }],
      ["In Progress", { id: "s2", type: "started" }],
    ]);
    const result = findStateByType(stateMap, "started", false);
    expect(result).toEqual({ id: "s2", type: "started", name: "In Progress" });
  });

  it("when no review-matching name exists, matchReview=true falls back to first started", () => {
    const stateMap = makeStateMap([
      ["In Progress", { id: "s1", type: "started" }],
      ["Working", { id: "s2", type: "started" }],
    ]);
    const result = findStateByType(stateMap, "started", true);
    expect(result).toEqual({ id: "s1", type: "started", name: "In Progress" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/tasks — integration tests for stateId resolution
// ---------------------------------------------------------------------------

describe("POST /api/tasks — stateId resolution via findStateByType", () => {
  let db: OrcaDb;
  let createIssueMock: ReturnType<typeof vi.fn>;
  let syncTasksMock: ReturnType<typeof vi.fn>;

  const projectMeta: ProjectMetadata[] = [
    { id: "proj-1", name: "Project One", description: "", teamIds: ["team-1"] },
  ];

  function makeApp(stateMap: WorkflowStateMap) {
    return createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: syncTasksMock,
      client: {
        createIssue: createIssueMock,
      } as any,
      stateMap,
      projectMeta,
    });
  }

  beforeEach(() => {
    db = createDb(":memory:");
    createIssueMock = vi
      .fn()
      .mockResolvedValue({ identifier: "PROJ-99", id: "issue-uuid" });
    syncTasksMock = vi.fn().mockResolvedValue(0);
  });

  it("passes stateId=undefined to createIssue when stateMap is empty and status is backlog", async () => {
    const app = makeApp(new Map());

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task", status: "backlog" }),
    });

    expect(res.status).toBe(200);
    expect(createIssueMock).toHaveBeenCalledOnce();
    const callArg = createIssueMock.mock.calls[0][0];
    // BUG PROBE: stateId should be undefined — createIssue receives it anyway.
    // If Linear rejects undefined stateId, this path silently creates issues in
    // an unexpected default state.
    expect(callArg.stateId).toBeUndefined();
  });

  it("passes correct stateId when backlog type is present in stateMap", async () => {
    const stateMap = makeStateMap([
      ["Backlog", { id: "state-backlog-id", type: "backlog" }],
      ["Todo", { id: "state-todo-id", type: "unstarted" }],
    ]);
    const app = makeApp(stateMap);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task", status: "backlog" }),
    });

    expect(res.status).toBe(200);
    const callArg = createIssueMock.mock.calls[0][0];
    expect(callArg.stateId).toBe("state-backlog-id");
  });

  it("passes correct stateId when unstarted type is present in stateMap (default/todo path)", async () => {
    const stateMap = makeStateMap([
      ["Backlog", { id: "state-backlog-id", type: "backlog" }],
      ["Todo", { id: "state-todo-id", type: "unstarted" }],
    ]);
    const app = makeApp(stateMap);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task", status: "todo" }),
    });

    expect(res.status).toBe(200);
    const callArg = createIssueMock.mock.calls[0][0];
    expect(callArg.stateId).toBe("state-todo-id");
  });

  it("selects first 'unstarted' state when multiple exist (insertion order)", async () => {
    const stateMap = makeStateMap([
      ["Todo", { id: "first-unstarted", type: "unstarted" }],
      ["Todo (Sprint)", { id: "second-unstarted", type: "unstarted" }],
    ]);
    const app = makeApp(stateMap);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task" }),
    });

    expect(res.status).toBe(200);
    const callArg = createIssueMock.mock.calls[0][0];
    expect(callArg.stateId).toBe("first-unstarted");
  });

  it("returns 400 if status is an unexpected value (not 'todo' or 'backlog')", async () => {
    const app = makeApp(new Map());

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task", status: "running" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status/);
  });

  it("returns 400 for missing title", async () => {
    const app = makeApp(new Map());

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no title here" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when project not found in projectMeta", async () => {
    const app = makeApp(new Map());

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test task",
        projectId: "nonexistent-project",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/project/i);
  });

  it("returns 500 when createIssue throws", async () => {
    createIssueMock.mockRejectedValue(new Error("Linear API error"));
    const stateMap = makeStateMap([["Todo", { id: "s1", type: "unstarted" }]]);
    const app = makeApp(stateMap);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test task" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Linear API error");
  });
});
