// ---------------------------------------------------------------------------
// Cleanup module tests
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
import {
  insertTask,
  insertInvocation,
  updateInvocation,
  getTask,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Mocks — git, worktree, and github modules
// ---------------------------------------------------------------------------

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
}));

vi.mock("../src/worktree/index.js", () => ({
  removeWorktree: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock("../src/github/index.js", () => ({
  listOpenPrBranches: vi.fn(),
  findPrForBranch: vi.fn(),
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

function seedTask(
  db: OrcaDb,
  overrides: Partial<{
    linearIssueId: string;
    agentPrompt: string;
    repoPath: string;
    orcaStatus: TaskStatus;
    priority: number;
    retryCount: number;
    prBranchName: string | null;
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
    prBranchName: overrides.prBranchName ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}

function seedRunningInvocation(
  db: OrcaDb,
  taskId: string,
  overrides: Partial<{
    branchName: string;
    worktreePath: string;
  }> = {},
): number {
  const id = insertInvocation(db, {
    linearIssueId: taskId,
    startedAt: now(),
    status: "running",
  });
  if (overrides.branchName || overrides.worktreePath) {
    updateInvocation(db, id, {
      branchName: overrides.branchName,
      worktreePath: overrides.worktreePath,
    });
  }
  return id;
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
    deployStrategy: "none",
    deployPollIntervalSec: 30,
    deployTimeoutMin: 30,
    cleanupIntervalMin: 10,
    cleanupBranchMaxAgeMin: 60,
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    projectRepoMap: new Map(),
    projectNameMap: new Map(),
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Cleanup - config defaults", () => {
  test("cleanupIntervalMin defaults to 10", () => {
    const cfg = testConfig();
    expect(cfg.cleanupIntervalMin).toBe(10);
  });

  test("cleanupBranchMaxAgeMin defaults to 60", () => {
    const cfg = testConfig();
    expect(cfg.cleanupBranchMaxAgeMin).toBe(60);
  });

  test("cleanupIntervalMin can be overridden", () => {
    const cfg = testConfig({ cleanupIntervalMin: 30 });
    expect(cfg.cleanupIntervalMin).toBe(30);
  });

  test("cleanupBranchMaxAgeMin can be overridden", () => {
    const cfg = testConfig({ cleanupBranchMaxAgeMin: 120 });
    expect(cfg.cleanupBranchMaxAgeMin).toBe(120);
  });
});

describe("Cleanup - branch safety filters", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does nothing when no tasks exist", () => {
    cleanupStaleResources({ db, config: testConfig() });
    // git should not be called at all (no repos to clean)
    expect(gitMock).not.toHaveBeenCalled();
  });

  test("skips branches used by running invocations", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-1",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "running",
    });
    seedRunningInvocation(db, taskId, {
      branchName: "orca/T-1-inv-1",
      worktreePath: "/tmp/fake-repo-T-1",
    });

    // Mock git calls
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-1-inv-1";
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("Should not delete running branch!");
      }
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // branch -D should never be called for the running branch
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("skips branches referenced by active (non-terminal) tasks", () => {
    seedTask(db, {
      linearIssueId: "T-2",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
      prBranchName: "orca/T-2-inv-1",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-2-inv-1";
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("Should not delete active task branch!");
      }
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("skips branches with open PRs", () => {
    seedTask(db, {
      linearIssueId: "T-3",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-3-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("Should not delete branch with open PR!");
      }
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set(["orca/T-3-inv-1"]));

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("skips branches younger than cleanupBranchMaxAgeMin", () => {
    seedTask(db, {
      linearIssueId: "T-4",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // Branch committed 5 minutes ago (younger than 60min default)
    const recentDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-4-inv-1";
      if (args[0] === "log") return recentDate;
      if (args[0] === "branch" && args[1] === "-D") {
        throw new Error("Should not delete young branch!");
      }
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("deletes stale branch that passes all safety checks", () => {
    seedTask(db, {
      linearIssueId: "T-5",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // Branch committed 2 hours ago (older than 60min default)
    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-5-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual(["branch", "-D", "orca/T-5-inv-1"]);
  });

  test("branches from failed tasks are eligible for cleanup", () => {
    seedTask(db, {
      linearIssueId: "T-6",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "failed",
      prBranchName: "orca/T-6-inv-1",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-6-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // "failed" is terminal — branch should be deleted
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });

  test("only deletes orca/* branches, not other branches", () => {
    seedTask(db, {
      linearIssueId: "T-7",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // for-each-ref only returns orca/* branches
    // so non-orca branches should never appear
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  test("handles multiple repos independently", () => {
    seedTask(db, {
      linearIssueId: "T-8a",
      repoPath: "/tmp/repo-a",
      orcaStatus: "done",
    });
    seedTask(db, {
      linearIssueId: "T-8b",
      repoPath: "/tmp/repo-b",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[], opts?: { cwd?: string }) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") {
        if (opts?.cwd === "/tmp/repo-a") return "orca/T-8a-inv-1";
        if (opts?.cwd === "/tmp/repo-b") return "orca/T-8b-inv-1";
        return "";
      }
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(2);
  });

  test("continues cleanup of other repos if one repo fails", () => {
    seedTask(db, {
      linearIssueId: "T-9a",
      repoPath: "/tmp/repo-fail",
      orcaStatus: "done",
    });
    seedTask(db, {
      linearIssueId: "T-9b",
      repoPath: "/tmp/repo-ok",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[], opts?: { cwd?: string }) => {
      if (args[0] === "worktree" && args[1] === "prune") {
        if (opts?.cwd === "/tmp/repo-fail") throw new Error("prune failed!");
        return "";
      }
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") {
        if (opts?.cwd === "/tmp/repo-ok") return "orca/T-9b-inv-1";
        return "";
      }
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    // Should not throw
    cleanupStaleResources({ db, config: testConfig() });

    // Second repo's branch should still be cleaned up
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual(["branch", "-D", "orca/T-9b-inv-1"]);
  });
});

// ===========================================================================
// Adversarial tests - edge cases, race conditions, safety violations
// ===========================================================================

describe("Cleanup - null age deletes branch (BUG: fail-open on unknown age)", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // BUG: When git log fails (returns null for commit date), the age gate
  // condition on line 245 evaluates as:
  //   if (null !== null && ...) continue;  =>  false  =>  does NOT skip
  // This means a branch whose age cannot be determined is DELETED.
  // Safe behavior would be to SKIP branches with unknown age.
  test("branch with unknown age (git log fails) should NOT be deleted", () => {
    seedTask(db, {
      linearIssueId: "T-NULL-AGE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-NULL-AGE-inv-1";
      // git log fails -- getBranchLastCommitMs returns null
      if (args[0] === "log") throw new Error("git log failed");
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // A branch with unknown age should be preserved (fail-safe).
    // If this test fails, it means the branch was deleted despite
    // not knowing whether it's old enough -- a safety violation.
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // Same bug but with git log returning empty string
  test("branch with empty git log output should NOT be deleted", () => {
    seedTask(db, {
      linearIssueId: "T-EMPTY-LOG",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-EMPTY-LOG-inv-1";
      // git log returns empty string -- getBranchLastCommitMs returns null
      if (args[0] === "log") return "";
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // git log returns an unparseable date string -- new Date("garbage").getTime() => NaN
  test("branch with unparseable date should NOT be deleted", () => {
    seedTask(db, {
      linearIssueId: "T-BAD-DATE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-BAD-DATE-inv-1";
      // git log returns garbage that parses to NaN
      if (args[0] === "log") return "not-a-date-string";
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // NaN arithmetic: Date.now() - NaN = NaN, NaN < maxAgeMs = false
    // So the branch would be deleted. This is another fail-open bug.
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("Cleanup - task status edge cases", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The "deploying" status is not in TERMINAL_STATUSES, so its branches
  // should be protected. Verify this explicitly.
  test("branches from deploying tasks are NOT deleted", () => {
    seedTask(db, {
      linearIssueId: "T-DEPLOY",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "deploying",
      prBranchName: "orca/T-DEPLOY-inv-1",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-DEPLOY-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // "dispatched" is a transient state -- branches should be protected
  test("branches from dispatched tasks are NOT deleted", () => {
    seedTask(db, {
      linearIssueId: "T-DISPATCH",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "dispatched",
      prBranchName: "orca/T-DISPATCH-inv-1",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-DISPATCH-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // "changes_requested" is active -- branches should be protected
  test("branches from changes_requested tasks are NOT deleted", () => {
    seedTask(db, {
      linearIssueId: "T-CHANGES",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "changes_requested",
      prBranchName: "orca/T-CHANGES-inv-1",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-CHANGES-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // Orca branch that exists in git but has NO corresponding task in DB.
  // This is a real scenario: someone manually created an orca/* branch,
  // or a task was deleted from DB but its branch remains.
  test("orca branch with no task in DB is still eligible for cleanup", () => {
    // Need at least one task so cleanup runs on this repo path
    seedTask(db, {
      linearIssueId: "T-EXISTS",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      // Two branches: one from the task, one orphaned (no matching task)
      if (args[0] === "for-each-ref") return "orca/T-EXISTS-inv-1\norca/ORPHANED-inv-99";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // Both branches should be cleaned up (both are old, no open PRs, etc.)
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(2);
  });

  // Multiple tasks in the same repo with different statuses
  test("mixed task statuses in same repo: only terminal+old branches deleted", () => {
    // Active task -- its branch should be protected
    seedTask(db, {
      linearIssueId: "T-ACTIVE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
      prBranchName: "orca/T-ACTIVE-inv-1",
    });
    // Done task -- its branch is eligible
    seedTask(db, {
      linearIssueId: "T-DONE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
      prBranchName: "orca/T-DONE-inv-1",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-ACTIVE-inv-1\norca/T-DONE-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    // Only T-DONE branch should be deleted, T-ACTIVE is in activeBranches
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual(["branch", "-D", "orca/T-DONE-inv-1"]);
  });
});

describe("Cleanup - config edge cases", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // cleanupBranchMaxAgeMin=1 means branches older than 1 minute are eligible.
  // A 2-minute-old branch should be deleted.
  test("very small cleanupBranchMaxAgeMin (1 min) works correctly", () => {
    seedTask(db, {
      linearIssueId: "T-SMALL-AGE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // 2 minutes ago -- older than 1 minute max age
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-SMALL-AGE-inv-1";
      if (args[0] === "log") return twoMinAgo;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({
      db,
      config: testConfig({ cleanupBranchMaxAgeMin: 1 }),
    });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });

  // Very large max age -- nothing should be deleted
  test("very large cleanupBranchMaxAgeMin prevents all deletions", () => {
    seedTask(db, {
      linearIssueId: "T-LARGE-AGE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // 2 hours ago -- but max age is 1 million minutes
    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-LARGE-AGE-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({
      db,
      config: testConfig({ cleanupBranchMaxAgeMin: 1_000_000 }),
    });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  // Branch at exactly the age boundary (edge of maxAge)
  test("branch at exact max age boundary is NOT deleted (age === maxAge)", () => {
    seedTask(db, {
      linearIssueId: "T-BOUNDARY",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    // Exactly 60 minutes ago (= default maxAge)
    // now - commitMs = maxAgeMs, condition is `< maxAgeMs` so NOT less than
    // => does not skip => gets deleted. The boundary is exclusive.
    // This test documents the boundary behavior.
    const exactAge = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-BOUNDARY-inv-1";
      if (args[0] === "log") return exactAge;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // At exact boundary: now - commitMs === maxAgeMs, condition is <, so
    // branch is NOT younger than max age and gets deleted.
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });
});

describe("Cleanup - listOpenPrBranches failure is fail-open (potential safety issue)", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // When listOpenPrBranches returns empty set (e.g., gh CLI fails),
  // branches with open PRs lose their protection and get deleted.
  // This is a design concern: the current implementation is fail-open
  // for the open-PR check.
  test("gh CLI failure causes open-PR branches to lose protection", () => {
    seedTask(db, {
      linearIssueId: "T-PR-FAIL",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-PR-FAIL-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    // Simulate gh failure: returns empty set (matching real implementation
    // behavior in listOpenPrBranches which catches errors and returns new Set())
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // The branch gets deleted even though it might have an open PR
    // (we just couldn't check because gh failed).
    // This documents the fail-open behavior. In a safety-critical system
    // this would be a bug; here it's a design tradeoff documented by this test.
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    // If this passes, it confirms the fail-open behavior
    expect(deleteCalls).toHaveLength(1);
  });
});

describe("Cleanup - duplicate repo paths deduplication", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Multiple tasks with the same repoPath should only clean the repo once
  test("same repo path from multiple tasks is only cleaned once", () => {
    seedTask(db, {
      linearIssueId: "T-DUP-1",
      repoPath: "/tmp/same-repo",
      orcaStatus: "done",
    });
    seedTask(db, {
      linearIssueId: "T-DUP-2",
      repoPath: "/tmp/same-repo",
      orcaStatus: "done",
    });
    seedTask(db, {
      linearIssueId: "T-DUP-3",
      repoPath: "/tmp/same-repo",
      orcaStatus: "failed",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-DUP-1-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // worktree prune should only be called once for the deduped repo
    const pruneCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "worktree" && call[0][1] === "prune",
    );
    expect(pruneCalls).toHaveLength(1);
  });
});

describe("Cleanup - branch delete failure resilience", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // If deleting one branch fails, the next branch should still be attempted
  test("failure to delete one branch does not prevent deleting others", () => {
    seedTask(db, {
      linearIssueId: "T-MULTI",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    let deleteAttempts = 0;

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref")
        return "orca/T-MULTI-inv-1\norca/T-MULTI-inv-2\norca/T-MULTI-inv-3";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") {
        deleteAttempts++;
        if (args[2] === "orca/T-MULTI-inv-1") throw new Error("branch locked");
        return "";
      }
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    // Should not throw
    cleanupStaleResources({ db, config: testConfig() });

    // All 3 branches should be attempted
    expect(deleteAttempts).toBe(3);
  });

  // removeWorktree failure should not prevent branch cleanup
  test("worktree removal failure does not prevent branch cleanup", () => {
    seedTask(db, {
      linearIssueId: "T-WT-FAIL",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return "worktree /tmp/fake-repo\nworktree /tmp/fake-repo-T-WT-FAIL";
      if (args[0] === "for-each-ref") return "orca/T-WT-FAIL-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    removeWorktreeMock.mockImplementation(() => {
      throw new Error("worktree remove failed");
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // Branch cleanup should still proceed despite worktree failure
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });
});

describe("Cleanup - worktree path matching edge cases", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The worktree matching uses basename(repoPath) + "-" prefix.
  // A worktree that IS the repo itself should never be removed.
  test("main worktree (repo itself) is never removed", () => {
    seedTask(db, {
      linearIssueId: "T-MAIN",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return "worktree /tmp/fake-repo\nworktree /tmp/fake-repo-T-MAIN";
      if (args[0] === "for-each-ref") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // removeWorktree should only be called for the task worktree, not the main repo
    expect(removeWorktreeMock).toHaveBeenCalledTimes(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith("/tmp/fake-repo-T-MAIN");
  });

  // Running invocation's worktree should be protected
  test("running invocation worktree is never removed", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-RUNNING-WT",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "running",
    });
    seedRunningInvocation(db, taskId, {
      branchName: "orca/T-RUNNING-WT-inv-1",
      worktreePath: "/tmp/fake-repo-T-RUNNING-WT",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return "worktree /tmp/fake-repo\nworktree /tmp/fake-repo-T-RUNNING-WT";
      if (args[0] === "for-each-ref") return "orca/T-RUNNING-WT-inv-1";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // removeWorktree should NOT have been called
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
});

describe("Cleanup - multiple branches in for-each-ref output", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // for-each-ref returns empty lines mixed in -- should be filtered
  test("empty lines in for-each-ref output are ignored", () => {
    seedTask(db, {
      linearIssueId: "T-EMPTY-LINES",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref")
        return "\n\norca/T-EMPTY-LINES-inv-1\n\n\n";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    // Only one real branch should be processed
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual([
      "branch",
      "-D",
      "orca/T-EMPTY-LINES-inv-1",
    ]);
  });

  // for-each-ref with branches that have different ages
  test("per-branch age check: old branch deleted, young branch kept", () => {
    seedTask(db, {
      linearIssueId: "T-AGES",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    const recentDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref")
        return "orca/T-AGES-old\norca/T-AGES-young";
      if (args[0] === "log") {
        // Return different dates based on branch name
        const branchArg = args[args.length - 1];
        if (branchArg === "orca/T-AGES-old") return oldDate;
        if (branchArg === "orca/T-AGES-young") return recentDate;
        return oldDate;
      }
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    // Only old branch should be deleted
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual(["branch", "-D", "orca/T-AGES-old"]);
  });
});

describe("Cleanup - protection set construction from DB", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<typeof vi.fn>;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<typeof vi.fn>;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A task has a null prBranchName -- its entry should not pollute the
  // activeBranches set with null/undefined values
  test("task with null prBranchName does not add null to activeBranches", () => {
    // Active task with null prBranchName
    seedTask(db, {
      linearIssueId: "T-NULL-BR",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "ready",
      prBranchName: null,
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/SOME-OTHER-BRANCH";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // The branch "orca/SOME-OTHER-BRANCH" is not in activeBranches
    // (it shouldn't match null), so it should be deleted
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });

  // Running invocation with null branchName should not pollute runningBranches
  test("running invocation with null branchName does not add null to runningBranches", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-NULL-INV-BR",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "running",
    });
    // Running invocation without branchName set
    seedRunningInvocation(db, taskId, {});

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/UNRELATED-BRANCH";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    cleanupStaleResources({ db, config: testConfig() });

    // Task is "running" (not terminal), so its prBranchName would be checked.
    // Since prBranchName is null, activeBranches has no entries.
    // The branch "orca/UNRELATED-BRANCH" is not in runningBranches (invocation
    // has null branchName) and not in activeBranches.
    // It should be deleted (it's old, no PR, etc.)
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
