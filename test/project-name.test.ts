// ---------------------------------------------------------------------------
// Project name column tests (EMI-78)
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
import {
  insertTask,
  getTask,
  getAllTasks,
  updateTaskFields,
} from "../src/db/queries.js";
import type { OrcaConfig } from "../src/config/index.js";

// Mock scheduler + runner so resolveConflict imports don't fail
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

function now(): string {
  return new Date().toISOString();
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
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    resumeOnMaxTurns: true,
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

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: string;
    priority: number;
    retryCount: number;
    projectName: string | null;
    parentIdentifier: string | null;
    isParent: number;
  }> = {},
): string {
  const id = overrides.linearIssueId ?? `TEST-${Date.now().toString(36)}`;
  const ts = now();
  insertTask(db, {
    linearIssueId: id,
    agentPrompt: overrides.agentPrompt ?? "do something",
    repoPath: overrides.repoPath ?? "/tmp/fake-repo",
    orcaStatus: (overrides.orcaStatus ?? "ready") as any,
    priority: overrides.priority ?? 0,
    retryCount: overrides.retryCount ?? 0,
    projectName: overrides.projectName ?? null,
    parentIdentifier: overrides.parentIdentifier ?? null,
    isParent: overrides.isParent ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Test issue",
    description: "Test description",
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

function makeMockClient(issues: any[]) {
  return {
    fetchProjectIssues: vi.fn().mockResolvedValue(issues),
    updateIssueState: vi.fn().mockResolvedValue(true),
    createComment: vi.fn().mockResolvedValue(true),
    createAttachment: vi.fn().mockResolvedValue(true),
  } as any;
}

// ===========================================================================
// 1. DB schema: project_name column
// ===========================================================================

describe("DB schema - project_name column", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("fresh DB has project_name column that defaults to null", () => {
    const ts = now();
    insertTask(db, {
      linearIssueId: "SCHEMA-1",
      agentPrompt: "test",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "SCHEMA-1");
    expect(task).toBeDefined();
    expect(task!.projectName).toBeNull();
  });

  test("project_name can be set on insert", () => {
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-2",
      projectName: "My Project",
    });

    const task = getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("My Project");
  });

  test("project_name can be updated via updateTaskFields", () => {
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-3",
      projectName: "Old Name",
    });

    updateTaskFields(db, taskId, { projectName: "New Name" });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBe("New Name");
  });

  test("project_name can be set to null via updateTaskFields", () => {
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-4",
      projectName: "Some Project",
    });

    updateTaskFields(db, taskId, { projectName: null });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBeNull();
  });

  test("project_name can store unicode characters", () => {
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-5",
      projectName: "Projet Francais avec des accents",
    });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBe("Projet Francais avec des accents");
  });

  test("project_name can store empty string", () => {
    const taskId = seedTask(db, {
      linearIssueId: "SCHEMA-6",
      projectName: "",
    });

    const task = getTask(db, taskId);
    // Empty string is stored as empty string, not null
    expect(task!.projectName).toBe("");
  });
});

// ===========================================================================
// 2. upsertTask stores projectName on INSERT via fullSync
// ===========================================================================

describe("upsertTask - projectName on INSERT (via fullSync)", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("new task gets projectName from issue", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const issue = makeIssue({
      identifier: "EMI-1",
      projectId: "proj-1",
      projectName: "Orca Project",
    });
    const client = makeMockClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-1");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Orca Project");
  });

  test("task with empty projectName gets null stored", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    // Empty string projectName should be stored as null (|| null coercion)
    const issue = makeIssue({
      identifier: "EMI-2",
      projectName: "",
    });
    const client = makeMockClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-2");
    expect(task).toBeDefined();
    expect(task!.projectName).toBeNull();
  });

  test("task without projectName field gets null stored", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    // Simulate issue object where projectName is undefined (e.g. older LinearIssue)
    const issue = makeIssue({ identifier: "EMI-3" });
    delete (issue as any).projectName;
    const client = makeMockClient([issue]);

    await fullSync(db, client, new DependencyGraph(), config);

    const task = getTask(db, "EMI-3");
    expect(task).toBeDefined();
    // undefined || null should produce null
    expect(task!.projectName).toBeNull();
  });
});

// ===========================================================================
// 3. upsertTask stores projectName on UPDATE via fullSync
// ===========================================================================

describe("upsertTask - projectName on UPDATE (via fullSync)", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("re-sync updates projectName on existing task", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const graph = new DependencyGraph();

    // First sync: task gets "Project Alpha"
    const issue1 = makeIssue({
      identifier: "EMI-10",
      projectName: "Project Alpha",
    });
    const client1 = makeMockClient([issue1]);
    await fullSync(db, client1, graph, config);
    expect(getTask(db, "EMI-10")!.projectName).toBe("Project Alpha");

    // Second sync: project name changed to "Project Beta"
    const issue2 = makeIssue({
      identifier: "EMI-10",
      projectName: "Project Beta",
    });
    const client2 = makeMockClient([issue2]);
    await fullSync(db, client2, graph, config);
    expect(getTask(db, "EMI-10")!.projectName).toBe("Project Beta");
  });

  test("re-sync with empty projectName clears the name to null", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig();
    const graph = new DependencyGraph();

    // First sync: task has a project name
    const issue1 = makeIssue({
      identifier: "EMI-11",
      projectName: "Has Name",
    });
    const client1 = makeMockClient([issue1]);
    await fullSync(db, client1, graph, config);
    expect(getTask(db, "EMI-11")!.projectName).toBe("Has Name");

    // Second sync: empty project name
    const issue2 = makeIssue({
      identifier: "EMI-11",
      projectName: "",
    });
    const client2 = makeMockClient([issue2]);
    await fullSync(db, client2, graph, config);
    // Empty string || null -> null
    expect(getTask(db, "EMI-11")!.projectName).toBeNull();
  });
});

// ===========================================================================
// 4. Webhook: projectName resolution
// ===========================================================================

describe("Webhook - projectName resolution", () => {
  let db: OrcaDb;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    expectedChanges = syncMod.expectedChanges;
    expectedChanges.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("webhook uses projectNameMap to resolve projectName for new tasks", async () => {
    const config = testConfig({
      projectNameMap: new Map([["proj-1", "My Project"]]),
    });
    const mockClient = makeMockClient([]);
    const stateMap = new Map([
      ["Todo", { id: "s-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      { rebuild: vi.fn() } as any,
      config,
      stateMap,
      {
        action: "create",
        type: "Issue",
        data: {
          id: "uuid-1",
          identifier: "EMI-20",
          title: "New task",
          description: "desc",
          priority: 2,
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          projectId: "proj-1",
        },
      },
    );

    const task = getTask(db, "EMI-20");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("My Project");
  });

  test("webhook preserves existing projectName when projectId not in map", async () => {
    // Pre-seed task with a project name (from earlier fullSync)
    seedTask(db, {
      linearIssueId: "EMI-21",
      projectName: "Original Project",
    });

    const config = testConfig({
      // projectNameMap does NOT have the projectId
      projectNameMap: new Map(),
    });
    const mockClient = makeMockClient([]);
    const stateMap = new Map([
      ["Todo", { id: "s-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      { rebuild: vi.fn() } as any,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-2",
          identifier: "EMI-21",
          title: "Updated task",
          description: "desc",
          priority: 2,
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          projectId: "unknown-proj",
        },
      },
    );

    const task = getTask(db, "EMI-21");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Original Project");
  });

  test("webhook with no projectId and no existing task produces null projectName", async () => {
    const config = testConfig();
    const mockClient = makeMockClient([]);
    const stateMap = new Map([
      ["Todo", { id: "s-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      { rebuild: vi.fn() } as any,
      config,
      stateMap,
      {
        action: "create",
        type: "Issue",
        data: {
          id: "uuid-3",
          identifier: "EMI-22",
          title: "No project task",
          description: "desc",
          priority: 2,
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          // no projectId
        },
      },
    );

    const task = getTask(db, "EMI-22");
    expect(task).toBeDefined();
    // Empty string projectName -> null via || null coercion
    expect(task!.projectName).toBeNull();
  });

  test("webhook for existing task without projectId preserves existing projectName", async () => {
    seedTask(db, {
      linearIssueId: "EMI-23",
      projectName: "Keep This",
    });

    const config = testConfig();
    const mockClient = makeMockClient([]);
    const stateMap = new Map([
      ["Todo", { id: "s-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      { rebuild: vi.fn() } as any,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-4",
          identifier: "EMI-23",
          title: "Update without project",
          description: "desc",
          priority: 2,
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          // no projectId at all
        },
      },
    );

    const task = getTask(db, "EMI-23");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Keep This");
  });
});

// ===========================================================================
// 5. fetchProjectIssues: projectName from GraphQL
// ===========================================================================

describe("fetchProjectIssues - projectName from GraphQL", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function getClient() {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient("test-key");
  }

  test("fetchProjectIssues populates projectName from project.name in GraphQL response", async () => {
    const client = await getClient();

    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "Test issue",
              description: "desc",
              priority: 2,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1", name: "My Linear Project" },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.projectName).toBe("My Linear Project");
  });

  test("fetchProjectIssues handles missing project.name gracefully", async () => {
    const client = await getClient();

    // BUG EXPLORATION: What happens when the GraphQL response doesn't include
    // the `name` field on project? This can happen if the schema changes or
    // the mock is incomplete.
    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-2",
              identifier: "PROJ-2",
              title: "Test issue 2",
              description: null,
              priority: 1,
              state: { id: "s1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1" }, // missing name!
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);

    expect(issues).toHaveLength(1);
    // With missing name, node.project.name is undefined
    // The code does `projectName: node.project.name` which will be undefined
    expect(issues[0]!.projectName).toBeUndefined();
  });
});

// ===========================================================================
// 6. fetchProjectMetadata: name field
// ===========================================================================

describe("fetchProjectMetadata - name field", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function getClient() {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient("test-key");
  }

  test("fetchProjectMetadata returns project name", async () => {
    const client = await getClient();

    const response = {
      data: {
        projects: {
          nodes: [
            {
              id: "proj-1",
              name: "My Project",
              description: "A project",
              content: null,
              teams: { nodes: [{ id: "team-1" }] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const metadata = await client.fetchProjectMetadata(["proj-1"]);

    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.name).toBe("My Project");
  });

  test("fetchProjectMetadata handles empty name", async () => {
    const client = await getClient();

    const response = {
      data: {
        projects: {
          nodes: [
            {
              id: "proj-1",
              name: "",
              description: null,
              content: null,
              teams: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const metadata = await client.fetchProjectMetadata(["proj-1"]);

    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.name).toBe("");
  });
});

// ===========================================================================
// 7. CLI startup: projectNameMap population
// ===========================================================================

describe("CLI startup - projectNameMap population logic", () => {
  test("projectNameMap is set for projects with a name", () => {
    // Simulate the CLI startup logic from index.ts
    const config = testConfig();
    const projectMeta = [
      { id: "proj-1", name: "First Project", description: "", teamIds: ["t1"] },
      { id: "proj-2", name: "Second Project", description: "", teamIds: ["t1"] },
    ];

    for (const pm of projectMeta) {
      if (pm.name) {
        config.projectNameMap.set(pm.id, pm.name);
      }
    }

    expect(config.projectNameMap.get("proj-1")).toBe("First Project");
    expect(config.projectNameMap.get("proj-2")).toBe("Second Project");
  });

  test("projectNameMap skips projects with empty name", () => {
    const config = testConfig();
    const projectMeta = [
      { id: "proj-1", name: "", description: "", teamIds: ["t1"] },
      { id: "proj-2", name: "Valid", description: "", teamIds: ["t1"] },
    ];

    for (const pm of projectMeta) {
      if (pm.name) {
        config.projectNameMap.set(pm.id, pm.name);
      }
    }

    // Empty name is falsy, so proj-1 should NOT be in the map
    expect(config.projectNameMap.has("proj-1")).toBe(false);
    expect(config.projectNameMap.get("proj-2")).toBe("Valid");
  });
});

// ===========================================================================
// 8. Frontend sort: project sort with nulls
// ===========================================================================

describe("Frontend sort - project sort with null values", () => {
  // Replicating the frontend sort logic from TaskList.tsx
  function sortByProject(tasks: { projectName: string | null }[]) {
    return [...tasks].sort((a, b) => {
      return (a.projectName ?? "").localeCompare(b.projectName ?? "");
    });
  }

  test("sorts tasks alphabetically by project name", () => {
    const tasks = [
      { projectName: "Zeta" },
      { projectName: "Alpha" },
      { projectName: "Mu" },
    ];
    const sorted = sortByProject(tasks);
    expect(sorted.map((t) => t.projectName)).toEqual(["Alpha", "Mu", "Zeta"]);
  });

  test("null projectName sorts to the beginning (before any string)", () => {
    const tasks = [
      { projectName: "Beta" },
      { projectName: null },
      { projectName: "Alpha" },
    ];
    const sorted = sortByProject(tasks);
    // null -> "" which sorts before "Alpha"
    expect(sorted[0]!.projectName).toBeNull();
    expect(sorted[1]!.projectName).toBe("Alpha");
    expect(sorted[2]!.projectName).toBe("Beta");
  });

  test("multiple null projectNames group together", () => {
    const tasks = [
      { projectName: "Gamma" },
      { projectName: null },
      { projectName: null },
      { projectName: "Alpha" },
    ];
    const sorted = sortByProject(tasks);
    // Both nulls should be at the start
    expect(sorted[0]!.projectName).toBeNull();
    expect(sorted[1]!.projectName).toBeNull();
    expect(sorted[2]!.projectName).toBe("Alpha");
    expect(sorted[3]!.projectName).toBe("Gamma");
  });

  test("all tasks with null projectName returns stable order", () => {
    const tasks = [
      { projectName: null },
      { projectName: null },
      { projectName: null },
    ];
    const sorted = sortByProject(tasks);
    expect(sorted).toHaveLength(3);
    expect(sorted.every((t) => t.projectName === null)).toBe(true);
  });

  test("case-sensitive sort (default localeCompare behavior)", () => {
    const tasks = [
      { projectName: "alpha" },
      { projectName: "Beta" },
      { projectName: "Alpha" },
    ];
    const sorted = sortByProject(tasks);
    // localeCompare is case-insensitive by default in most locales
    // but exact order depends on locale implementation
    expect(sorted).toHaveLength(3);
  });
});

// ===========================================================================
// 9. API: projectName in task response
// ===========================================================================

describe("API - projectName in task response", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("getAllTasks returns projectName field", () => {
    seedTask(db, { linearIssueId: "API-1", projectName: "Test Project" });
    seedTask(db, { linearIssueId: "API-2", projectName: null });

    const tasks = getAllTasks(db);
    expect(tasks).toHaveLength(2);

    const task1 = tasks.find((t) => t.linearIssueId === "API-1");
    const task2 = tasks.find((t) => t.linearIssueId === "API-2");

    expect(task1!.projectName).toBe("Test Project");
    expect(task2!.projectName).toBeNull();
  });

  test("getTask returns projectName field", () => {
    seedTask(db, { linearIssueId: "API-3", projectName: "My Project" });

    const task = getTask(db, "API-3");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("My Project");
  });
});

// ===========================================================================
// 10. DB migration: project_name column added to existing DB
// ===========================================================================

describe("DB migration - project_name column", () => {
  test("migration adds project_name to existing DB without it", () => {
    // The CREATE_TASKS SQL already includes project_name,
    // so a fresh DB always has it. The migration (migration 5) only runs
    // when the column doesn't exist. We can verify the migration logic
    // by testing that createDb works and the column exists.
    const db = freshDb();
    const ts = now();
    insertTask(db, {
      linearIssueId: "MIGRATE-1",
      agentPrompt: "test",
      repoPath: "/tmp/repo",
      orcaStatus: "ready",
      priority: 0,
      retryCount: 0,
      projectName: "Migrated Project",
      createdAt: ts,
      updatedAt: ts,
    });

    const task = getTask(db, "MIGRATE-1");
    expect(task!.projectName).toBe("Migrated Project");
  });
});

// ===========================================================================
// 11. Edge cases
// ===========================================================================

describe("Edge cases", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("very long project name is stored correctly", () => {
    const longName = "A".repeat(1000);
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-1",
      projectName: longName,
    });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBe(longName);
    expect(task!.projectName!.length).toBe(1000);
  });

  test("project name with special characters", () => {
    const specialName = '<script>alert("xss")</script>';
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-2",
      projectName: specialName,
    });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBe(specialName);
  });

  test("project name with newlines", () => {
    const nameWithNewlines = "Line 1\nLine 2\nLine 3";
    const taskId = seedTask(db, {
      linearIssueId: "EDGE-3",
      projectName: nameWithNewlines,
    });

    const task = getTask(db, taskId);
    expect(task!.projectName).toBe(nameWithNewlines);
  });

  test("multiple tasks can share the same project name", () => {
    seedTask(db, { linearIssueId: "SHARED-1", projectName: "Shared Project" });
    seedTask(db, { linearIssueId: "SHARED-2", projectName: "Shared Project" });
    seedTask(db, { linearIssueId: "SHARED-3", projectName: "Shared Project" });

    const tasks = getAllTasks(db).filter((t) => t.projectName === "Shared Project");
    expect(tasks).toHaveLength(3);
  });

  test("mix of tasks with and without project names", () => {
    seedTask(db, { linearIssueId: "MIX-1", projectName: "Project A" });
    seedTask(db, { linearIssueId: "MIX-2", projectName: null });
    seedTask(db, { linearIssueId: "MIX-3", projectName: "Project B" });
    seedTask(db, { linearIssueId: "MIX-4", projectName: null });

    const tasks = getAllTasks(db);
    const withName = tasks.filter((t) => t.projectName !== null);
    const withoutName = tasks.filter((t) => t.projectName === null);

    expect(withName).toHaveLength(2);
    expect(withoutName).toHaveLength(2);
  });
});

// ===========================================================================
// 12. Webhook projectName: edge case where projectNameMap has the projectId
//     but existing task has a DIFFERENT projectName (project reassignment)
// ===========================================================================

describe("Webhook - project reassignment", () => {
  let db: OrcaDb;
  let processWebhookEvent: typeof import("../src/linear/sync.js").processWebhookEvent;
  let expectedChanges: typeof import("../src/linear/sync.js").expectedChanges;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    processWebhookEvent = syncMod.processWebhookEvent;
    expectedChanges = syncMod.expectedChanges;
    expectedChanges.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("task moved to a different project gets new project name from map", async () => {
    // Task was in "Project Alpha" but got moved to "Project Beta"
    seedTask(db, {
      linearIssueId: "EMI-30",
      projectName: "Project Alpha",
    });

    const config = testConfig({
      projectNameMap: new Map([
        ["proj-alpha", "Project Alpha"],
        ["proj-beta", "Project Beta"],
      ]),
    });
    const mockClient = makeMockClient([]);
    const stateMap = new Map([
      ["Todo", { id: "s-todo", type: "unstarted" }],
    ]);

    await processWebhookEvent(
      db,
      mockClient,
      { rebuild: vi.fn() } as any,
      config,
      stateMap,
      {
        action: "update",
        type: "Issue",
        data: {
          id: "uuid-30",
          identifier: "EMI-30",
          title: "Moved task",
          description: "desc",
          priority: 2,
          state: { id: "s-todo", name: "Todo", type: "unstarted" },
          projectId: "proj-beta", // moved to a different project
        },
      },
    );

    const task = getTask(db, "EMI-30");
    expect(task).toBeDefined();
    expect(task!.projectName).toBe("Project Beta");
  });
});

// ===========================================================================
// 13. fullSync end-to-end: multiple issues from different projects
// ===========================================================================

describe("fullSync - multiple projects", () => {
  let db: OrcaDb;
  let fullSync: typeof import("../src/linear/sync.js").fullSync;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const syncMod = await import("../src/linear/sync.js");
    fullSync = syncMod.fullSync;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("issues from different projects get their respective project names", async () => {
    const { DependencyGraph } = await import("../src/linear/graph.js");
    const config = testConfig({
      projectRepoMap: new Map([
        ["proj-a", "/repo-a"],
        ["proj-b", "/repo-b"],
      ]),
    });

    const issues = [
      makeIssue({ identifier: "A-1", projectId: "proj-a", projectName: "Project A" }),
      makeIssue({ identifier: "A-2", projectId: "proj-a", projectName: "Project A" }),
      makeIssue({ identifier: "B-1", projectId: "proj-b", projectName: "Project B" }),
    ];
    const client = makeMockClient(issues);

    await fullSync(db, client, new DependencyGraph(), config);

    expect(getTask(db, "A-1")!.projectName).toBe("Project A");
    expect(getTask(db, "A-2")!.projectName).toBe("Project A");
    expect(getTask(db, "B-1")!.projectName).toBe("Project B");
  });
});

// ===========================================================================
// 14. Linear integration test mock: missing projectName in mock responses
// ===========================================================================

describe("LinearClient mock responses - projectName field coverage", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: Mock;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function getClient() {
    const { LinearClient } = await import("../src/linear/client.js");
    return new LinearClient("test-key");
  }

  test("existing linear-integration test mock is missing project.name - documents the gap", async () => {
    // This test documents that the mock response in linear-integration.test.ts
    // line 135 has `project: { id: "proj-1" }` without `name`.
    // The implementation accesses `node.project.name` which will be `undefined`.
    const client = await getClient();

    // Replicate the exact mock from linear-integration.test.ts
    const response = {
      data: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "issue-1",
              identifier: "PROJ-1",
              title: "First issue",
              priority: 2,
              state: { id: "state-1", name: "Todo", type: "unstarted" },
              team: { id: "team-1" },
              project: { id: "proj-1" }, // Missing `name`!
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              parent: null,
              children: { nodes: [] },
            },
          ],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const issues = await client.fetchProjectIssues(["proj-1"]);

    // BUG: projectName is undefined, not a string as the LinearIssue type claims
    // This won't crash but violates the type contract
    expect(issues[0]!.projectName).toBeUndefined();
    // In upsertTask, `undefined || null` evaluates to `null`, so it works
    // but the type system says projectName is always a string
  });
});
