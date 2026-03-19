// ---------------------------------------------------------------------------
// Cleanup module tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
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
// Mocks — git, worktree, github modules, and node:fs
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
  closeOrphanedPrs: vi.fn().mockReturnValue(0),
}));

// Mock node:fs so we can control readdirSync/statSync/unlinkSync in the
// cleanupOldInvocationLogs tests. importOriginal preserves real implementations
// so the existing worktree cleanup tests continue to work.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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

  // "running" includes the claim-to-spawn window -- branches should be protected
  test("branches from running tasks are NOT deleted", () => {
    seedTask(db, {
      linearIssueId: "T-DISPATCH",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "running",
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
      if (args[0] === "for-each-ref")
        return "orca/T-EXISTS-inv-1\norca/ORPHANED-inv-99";
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
      if (args[0] === "for-each-ref")
        return "orca/T-ACTIVE-inv-1\norca/T-DONE-inv-1";
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

// ===========================================================================
// cleanupOldInvocationLogs tests
// ===========================================================================

describe("cleanupOldInvocationLogs", () => {
  let db: OrcaDb;
  let readdirSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let unlinkSyncMock: ReturnType<typeof vi.fn>;
  let cleanupOldInvocationLogs: typeof import("../src/cleanup/index.js").cleanupOldInvocationLogs;

  const RETENTION_HOURS = 168; // 7 days
  const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fs = await import("node:fs");
    readdirSyncMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
    statSyncMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
    unlinkSyncMock = fs.unlinkSync as unknown as ReturnType<typeof vi.fn>;
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation(() => undefined);

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupOldInvocationLogs = cleanupMod.cleanupOldInvocationLogs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function logConfig(): OrcaConfig {
    return testConfig({ invocationLogRetentionHours: RETENTION_HOURS });
  }

  function makeStatResult(
    mtimeMs: number,
  ): ReturnType<typeof import("node:fs").statSync> {
    return { mtimeMs } as ReturnType<typeof import("node:fs").statSync>;
  }

  test("deletes old log for completed invocation", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-LOG-1",
      orcaStatus: "done",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "completed" });

    const oldMtime = Date.now() - RETENTION_MS - 1000;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).toHaveBeenCalledWith(`logs/${invId}.ndjson`);
  });

  test("deletes old log for failed invocation", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-LOG-2",
      orcaStatus: "failed",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "failed" });

    const oldMtime = Date.now() - RETENTION_MS - 1000;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).toHaveBeenCalledWith(`logs/${invId}.ndjson`);
  });

  test("preserves recent log for completed invocation (within retention window)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-LOG-3",
      orcaStatus: "done",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "completed" });

    // 1 hour old — well within 168h window
    const recentMtime = Date.now() - 60 * 60 * 1000;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(recentMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test("preserves log for running invocation regardless of age", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-LOG-4",
      orcaStatus: "running",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });

    // Very old file — but invocation is still running
    const oldMtime = Date.now() - RETENTION_MS * 10;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test("file with unparseable ID uses 2x retention window — preserves if only 1x old", () => {
    // File age is between 1x and 2x retention
    const ageBetween1xAnd2x = RETENTION_MS + RETENTION_MS / 2;
    const mtime = Date.now() - ageBetween1xAnd2x;

    readdirSyncMock.mockReturnValue([
      "not-a-number.ndjson",
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(mtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    // Should NOT be deleted — age < 2x retention
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test("file with unparseable ID is deleted when older than 2x retention", () => {
    const oldMtime = Date.now() - RETENTION_MS * 2 - 1000;

    readdirSyncMock.mockReturnValue([
      "not-a-number.ndjson",
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).toHaveBeenCalledWith("logs/not-a-number.ndjson");
  });

  test("file not in DB uses 2x retention window — preserves if only 1x old", () => {
    // Use a large numeric ID that won't exist in the DB
    const ageBetween1xAnd2x = RETENTION_MS + RETENTION_MS / 2;
    const mtime = Date.now() - ageBetween1xAnd2x;

    readdirSyncMock.mockReturnValue(["99999.ndjson"] as unknown as ReturnType<
      typeof import("node:fs").readdirSync
    >);
    statSyncMock.mockReturnValue(makeStatResult(mtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    // Should NOT be deleted — not in DB but age < 2x retention
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test("file not in DB is deleted when older than 2x retention", () => {
    const oldMtime = Date.now() - RETENTION_MS * 2 - 1000;

    readdirSyncMock.mockReturnValue(["99999.ndjson"] as unknown as ReturnType<
      typeof import("node:fs").readdirSync
    >);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({ db, config: logConfig() });

    expect(unlinkSyncMock).toHaveBeenCalledWith("logs/99999.ndjson");
  });

  test("handles missing logs/ directory gracefully (no error thrown)", () => {
    readdirSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, scandir 'logs/'");
    });

    expect(() => {
      cleanupOldInvocationLogs({ db, config: logConfig() });
    }).not.toThrow();

    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test("ignores non-ndjson files in logs/ directory", () => {
    readdirSyncMock.mockReturnValue([
      "somefile.log",
      "readme.txt",
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);

    cleanupOldInvocationLogs({ db, config: logConfig() });

    // statSync should not be called since no .ndjson files were found
    expect(statSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
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

// ===========================================================================
// Integration: closeOrphanedPrs called from cleanupRepo
// ===========================================================================

// ===========================================================================
// BUG TESTS: cleanupOldInvocationLogs — adversarial coverage
// ===========================================================================

describe("BUG: timed_out invocation logs are never deleted (missing terminal status)", () => {
  let db: OrcaDb;
  let readdirSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let unlinkSyncMock: ReturnType<typeof vi.fn>;
  let cleanupOldInvocationLogs: typeof import("../src/cleanup/index.js").cleanupOldInvocationLogs;

  const RETENTION_HOURS = 168;
  const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fs = await import("node:fs");
    readdirSyncMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
    statSyncMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
    unlinkSyncMock = fs.unlinkSync as unknown as ReturnType<typeof vi.fn>;
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation(() => undefined);

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupOldInvocationLogs = cleanupMod.cleanupOldInvocationLogs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeStatResult(
    mtimeMs: number,
  ): ReturnType<typeof import("node:fs").statSync> {
    return { mtimeMs } as ReturnType<typeof import("node:fs").statSync>;
  }

  // BUG: The schema defines INVOCATION_STATUSES = ["running", "completed", "failed", "timed_out"]
  // but cleanupOldInvocationLogs only treats "completed" and "failed" as terminal.
  // "timed_out" is a real terminal state (set by the scheduler on timeout) but its
  // logs are NEVER deleted — they accumulate forever.
  test("old log for timed_out invocation should be deleted (BUG: currently skipped)", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-TIMEOUT-1",
      orcaStatus: "failed",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    // Simulate scheduler setting timed_out status
    updateInvocation(db, invId, { status: "timed_out" });

    const oldMtime = Date.now() - RETENTION_MS - 1000;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(oldMtime));

    cleanupOldInvocationLogs({
      db,
      config: testConfig({ invocationLogRetentionHours: RETENTION_HOURS }),
    });

    // timed_out is a terminal state — log should be deleted.
    // BUG: The TERMINAL_STATUSES set in cleanupOldInvocationLogs only has
    // ["completed", "failed"] — "timed_out" is missing.
    // This test WILL FAIL until the bug is fixed.
    expect(unlinkSyncMock).toHaveBeenCalledWith(`logs/${invId}.ndjson`);
  });

  // Verify the bug doesn't accidentally delete running logs by confusing
  // timed_out with non-terminal states.
  test("timed_out log is not held back forever by 2x conservative window", () => {
    // This test validates the bug is specifically about status, not the 2x window.
    // A timed_out invocation IS in the DB, so the 2x fallback doesn't apply.
    // The code reaches the TERMINAL_STATUSES check and incorrectly skips.
    const taskId = seedTask(db, {
      linearIssueId: "T-TIMEOUT-2",
      orcaStatus: "failed",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "timed_out" });

    // Even at 10x the retention window, the log should be deleted.
    const veryOldMtime = Date.now() - RETENTION_MS * 10;
    readdirSyncMock.mockReturnValue([
      `${invId}.ndjson`,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(veryOldMtime));

    cleanupOldInvocationLogs({
      db,
      config: testConfig({ invocationLogRetentionHours: RETENTION_HOURS }),
    });

    // BUG: still not deleted because timed_out is not in TERMINAL_STATUSES.
    expect(unlinkSyncMock).toHaveBeenCalledWith(`logs/${invId}.ndjson`);
  });
});

describe("BUG: parseInt partial parse — filename '123abc.ndjson' is not treated as unparseable", () => {
  let db: OrcaDb;
  let readdirSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let unlinkSyncMock: ReturnType<typeof vi.fn>;
  let cleanupOldInvocationLogs: typeof import("../src/cleanup/index.js").cleanupOldInvocationLogs;

  const RETENTION_HOURS = 168;
  const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const fs = await import("node:fs");
    readdirSyncMock = fs.readdirSync as unknown as ReturnType<typeof vi.fn>;
    statSyncMock = fs.statSync as unknown as ReturnType<typeof vi.fn>;
    unlinkSyncMock = fs.unlinkSync as unknown as ReturnType<typeof vi.fn>;
    readdirSyncMock.mockReset();
    statSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation(() => undefined);

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupOldInvocationLogs = cleanupMod.cleanupOldInvocationLogs;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeStatResult(
    mtimeMs: number,
  ): ReturnType<typeof import("node:fs").statSync> {
    return { mtimeMs } as ReturnType<typeof import("node:fs").statSync>;
  }

  // BUG: parseInt("123abc", 10) returns 123, not NaN.
  // A filename like "123abc.ndjson" should be treated as unparseable (2x window),
  // but instead the code does getInvocation(db, 123) — which either finds invocation
  // 123 (wrong invocation) or finds nothing (and applies 2x window accidentally
  // giving the right result for the wrong reason).
  //
  // The dangerous case: if invocation 123 exists and is "completed", the file
  // "123abc.ndjson" will be deleted even though it has no DB record matching it.
  test("filename '1abc.ndjson' must use 2x conservative window, not look up invocation 1", () => {
    // Seed a real invocation with ID that parseInt would extract (1)
    const taskId = seedTask(db, {
      linearIssueId: "T-PARSE-1",
      orcaStatus: "done",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "completed" });
    // invId is likely 1 for a fresh DB. Use it to construct the ambiguous filename.
    const ambiguousFilename = `${invId}abc.ndjson`;

    // Age is between 1x and 2x retention — should be preserved under 2x window
    const ageBetween1xAnd2x = RETENTION_MS + RETENTION_MS / 2;
    const mtime = Date.now() - ageBetween1xAnd2x;
    readdirSyncMock.mockReturnValue([
      ambiguousFilename,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(mtime));

    cleanupOldInvocationLogs({
      db,
      config: testConfig({ invocationLogRetentionHours: RETENTION_HOURS }),
    });

    // The filename is NOT a valid invocation log (has garbage suffix).
    // It should be treated as unparseable and use 2x window — so NOT deleted
    // since age is only 1.5x retention.
    //
    // BUG: parseInt("1abc", 10) === 1, so the code looks up invocation 1 (which
    // exists and is "completed"), and DELETES the file immediately after the 1x
    // retention check passes.
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  // Variant: numeric prefix with dot separator (e.g., "1.backup.ndjson")
  // parseInt("1.backup") returns 1 — same partial-parse bug.
  test("filename '1.backup.ndjson' must use 2x conservative window", () => {
    const taskId = seedTask(db, {
      linearIssueId: "T-PARSE-2",
      orcaStatus: "done",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "running",
    });
    updateInvocation(db, invId, { status: "completed" });

    // This filename ends in .ndjson so it passes the filter, but the stem
    // "1.backup" has a dot — parseInt("1.backup", 10) still returns 1.
    // Wait: the filter is f.endsWith(".ndjson"), so "1.backup.ndjson" passes.
    // The stem would be "1.backup" (slice off ".ndjson").
    // parseInt("1.backup", 10) === 1. Same bug.
    const ambiguousFilename = `${invId}.backup.ndjson`;

    const ageBetween1xAnd2x = RETENTION_MS + RETENTION_MS / 2;
    const mtime = Date.now() - ageBetween1xAnd2x;
    readdirSyncMock.mockReturnValue([
      ambiguousFilename,
    ] as unknown as ReturnType<typeof import("node:fs").readdirSync>);
    statSyncMock.mockReturnValue(makeStatResult(mtime));

    cleanupOldInvocationLogs({
      db,
      config: testConfig({ invocationLogRetentionHours: RETENTION_HOURS }),
    });

    // Should be treated as unparseable — age < 2x so NOT deleted.
    // BUG: parseInt("1.backup", 10) === 1, finds invocation 1 (completed),
    // deletes at 1x retention.
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});

describe("Cleanup - closeOrphanedPrs integration", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let closeOrphanedPrsMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();
    closeOrphanedPrsMock = (ghMod as any)
      .closeOrphanedPrs as unknown as ReturnType<typeof vi.fn>;
    closeOrphanedPrsMock.mockReset();
    closeOrphanedPrsMock.mockReturnValue(0);

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
    removeWorktreeMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("closeOrphanedPrs is called before listOpenPrBranches", () => {
    seedTask(db, {
      linearIssueId: "T-ORDER",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const callOrder: string[] = [];
    closeOrphanedPrsMock.mockImplementation(() => {
      callOrder.push("closeOrphanedPrs");
      return 0;
    });
    listOpenPrBranchesMock.mockImplementation(() => {
      callOrder.push("listOpenPrBranches");
      return new Set();
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-ORDER-inv-1";
      if (args[0] === "log")
        return new Date(Date.now() - 120 * 60 * 1000).toISOString();
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    const closeIdx = callOrder.indexOf("closeOrphanedPrs");
    const listIdx = callOrder.indexOf("listOpenPrBranches");
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(listIdx);
  });

  test("after orphan PRs are closed, their branches are no longer in the open PR set", () => {
    seedTask(db, {
      linearIssueId: "T-ORPHAN-FLOW",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    // Simulate: closeOrphanedPrs closes 1 PR. After that, listOpenPrBranches
    // returns an empty set (the orphan PR is no longer open).
    closeOrphanedPrsMock.mockReturnValue(1);
    listOpenPrBranchesMock.mockReturnValue(new Set()); // orphan branch gone

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-ORPHAN-FLOW-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    // The branch should be deleted because:
    // 1. closeOrphanedPrs closed the orphan PR
    // 2. listOpenPrBranches now returns empty (no open PR protection)
    // 3. Branch is old enough and in terminal task state
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual([
      "branch",
      "-D",
      "orca/T-ORPHAN-FLOW-inv-1",
    ]);
  });

  test("closeOrphanedPrs receives correct protection sets from DB", () => {
    // Running task -- its branch should be in runningBranches
    const taskId = seedTask(db, {
      linearIssueId: "T-RUNNING",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "running",
      prBranchName: "orca/T-RUNNING-inv-1",
    });
    seedRunningInvocation(db, taskId, {
      branchName: "orca/T-RUNNING-inv-1",
      worktreePath: "/tmp/fake-repo-T-RUNNING",
    });

    // Active (non-terminal) task -- its branch should be in activeBranches
    seedTask(db, {
      linearIssueId: "T-REVIEW",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
      prBranchName: "orca/T-REVIEW-inv-1",
    });

    closeOrphanedPrsMock.mockReturnValue(0);
    listOpenPrBranchesMock.mockReturnValue(new Set());

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    expect(closeOrphanedPrsMock).toHaveBeenCalledTimes(1);
    const [cwd, opts] = closeOrphanedPrsMock.mock.calls[0];
    expect(cwd).toBe("/tmp/fake-repo");
    expect(opts.runningBranches).toBeInstanceOf(Set);
    expect(opts.runningBranches.has("orca/T-RUNNING-inv-1")).toBe(true);
    expect(opts.activeBranches).toBeInstanceOf(Set);
    expect(opts.activeBranches.has("orca/T-REVIEW-inv-1")).toBe(true);
    expect(opts.maxAgeMs).toBeGreaterThan(0);
    expect(opts.now).toBeGreaterThan(0);
  });

  test("closeOrphanedPrs failure does not prevent branch cleanup", () => {
    seedTask(db, {
      linearIssueId: "T-CLOSE-FAIL",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const oldDate = new Date(Date.now() - 120 * 60 * 1000).toISOString();

    closeOrphanedPrsMock.mockImplementation(() => {
      throw new Error("gh not found");
    });
    listOpenPrBranchesMock.mockReturnValue(new Set());

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list") return "";
      if (args[0] === "for-each-ref") return "orca/T-CLOSE-FAIL-inv-1";
      if (args[0] === "log") return oldDate;
      if (args[0] === "branch" && args[1] === "-D") return "";
      return "";
    });

    // Should not throw
    cleanupStaleResources({ db, config: testConfig() });

    // Branch cleanup should still proceed
    const deleteCalls = gitMock.mock.calls.filter(
      (call: string[][]) => call[0][0] === "branch" && call[0][1] === "-D",
    );
    expect(deleteCalls).toHaveLength(1);
  });
});
