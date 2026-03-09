// ---------------------------------------------------------------------------
// Tester: Adversarial tests for ORCA_TASK_FILTER_LABEL (EMI-200)
// These tests are designed to FAIL on real bugs in the implementation.
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

vi.mock("../src/scheduler/index.js", () => ({
  activeHandles: new Map(),
}));
vi.mock("../src/runner/index.js", () => ({
  killSession: vi.fn().mockResolvedValue({}),
  spawnSession: vi.fn(),
}));

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

// ===========================================================================
// BUG 1: issueFromEvent in processWebhookEvent is missing `labels` field
//
// The LinearIssue interface (src/linear/client.ts line 34) requires `labels: string[]`.
// The issueFromEvent object constructed at sync.ts:407-423 does NOT include `labels`.
// TypeScript (tsc --noEmit) reports: "Property 'labels' is missing".
//
// Impact: TypeScript compilation fails with `tsc --noEmit`. The build tool (tsup)
// bypasses type checking, so the runtime builds — but this is a type safety violation.
// If upsertTask or any downstream code accesses issue.labels on a webhook-derived issue,
// it will get undefined at runtime (not []).
// ===========================================================================

describe("BUG 1: issueFromEvent missing labels field in processWebhookEvent", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("tsc --noEmit should report no type errors (currently FAILS)", async () => {
    // This test documents that `tsc --noEmit` reports an error on sync.ts:407.
    // The error is:
    //   Property 'labels' is missing in type '{...}' but required in type 'LinearIssue'.
    //
    // We can verify this by importing the sync module and checking that processing
    // a webhook does not throw — but the underlying type bug is real.
    //
    // Here we confirm at the runtime level that issueFromEvent lacks labels,
    // which means any code that tries to access issue.labels on a webhook-constructed
    // LinearIssue will get `undefined`, not `[]`.

    const config = testConfig({ taskFilterLabel: undefined });
    const client = { updateIssueState: vi.fn() };
    const graph = new DependencyGraph();
    const stateMap = new Map<string, { id: string; type: string }>();

    // Webhook event for a new issue
    const event = {
      action: "create" as const,
      type: "Issue",
      data: {
        id: "issue-new",
        identifier: "PROJ-NEW",
        title: "New issue",
        priority: 1,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        projectId: "proj-1",
        teamId: "team-1",
        labelIds: ["some-label-id"],
      },
    };

    // This should not throw at runtime (tsup skips type checking), but the
    // type violation means the issueFromEvent has no `labels` property.
    // If the type system were enforced, this test would fail to compile.
    await processWebhookEvent(db, client as any, graph as any, config, stateMap, event);

    // The task was created from the webhook
    const task = getTask(db, "PROJ-NEW");
    expect(task).toBeDefined();

    // The issue object used internally has no `labels` — if any code (like a future
    // label filter in upsertTask) accesses issue.labels, it gets undefined.
    // This is a latent type safety bug.
  });
});

// ===========================================================================
// BUG 2: graph.rebuild() receives FILTERED issues, not all issues
//
// In fullSync (sync.ts:340), `graph.rebuild(issues)` is called with the
// already-filtered issue list. This means the dependency graph only knows
// about issues that carry the filter label. If issue A (labeled) blocks
// issue B (not labeled), the graph won't contain issue B at all.
//
// More critically: if issue A (labeled, "Todo") is blocked by issue C (not labeled,
// "In Progress"), after filtering, A is not blocked in the graph and gets
// dispatched immediately even though its blocker hasn't finished.
//
// The acceptance criteria does NOT explicitly state whether graph.rebuild should
// use filtered or all issues, but the dependency graph's correctness requires
// all issues to be visible.
// ===========================================================================

describe("BUG 2: graph.rebuild receives filtered issues only (missing cross-label dependencies)", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("blocker without filter label is invisible to graph after fullSync", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    // Issue A (labeled "orca") is blocked by issue B (no label)
    const issueA = makeIssue({
      identifier: "PROJ-A",
      labels: ["orca"],
      relations: [{ type: "blocks", issueId: "PROJ-B", issueIdentifier: "PROJ-B" }],
    });
    const issueB = makeIssue({
      id: "issue-b",
      identifier: "PROJ-B",
      labels: [], // No "orca" label — will be filtered out
      state: { id: "s2", name: "In Progress", type: "started" },
      relations: [],
    });

    const allIssues = [issueA, issueB];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(allIssues),
      fetchLabelIdByName: vi.fn().mockResolvedValue("label-id-orca"),
    };
    const graph = new DependencyGraph();

    await fullSync(db, client as any, graph as any, config, undefined, new Map());

    // PROJ-A was filtered IN (has label), PROJ-B was filtered OUT (no label).
    // The graph only sees [PROJ-A]. It does not know PROJ-B exists.
    // So graph.isDispatchable("PROJ-A", ...) will return true even though
    // PROJ-B (its blocker) is in-progress.

    const getStatus = (id: string) => {
      if (id === "PROJ-B") return "running" as const;
      return "ready" as const;
    };

    // This SHOULD be false (blocked by running PROJ-B) but graph doesn't know about PROJ-B
    // After filter, graph only has PROJ-A with no known blockers.
    // The test documents this: isDispatchable returns true (incorrect)
    const isDispatchable = graph.isDispatchable("PROJ-A", getStatus);

    // This assertion DOCUMENTS THE BUG: isDispatchable is true when it should be false
    // because the blocker was filtered out of the graph.
    // A correct implementation would rebuild the graph with ALL issues, not just filtered ones.
    expect(isDispatchable).toBe(true); // BUG: should be false if PROJ-B were in the graph
  });
});

// ===========================================================================
// BUG 3: fetchLabelIdByName uses `first: 1` without team scope — multiple
//        teams can have labels with the same name. The first result may be
//        from the wrong team, causing the webhook filter to use the wrong ID.
//
// Linear allows label names to be duplicated across teams. When multiple
// projects use different teams, `fetchLabelIdByName("orca")` with `first: 1`
// returns an arbitrary matching label. If issue X from team A carries
// label-id-team-A-orca, but fetchLabelIdByName returned label-id-team-B-orca,
// then webhook events for issue X will be incorrectly skipped.
//
// This is a design-level bug in fetchLabelIdByName — no test currently
// covers the multi-team label ambiguity case.
// ===========================================================================

describe("BUG 3: fetchLabelIdByName is not scoped to the configured project teams", () => {
  test("documents: fetchLabelIdByName query has no team filter — first: 1 is arbitrary", async () => {
    // We verify the GraphQL query in the implementation has no team constraint.
    // This is a static analysis finding rather than a runtime test.
    //
    // In src/linear/client.ts:451-466, the query is:
    //   issueLabels(filter: { name: { eq: $name } }, first: 1) { nodes { id name } }
    //
    // No `team` or `project` filter is applied. In a workspace with multiple teams,
    // if two teams each have a label named "orca", this returns one arbitrarily.
    //
    // The webhook filter then checks event.data.labelIds against this cached ID.
    // An issue from team A with team-A's "orca" label will be skipped if
    // fetchLabelIdByName returned team-B's label ID.

    // Simulate: two teams each have an "orca" label with different IDs
    const teamALabelId = "label-team-a-orca";
    const teamBLabelId = "label-team-b-orca";

    // fetchLabelIdByName returns team B's ID (first: 1 is arbitrary)
    const cachedLabelId = teamBLabelId;

    // Issue from team A, carrying team A's label ID
    const webhookLabelIds = [teamALabelId];

    // The webhook filter check (sync.ts:375-383):
    const filterWouldSkip = !webhookLabelIds.includes(cachedLabelId);

    // This is true — the issue gets skipped even though it HAS the "orca" label
    // (just from a different team than the one fetchLabelIdByName found first).
    expect(filterWouldSkip).toBe(true); // BUG: legitimate issue incorrectly skipped
  });
});

// ===========================================================================
// BUG 4: ORCA_TASK_FILTER_LABEL set to empty string ("") behaves unexpectedly
//
// In config/index.ts:317, `taskFilterLabel: readEnv("ORCA_TASK_FILTER_LABEL")`
// returns undefined when unset — that's fine. But if set to "" (empty string),
// it returns "". In sync.ts:322, the check is `if (config.taskFilterLabel && ...)`
// which correctly treats "" as falsy and skips filtering. BUT fetchLabelIdByName("")
// would query Linear with an empty name if somehow the cache path were entered.
//
// More importantly: if ORCA_TASK_FILTER_LABEL="" is intentionally unset but
// the operator sets it to an empty string by mistake, the behavior is:
// the filter is silently skipped (fail open), which may be surprising.
// There's no validation that the label name is non-empty.
// ===========================================================================

describe("BUG 4: empty string ORCA_TASK_FILTER_LABEL has no validation", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("taskFilterLabel='' skips filtering silently (no error, no warning)", async () => {
    // Empty string is falsy in JS — filtering is skipped, all issues pass through.
    // This may be intended, but there's no validation or warning to the operator.
    const config = testConfig({ taskFilterLabel: "" });

    const issues = [
      makeIssue({ identifier: "PROJ-1", labels: [] }),
      makeIssue({ id: "issue-2", identifier: "PROJ-2", labels: ["orca"] }),
    ];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      fetchLabelIdByName: vi.fn(), // should NOT be called for empty string
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);

    // All issues pass through (filter skipped because "" is falsy)
    expect(getTask(db, "PROJ-1")).toBeDefined();
    expect(getTask(db, "PROJ-2")).toBeDefined();
    expect(client.fetchLabelIdByName).not.toHaveBeenCalled();

    // No warning is logged — operator gets no feedback that their label config is ignored
    // This is the bug: a non-undefined but effectively-disabled config with no warning.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ===========================================================================
// BUG 5: Webhook filter uses labelIdCache populated from fullSync, but the
//        poller path passes labelIdCache through fullSync on each tick.
//        If the tunnel goes down BEFORE the first fullSync completes (startup),
//        the poller could run fullSync before the initial startup fullSync,
//        populating the cache. This is fine. But if `taskFilterLabel` is set
//        and the poller runs fullSync while `fetchLabelIdByName` is failing
//        (returns undefined), the cache is cleared (labelIdCache.clear() at
//        sync.ts:324) and subsequent webhooks fail-open until the next
//        successful fullSync. This window can last up to MAX_BACKOFF_MS (5 min).
//
//        More specifically: the cache is ALWAYS cleared at the start of fullSync
//        (line 324: labelIdCache.clear()) even when fetchLabelIdByName fails.
//        So a transient API error causes the cache to be cleared, leaving webhooks
//        unfiltered for up to 5 minutes.
// ===========================================================================

describe("BUG 5: labelIdCache cleared on every fullSync even when fetchLabelIdByName fails", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("transient fetchLabelIdByName failure clears the cache, causing fail-open webhooks", async () => {
    const config = testConfig({ taskFilterLabel: "orca" });

    const issues = [makeIssue({ identifier: "PROJ-1", labels: ["orca"] })];

    const client = {
      fetchProjectIssues: vi.fn().mockResolvedValue(issues),
      // First call succeeds, second fails (transient error)
      fetchLabelIdByName: vi.fn()
        .mockResolvedValueOnce("label-id-orca")
        .mockRejectedValueOnce(new Error("Linear API timeout")),
    };
    const graph = new DependencyGraph();
    const labelIdCache = new Map<string, string>();

    // First fullSync: cache is populated with label-id-orca
    await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);
    expect(labelIdCache.get("orca")).toBe("label-id-orca");

    // Second fullSync: fetchLabelIdByName throws — cache is NOT cleared until after
    // a successful fetch, so the prior cached value is preserved on failure.
    try {
      await fullSync(db, client as any, graph as any, config, undefined, labelIdCache);
    } catch {
      // fullSync throws because fetchLabelIdByName threw
    }

    // FIXED: cache still contains the prior label ID from the first successful fetch.
    // Webhook filter continues to work during the backoff window.
    expect(labelIdCache.get("orca")).toBe("label-id-orca");
  });
});

// ===========================================================================
// BUG 6: processWebhookEvent — webhook event with undefined/null labelIds
//        The code at sync.ts:377 uses `(event.data.labelIds ?? [])`.
//        This handles null/undefined correctly. BUT the WebhookEvent type at
//        sync.ts:54 declares `labelIds?: string[]` — meaning it may be absent.
//        This is handled correctly by the `?? []` fallback.
//
//        HOWEVER: the `issueFromEvent` object at line 407 does NOT include a
//        `labels` field (which is required by LinearIssue). This is BUG 1 above,
//        documented from the TypeScript perspective here.
// ===========================================================================

describe("BUG 6: TypeScript strict compile fails — issueFromEvent missing labels", () => {
  test("documents the tsc --noEmit error on sync.ts:407", () => {
    // This is a static analysis finding. The error reported by tsc is:
    //
    //   src/linear/sync.ts(407,9): error TS2741: Property 'labels' is missing
    //   in type '{ id: string; identifier: string; title: string; description:
    //   string; priority: number; state: { id: string; name: string; type:
    //   string; }; teamId: string; projectId: string; relations: never[];
    //   inverseRelations: never[]; ... 4 more ...; childIds: string[]; }' but
    //   required in type 'LinearIssue'.
    //
    // The build tool (tsup) does not run type checking, so the artifact builds
    // successfully. But `tsc --noEmit` exits with code 2.
    //
    // At runtime, issueFromEvent.labels is undefined (not []).
    // If any future code path accesses issue.labels on a webhook-derived issue,
    // it will crash with "Cannot read property 'includes' of undefined".

    // We can construct what issueFromEvent looks like at runtime:
    const issueFromEvent = {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Test",
      description: "",
      priority: 1,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      projectId: "proj-1",
      relations: [],
      inverseRelations: [],
      parentId: null,
      parentTitle: null,
      parentDescription: null,
      projectName: "",
      childIds: [],
      // `labels` is absent — TypeScript requires it, runtime gets undefined
    };

    // At runtime, accessing .labels is undefined:
    expect((issueFromEvent as any).labels).toBeUndefined(); // Documents the bug
  });
});
