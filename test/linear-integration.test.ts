// ---------------------------------------------------------------------------
// Phase 2 Linear Integration tests (tasks 10.1 - 10.6)
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
import { createHmac } from "node:crypto";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  getTask,
  updateTaskStatus,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

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
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: "ready" | "dispatched" | "running" | "done" | "failed";
    priority: number;
    retryCount: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: overrides.orcaStatus ?? "ready",
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

/** Minimal OrcaConfig for testing. */
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
    appendSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

// ===========================================================================
// 10.1 Linear client with mock GraphQL responses
// ===========================================================================

describe("10.1 - LinearClient with mock GraphQL responses", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    // Suppress console.log noise from the client
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // We import LinearClient dynamically to ensure the mock fetch is in place.
  async function getClient() {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient("test-key");
  }

  test("fetchProjectIssues paginates and flattens relations", async () => {
    const client = await getClient();

    // Page 1: hasNextPage=true, endCursor="cursor1"
    const page1Response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: true, endCursor: "cursor1" },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "First issue",
              priority: 2,
              state: { id: "state-1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1" },
              relations: {
                nodes: [
                  {
                    type: "blocks",
                    relatedIssue: { id: "issue-2", identifier: "PROJ-2" },
                  },
                ],
              },
              inverseRelations: { nodes: [] },
            },
          ],
        },
      },
    };

    // Page 2: hasNextPage=false
    const page2Response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-2",
              identifier: "PROJ-2",
              title: "Second issue",
              priority: 1,
              state: { id: "state-2", name: "In Progress", type: "started" },
              team: { id: "team-1" },
              project: { id: "proj-1" },
              relations: { nodes: [] },
              inverseRelations: {
                nodes: [
                  {
                    type: "blocks",
                    issue: { id: "issue-1", identifier: "PROJ-1" },
                  },
                ],
              },
            },
          ],
        },
      },
    };

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page1Response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page2Response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const issues = await client.fetchProjectIssues(["proj-1"]);

    // Should have fetched two pages
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(2);

    // Verify first issue
    expect(issues[0]!.id).toBe("issue-1");
    expect(issues[0]!.identifier).toBe("PROJ-1");
    expect(issues[0]!.relations).toHaveLength(1);
    expect(issues[0]!.relations[0]!.type).toBe("blocks");
    expect(issues[0]!.relations[0]!.issueId).toBe("issue-2");

    // Verify second issue
    expect(issues[1]!.id).toBe("issue-2");
    expect(issues[1]!.inverseRelations).toHaveLength(1);
    expect(issues[1]!.inverseRelations[0]!.issueId).toBe("issue-1");
  });

  test("fetchWorkflowStates returns a Map from state type to state ID", async () => {
    const client = await getClient();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "ws-1", name: "Todo", type: "unstarted" },
                  { id: "ws-2", name: "In Progress", type: "started" },
                  { id: "ws-3", name: "Done", type: "completed" },
                  { id: "ws-4", name: "Canceled", type: "canceled" },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const stateMap = await client.fetchWorkflowStates(["team-1"]);

    expect(stateMap).toBeInstanceOf(Map);
    expect(stateMap.get("Todo")).toEqual({ id: "ws-1", type: "unstarted" });
    expect(stateMap.get("In Progress")).toEqual({ id: "ws-2", type: "started" });
    expect(stateMap.get("Done")).toEqual({ id: "ws-3", type: "completed" });
    expect(stateMap.get("Canceled")).toEqual({ id: "ws-4", type: "canceled" });
    expect(stateMap.size).toBe(4);
  });

  test("updateIssueState returns true on success", async () => {
    const client = await getClient();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { issueUpdate: { success: true } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await client.updateIssueState("issue-1", "state-2");
    expect(result).toBe(true);
  });

  test("auth error (401) throws without retrying", async () => {
    const client = await getClient();

    mockFetch.mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      client.fetchProjectIssues(["proj-1"]),
    ).rejects.toThrow(/authentication failed/);

    // Should NOT retry on 401
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("rate limit warning when remaining requests are low", async () => {
    const client = await getClient();
    const consoleSpy = vi.spyOn(console, "log");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { issueUpdate: { success: true } },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Requests-Remaining": "100",
          },
        },
      ),
    );

    await client.updateIssueState("issue-1", "state-1");

    // 100 < 500 (RATE_LIMIT_WARN_THRESHOLD), so should warn
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("rate limit low"),
    );
  });
});

// ===========================================================================
// 10.2 Dependency graph
// ===========================================================================

describe("10.2 - DependencyGraph", () => {
  // Import synchronously since it has no side effects requiring mocking
  let DependencyGraph: typeof import("../src/linear/graph.js").DependencyGraph;

  beforeEach(async () => {
    const mod = await import("../src/linear/graph.js");
    DependencyGraph = mod.DependencyGraph;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeIssue(
    id: string,
    relations: { type: string; issueId: string; issueIdentifier: string }[] = [],
    inverseRelations: { type: string; issueId: string; issueIdentifier: string }[] = [],
  ) {
    return {
      id,
      identifier: id,
      title: `Issue ${id}`,
      priority: 0,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      projectId: "proj-1",
      relations,
      inverseRelations,
    };
  }

  test("rebuild populates blockedBy and blocks maps from relations", () => {
    const graph = new DependencyGraph();

    // A blocks B (via A's relations)
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    // B has no relations of its own
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    // B is blocked by A, so it is not dispatchable when A is not done
    const getStatus = (id: string) => (id === "A" ? "running" : "ready");
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
    // A has no blockers, so it is dispatchable
    expect(graph.isDispatchable("A", getStatus)).toBe(true);
  });

  test("rebuild handles inverseRelations", () => {
    const graph = new DependencyGraph();

    // B is blocked by A (via B's inverseRelations)
    const issueA = makeIssue("A");
    const issueB = makeIssue("B", [], [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    // B should be blocked by A
    const getStatus = (id: string) => (id === "A" ? "running" : "ready");
    expect(graph.isDispatchable("B", getStatus)).toBe(false);
  });

  test("isDispatchable: no blockers returns true", () => {
    const graph = new DependencyGraph();
    graph.rebuild([makeIssue("A")]);

    expect(graph.isDispatchable("A", () => "ready")).toBe(true);
  });

  test("isDispatchable: all blockers done returns true", () => {
    const graph = new DependencyGraph();
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    graph.rebuild([issueA, makeIssue("B")]);

    // B is blocked by A, A is done
    expect(graph.isDispatchable("B", () => "done")).toBe(true);
  });

  test("isDispatchable: blocker running returns false", () => {
    const graph = new DependencyGraph();
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    graph.rebuild([issueA, makeIssue("B")]);

    // B is blocked by A, A is running
    expect(graph.isDispatchable("B", (id) => (id === "A" ? "running" : "ready"))).toBe(false);
  });

  test("computeEffectivePriority: inherits urgent priority from blocked chain", () => {
    const graph = new DependencyGraph();

    // A blocks B, B blocks C
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "C", issueIdentifier: "C" },
    ]);
    const issueC = makeIssue("C");

    graph.rebuild([issueA, issueB, issueC]);

    // Priorities: A=4 (low), B=3 (medium), C=1 (urgent)
    const priorities: Record<string, number> = { A: 4, B: 3, C: 1 };
    const getPriority = (id: string) => priorities[id] ?? 0;

    // A's effective priority should be 1 (inherited from C via the chain)
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(1);
  });

  test("computeEffectivePriority: priority 0 does not inherit", () => {
    const graph = new DependencyGraph();

    // A blocks B
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B");

    graph.rebuild([issueA, issueB]);

    // A has priority 3, B has priority 0 (no priority)
    const priorities: Record<string, number> = { A: 3, B: 0 };
    const getPriority = (id: string) => priorities[id] ?? 0;

    // A's effective priority should stay 3 (B's 0 should not override)
    expect(graph.computeEffectivePriority("A", getPriority)).toBe(3);
  });

  test("cycle detection: does not infinite loop, logs warning", () => {
    const graph = new DependencyGraph();
    const consoleSpy = vi.spyOn(console, "log");

    // A blocks B, B blocks A (cycle)
    const issueA = makeIssue("A", [
      { type: "blocks", issueId: "B", issueIdentifier: "B" },
    ]);
    const issueB = makeIssue("B", [
      { type: "blocks", issueId: "A", issueIdentifier: "A" },
    ]);

    graph.rebuild([issueA, issueB]);

    // Should not hang -- compute priority for A
    const priorities: Record<string, number> = { A: 3, B: 2 };
    const getPriority = (id: string) => priorities[id] ?? 0;
    const result = graph.computeEffectivePriority("A", getPriority);

    // Result should be valid (2, from B, since A blocks B and B has priority 2)
    expect(typeof result).toBe("number");
    expect(result).toBe(2);

    // Should have logged a cycle warning
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("cycle detected"),
    );
  });

  test("addRelation / removeRelation: incremental updates", () => {
    const graph = new DependencyGraph();
    graph.rebuild([makeIssue("A"), makeIssue("B")]);

    // Initially B is dispatchable
    expect(graph.isDispatchable("B", () => "ready")).toBe(true);

    // Add: A blocks B
    graph.addRelation("A", "B");
    expect(graph.isDispatchable("B", (id) => (id === "A" ? "ready" : "ready"))).toBe(false);

    // Remove: A no longer blocks B
    graph.removeRelation("A", "B");
    expect(graph.isDispatchable("B", () => "ready")).toBe(true);
  });
});

// ===========================================================================
// 10.3 Conflict resolution
// ===========================================================================

// Mock the scheduler and runner modules that resolveConflict imports
vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));

vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

describe("10.3 - Conflict resolution", () => {
  let db: OrcaDb;
  let config: OrcaConfig;
  let resolveConflict: typeof import("../src/linear/sync.js").resolveConflict;

  beforeEach(async () => {
    db = freshDb();
    config = testConfig();
    // Dynamically import so mocks are in place
    const syncMod = await import("../src/linear/sync.js");
    resolveConflict = syncMod.resolveConflict;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("running task, Linear says Todo -> task becomes ready", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CONFLICT-1",
      orcaStatus: "running",
    });

    resolveConflict(db, taskId, "Todo", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  test("ready task, Linear says Done -> task becomes done", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CONFLICT-2",
      orcaStatus: "ready",
    });

    resolveConflict(db, taskId, "Done", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("done");
  });

  test("done task, Linear says Todo -> task becomes ready", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CONFLICT-3",
      orcaStatus: "done",
    });

    resolveConflict(db, taskId, "Todo", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });

  test("any task, Linear says Canceled -> task becomes failed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CONFLICT-4",
      orcaStatus: "running",
    });

    resolveConflict(db, taskId, "Canceled", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("failed");
  });

  test("no conflict when states match -> no change", () => {
    const taskId = seedTask(db, {
      linearIssueId: "CONFLICT-5",
      orcaStatus: "ready",
    });

    // Linear says "Todo" which maps to "ready" -- no conflict
    resolveConflict(db, taskId, "Todo", config);

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.orcaStatus).toBe("ready");
  });
});

// ===========================================================================
// 10.4 Write-back loop prevention
// ===========================================================================

describe("10.4 - Write-back loop prevention", () => {
  let registerExpectedChange: typeof import("../src/linear/sync.js").registerExpectedChange;
  let isExpectedChange: typeof import("../src/linear/sync.js").isExpectedChange;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    const syncMod = await import("../src/linear/sync.js");
    registerExpectedChange = syncMod.registerExpectedChange;
    isExpectedChange = syncMod.isExpectedChange;
    expectedChanges = syncMod.expectedChanges;
    // Clear any leftover entries from other tests
    expectedChanges.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("register and check immediately -> returns true (consumed)", () => {
    registerExpectedChange("TASK-1", "In Progress");
    expect(isExpectedChange("TASK-1", "In Progress")).toBe(true);
  });

  test("check again after consumption -> returns false", () => {
    registerExpectedChange("TASK-2", "In Progress");
    // First check consumes
    isExpectedChange("TASK-2", "In Progress");
    // Second check should be false
    expect(isExpectedChange("TASK-2", "In Progress")).toBe(false);
  });

  test("expired entry (>10s) -> returns false", () => {
    vi.useFakeTimers();

    registerExpectedChange("TASK-3", "In Review");

    // Advance time past the 10s expiry
    vi.advanceTimersByTime(11_000);

    expect(isExpectedChange("TASK-3", "In Review")).toBe(false);

    vi.useRealTimers();
  });

  test("different stateName than registered -> returns false", () => {
    registerExpectedChange("TASK-4", "In Progress");
    expect(isExpectedChange("TASK-4", "In Review")).toBe(false);
  });
});

// ===========================================================================
// 10.5 Webhook HMAC verification
// ===========================================================================

describe("10.5 - Webhook HMAC verification", () => {
  // Mock processWebhookEvent to avoid needing real DB/scheduler deps in webhook route
  vi.mock("../src/linear/sync.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/linear/sync.js")>();
    return {
      ...actual,
      processWebhookEvent: vi.fn().mockResolvedValue(undefined),
    };
  });

  let createWebhookRoute: typeof import("../src/linear/webhook.js").createWebhookRoute;
  let app: ReturnType<typeof createWebhookRoute>;
  const secret = "test-webhook-secret-hmac";

  beforeEach(async () => {
    const webhookMod = await import("../src/linear/webhook.js");
    createWebhookRoute = webhookMod.createWebhookRoute;

    const config = testConfig({ linearWebhookSecret: secret });

    app = createWebhookRoute({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config,
      stateMap: new Map(),
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function computeSignature(body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  test("valid signature returns 200", async () => {
    const payload = {
      action: "update",
      type: "Issue",
      data: {
        id: "issue-1",
        identifier: "PROJ-1",
        title: "Test",
        priority: 1,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
      },
    };
    const body = JSON.stringify(payload);
    const sig = computeSignature(body);

    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  test("invalid signature returns 401", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {} });

    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "deadbeef",
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  test("missing signature header returns 401", async () => {
    const body = JSON.stringify({ action: "update", type: "Issue", data: {} });

    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// 10.6 Polling fallback
// ===========================================================================

describe("10.6 - Polling fallback", () => {
  // We need to mock fullSync to track calls without actually running it
  vi.mock("../src/linear/sync.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/linear/sync.js")>();
    return {
      ...actual,
      fullSync: vi.fn().mockResolvedValue({ total: 0, succeeded: 0, failed: 0, errors: [] }),
      processWebhookEvent: vi.fn().mockResolvedValue(undefined),
    };
  });

  let createPoller: typeof import("../src/linear/poller.js").createPoller;
  let fullSyncMock: Mock;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Eliminate jitter for deterministic timer assertions (2*0.5-1 = 0)
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const pollerMod = await import("../src/linear/poller.js");
    createPoller = pollerMod.createPoller;

    const syncMod = await import("../src/linear/sync.js");
    fullSyncMock = syncMod.fullSync as unknown as Mock;
    fullSyncMock.mockClear();

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("tunnel connected -> poller does NOT call fullSync", async () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => true,
    });

    poller.start();

    // Advance past one poll interval (30s)
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fullSyncMock).not.toHaveBeenCalled();

    poller.stop();
  });

  test("tunnel disconnected -> poller calls fullSync", async () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // Advance past one poll interval (30s)
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fullSyncMock).toHaveBeenCalled();

    poller.stop();
  });

  test("tunnel flips from down to up -> logs 'tunnel recovered'", async () => {
    let tunnelUp = false;

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => tunnelUp,
    });

    poller.start();

    // First tick: tunnel is down -> polls
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    // Flip tunnel to up
    tunnelUp = true;

    // Second tick: tunnel is up -> should log recovery
    await vi.advanceTimersByTimeAsync(30_000);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("tunnel recovered"),
    );

    // fullSync should not have been called again
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("repeated failures trigger exponential backoff", async () => {
    fullSyncMock.mockRejectedValue(new Error("API down"));

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // First tick fires at 30s (normal interval)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);
    expect(poller.health().consecutiveFailures).toBe(1);

    // After 1 failure, next interval = 30s * 2^0 = 30s
    expect(poller.health().currentIntervalMs).toBe(30_000);

    // Second tick fires at +30s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(2);
    expect(poller.health().consecutiveFailures).toBe(2);

    // After 2 failures, next interval = 30s * 2^1 = 60s
    expect(poller.health().currentIntervalMs).toBe(60_000);

    // Third tick needs 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(3);
    expect(poller.health().consecutiveFailures).toBe(3);

    // After 3 failures, next interval = 30s * 2^2 = 120s
    expect(poller.health().currentIntervalMs).toBe(120_000);

    poller.stop();
  });

  test("backoff resets after successful poll", async () => {
    let shouldFail = true;
    fullSyncMock.mockImplementation(() => {
      if (shouldFail) throw new Error("API down");
      return Promise.resolve({ total: 5, succeeded: 5, failed: 0, errors: [] });
    });

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // Fail twice: 30s, then 30s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poller.health().consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poller.health().consecutiveFailures).toBe(2);
    expect(poller.health().currentIntervalMs).toBe(60_000);

    // Now succeed
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller.health().consecutiveFailures).toBe(0);
    expect(poller.health().currentIntervalMs).toBe(30_000);
    expect(poller.health().lastSuccessAt).not.toBeNull();

    // Logs recovery message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("recovered after 2 consecutive failure(s)"),
    );

    poller.stop();
  });

  test("backoff caps at MAX_BACKOFF_MS (5 minutes)", async () => {
    const { computeBackoffMs, MAX_BACKOFF_MS } = await import(
      "../src/linear/poller.js"
    );

    // At 10 failures: 30s * 2^9 = 15360s — must cap at 300s
    expect(computeBackoffMs(10)).toBe(MAX_BACKOFF_MS);
    expect(computeBackoffMs(20)).toBe(MAX_BACKOFF_MS);
    // Zero failures returns base interval
    expect(computeBackoffMs(0)).toBe(30_000);
  });

  test("health() exposes last error message", async () => {
    fullSyncMock.mockRejectedValue(new Error("rate limited"));

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();
    expect(poller.health().lastError).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(poller.health().lastError).toContain("rate limited");

    poller.stop();
  });

  test("stop() during backoff prevents further ticks", async () => {
    fullSyncMock.mockRejectedValue(new Error("fail"));

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // One failure
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    // Stop during backoff
    poller.stop();

    // Advance well past any backoff period
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1); // No more calls
  });

  test("permanent error (auth failure) stops the poller", async () => {
    fullSyncMock.mockRejectedValue(
      new Error("LinearClient: authentication failed (HTTP 401). Check that ORCA_LINEAR_API_KEY is valid."),
    );

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // First tick: permanent error → poller stops itself
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);
    expect(poller.health().consecutiveFailures).toBe(1);
    expect(poller.health().lastErrorCategory).toBe("permanent");
    expect(poller.health().stopped).toBe(true);

    // Advance well past any backoff — no more ticks because stopped
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  test("partial sync failure increments backoff but tracks last success", async () => {
    fullSyncMock.mockResolvedValue({
      total: 10,
      succeeded: 8,
      failed: 2,
      errors: [
        { issueId: "PROJ-1", error: "db constraint" },
        { issueId: "PROJ-2", error: "invalid state" },
      ],
    });

    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fullSyncMock).toHaveBeenCalledTimes(1);

    const health = poller.health();
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain("2/10 issues failed");
    expect(health.lastErrorCategory).toBe("transient");
    // Partial success still updates lastSuccessAt
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastSyncResult?.failed).toBe(2);
    expect(health.lastSyncResult?.succeeded).toBe(8);

    poller.stop();
  });

  test("health() exposes lastErrorCategory and stopped state", async () => {
    const poller = createPoller({
      db: {} as OrcaDb,
      client: {} as any,
      graph: {} as any,
      config: testConfig(),
      isTunnelConnected: () => false,
    });

    poller.start();

    // Initial health: no errors, not stopped
    const initial = poller.health();
    expect(initial.lastErrorCategory).toBeNull();
    expect(initial.stopped).toBe(false);
    expect(initial.lastSyncResult).toBeNull();

    // Trigger a transient error
    fullSyncMock.mockRejectedValue(new Error("network timeout"));
    await vi.advanceTimersByTimeAsync(30_000);

    const afterError = poller.health();
    expect(afterError.lastErrorCategory).toBe("transient");
    expect(afterError.stopped).toBe(false);

    poller.stop();
  });
});
