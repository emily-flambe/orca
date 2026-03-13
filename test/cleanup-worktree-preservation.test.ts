// ---------------------------------------------------------------------------
// Adversarial tests for worktree preservation in active review states
// ---------------------------------------------------------------------------
//
// Tests that probe specific gaps and edge cases in the new worktree
// preservation feature for in_review, changes_requested, and awaiting_ci tasks.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDb, type OrcaDb } from "../src/db/index.js";
import {
  insertTask,
  insertInvocation,
  updateInvocation,
  getLastInvocationWithWorktree,
} from "../src/db/queries.js";
import type { TaskStatus } from "../src/db/schema.js";
import type { OrcaConfig } from "../src/config/index.js";

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

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(), // Mock rmSync so we can verify it's NOT called for preserved paths
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

// ---------------------------------------------------------------------------
// getLastInvocationWithWorktree unit tests
// ---------------------------------------------------------------------------

describe("getLastInvocationWithWorktree - query correctness", () => {
  let db: OrcaDb;

  beforeEach(() => {
    db = freshDb();
  });

  test("returns undefined when task has no invocations", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NO-INV" });
    const result = getLastInvocationWithWorktree(db, taskId);
    expect(result).toBeUndefined();
  });

  test("returns undefined when all invocations have null worktreePath", () => {
    const taskId = seedTask(db, { linearIssueId: "T-NULL-WT" });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
    });
    const result = getLastInvocationWithWorktree(db, taskId);
    expect(result).toBeUndefined();
  });

  test("returns the most recent invocation with a worktree path, not the first", () => {
    const taskId = seedTask(db, { linearIssueId: "T-MOST-RECENT" });

    // Older invocation - implement phase
    const invId1 = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId1, {
      worktreePath: "/tmp/fake-repo-T-MOST-RECENT-old",
      phase: "implement",
    });

    // Newer invocation - review phase (no worktree)
    insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });

    // Even newer invocation - fix phase with worktree
    const invId3 = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId3, {
      worktreePath: "/tmp/fake-repo-T-MOST-RECENT-new",
      phase: "fix",
    });

    const result = getLastInvocationWithWorktree(db, taskId);
    expect(result).toBeDefined();
    // Should return the newest worktree path (invId3), not the first (invId1)
    expect(result!.worktreePath).toBe("/tmp/fake-repo-T-MOST-RECENT-new");
    expect(result!.id).toBe(invId3);
  });

  test("picks correct task when multiple tasks exist", () => {
    const taskId1 = seedTask(db, { linearIssueId: "T-MULTI-A" });
    const taskId2 = seedTask(db, { linearIssueId: "T-MULTI-B" });

    const inv1 = insertInvocation(db, {
      linearIssueId: taskId1,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, inv1, { worktreePath: "/tmp/fake-repo-T-MULTI-A" });

    const inv2 = insertInvocation(db, {
      linearIssueId: taskId2,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, inv2, { worktreePath: "/tmp/fake-repo-T-MULTI-B" });

    const result1 = getLastInvocationWithWorktree(db, taskId1);
    const result2 = getLastInvocationWithWorktree(db, taskId2);

    expect(result1!.worktreePath).toBe("/tmp/fake-repo-T-MULTI-A");
    expect(result2!.worktreePath).toBe("/tmp/fake-repo-T-MULTI-B");
  });

  test("returns invocation regardless of status (completed, failed, running)", () => {
    // The query has NO status filter — it should return any status
    const taskId = seedTask(db, { linearIssueId: "T-ANY-STATUS" });

    const inv = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "failed",
    });
    updateInvocation(db, inv, { worktreePath: "/tmp/fake-repo-T-ANY-STATUS" });

    const result = getLastInvocationWithWorktree(db, taskId);
    expect(result).toBeDefined();
    expect(result!.worktreePath).toBe("/tmp/fake-repo-T-ANY-STATUS");
  });
});

// ---------------------------------------------------------------------------
// Orphan directory path: in_review task with unregistered worktree
//
// This is the critical gap: the existing cleanup tests only cover registered
// worktrees (the removeWorktree loop). The orphan readdirSync path is
// separately protected, but has no test for in_review tasks.
// ---------------------------------------------------------------------------

describe("Cleanup - orphan directory protection for active review states", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let rmSyncMock: ReturnType<typeof vi.fn>;
  let readdirSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();
    // Default: worktree list returns only main repo (no registered worktrees)
    // for-each-ref returns nothing (no orca branches)
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      // Return only the main repo in worktree list (no registered worktrees)
      if (args[0] === "worktree" && args[1] === "list")
        return "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n";
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
    removeWorktreeMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();
    listOpenPrBranchesMock.mockReturnValue(new Set());

    const fsMod = await import("node:fs");
    rmSyncMock = (fsMod as any).rmSync as unknown as ReturnType<typeof vi.fn>;
    rmSyncMock.mockReset();
    readdirSyncMock = fsMod.readdirSync as unknown as ReturnType<typeof vi.fn>;
    readdirSyncMock.mockReset();
    statSyncMock = fsMod.statSync as unknown as ReturnType<typeof vi.fn>;
    statSyncMock.mockReset();

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const status of [
    "in_review",
    "changes_requested",
    "awaiting_ci",
  ] as const) {
    test(`orphan directory for ${status} task is NOT deleted by rmSync`, () => {
      // Seed a task in an active review state
      const taskId = seedTask(db, {
        linearIssueId: `T-ORPHAN-${status}`,
        repoPath: "/tmp/fake-repo",
        orcaStatus: status,
      });

      // Create an invocation with a worktree path
      const invId = insertInvocation(db, {
        linearIssueId: taskId,
        startedAt: now(),
        status: "completed",
      });
      updateInvocation(db, invId, {
        worktreePath: `/tmp/fake-repo-T-ORPHAN-${status}`,
        phase: "implement",
      });

      // Simulate: readdirSync lists the orphan directory (NOT registered in git)
      // The worktree directory exists on disk but git doesn't know about it.
      readdirSyncMock.mockImplementation((dir: string) => {
        if (dir === "/tmp") {
          return [`fake-repo`, `fake-repo-T-ORPHAN-${status}`];
        }
        return [];
      });

      // statSync says it's a directory
      statSyncMock.mockReturnValue({
        isDirectory: () => true,
        mtimeMs: Date.now(),
      });

      cleanupStaleResources({ db, config: testConfig() });

      // The preserved worktree must NOT be deleted via rmSync
      expect(rmSyncMock).not.toHaveBeenCalledWith(
        expect.stringContaining(`fake-repo-T-ORPHAN-${status}`),
        expect.anything(),
      );
    });
  }

  test("orphan directory for done task IS deleted by rmSync", () => {
    // A done task's orphan worktree should be cleaned up
    const taskId = seedTask(db, {
      linearIssueId: "T-ORPHAN-DONE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "done",
    });

    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId, {
      worktreePath: "/tmp/fake-repo-T-ORPHAN-DONE",
      phase: "implement",
    });

    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir === "/tmp") {
        return ["fake-repo", "fake-repo-T-ORPHAN-DONE"];
      }
      return [];
    });

    statSyncMock.mockReturnValue({
      isDirectory: () => true,
      mtimeMs: Date.now(),
    });

    cleanupStaleResources({ db, config: testConfig() });

    // Done task's orphan directory SHOULD be deleted
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-ORPHAN-DONE"),
      expect.objectContaining({ recursive: true }),
    );
  });

  test("no invocation with worktree for in_review task — orphan directory IS deleted (no path to preserve)", () => {
    // If there's no invocation with a worktreePath, there's nothing to preserve.
    // An orphan directory that happens to match the naming pattern should be cleaned up.
    const taskId = seedTask(db, {
      linearIssueId: "T-NO-WT-INV",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });

    // Invocation with null worktreePath
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    // No worktreePath set — remains null

    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir === "/tmp") {
        return ["fake-repo", "fake-repo-T-NO-WT-INV"];
      }
      return [];
    });

    statSyncMock.mockReturnValue({
      isDirectory: () => true,
      mtimeMs: Date.now(),
    });

    cleanupStaleResources({ db, config: testConfig() });

    // Since no worktree path was recorded, nothing was added to preservedWorktreePaths.
    // The orphan directory should be deleted.
    expect(rmSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-NO-WT-INV"),
      expect.objectContaining({ recursive: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge case: multiple invocations — does preservation pick the newest?
// ---------------------------------------------------------------------------

describe("Cleanup - preservation uses the most recent worktree invocation", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
    removeWorktreeMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();
    listOpenPrBranchesMock.mockReturnValue(new Set());

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("with multiple invocations, only the newest worktree is preserved; old one can be deleted", () => {
    // Scenario: Task had an implement phase (inv1 with worktree A), then
    // a fix phase (inv2 with worktree B). Task is now in_review.
    // Only worktree B should be preserved; worktree A is stale.
    const taskId = seedTask(db, {
      linearIssueId: "T-MULTI-INV",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });

    const inv1 = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, inv1, {
      worktreePath: "/tmp/fake-repo-T-MULTI-INV-old",
      phase: "implement",
    });

    const inv2 = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, inv2, {
      worktreePath: "/tmp/fake-repo-T-MULTI-INV-new",
      phase: "fix",
    });

    // Make worktree list return BOTH registered worktrees
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return (
          "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree /tmp/fake-repo-T-MULTI-INV-old\nHEAD def456\nbranch refs/heads/orca/old\n\n" +
          "worktree /tmp/fake-repo-T-MULTI-INV-new\nHEAD ghi789\nbranch refs/heads/orca/new\n"
        );
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    // The NEW worktree must be preserved (it's the one returned by getLastInvocationWithWorktree)
    expect(removeWorktreeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-MULTI-INV-new"),
    );

    // The OLD worktree path from an earlier invocation is NOT in preservedWorktreePaths
    // (because getLastInvocationWithWorktree returns inv2, not inv1).
    // So the old worktree CAN be removed.
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-MULTI-INV-old"),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge case: Windows backslash paths in DB
// ---------------------------------------------------------------------------

describe("Cleanup - Windows path normalization for preserved in_review paths", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
    removeWorktreeMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();
    listOpenPrBranchesMock.mockReturnValue(new Set());

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("DB path with backslashes is matched against forward-slash git path (Windows)", () => {
    // On Windows, DB may store paths with backslashes.
    // git worktree list returns forward-slash paths.
    // normalizePath handles this by converting all \ to /.
    const taskId = seedTask(db, {
      linearIssueId: "T-WIN-PATH",
      // Use a Unix-style path for the repo
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });

    const inv = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    // Store Windows-style backslash path in DB (as would happen on Windows)
    updateInvocation(db, inv, {
      // Simulate a Windows path stored in DB
      worktreePath: "C:\\Users\\emily\\fake-repo-T-WIN-PATH",
      phase: "implement",
    });

    // git returns the same path in forward-slash format (as git does on Windows)
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return (
          "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree C:/Users/emily/fake-repo-T-WIN-PATH\nHEAD def456\nbranch refs/heads/orca/T-WIN-PATH-inv-1\n"
        );
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    // The worktree with backslash DB path should still match the forward-slash git path
    // and be protected from removal
    expect(removeWorktreeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-WIN-PATH"),
    );
  });

  test("case-insensitive path matching protects in_review worktree on Windows", () => {
    // Git on Windows may return paths with different casing than what's stored in DB.
    const taskId = seedTask(db, {
      linearIssueId: "T-CASE",
      repoPath: "/tmp/Fake-Repo", // mixed case repo path
      orcaStatus: "in_review",
    });

    const inv = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    // DB stored with one casing
    updateInvocation(db, inv, {
      worktreePath: "/tmp/Fake-Repo-T-CASE",
      phase: "implement",
    });

    // git returns with lowercase casing (git on Windows can do this)
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return (
          "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree /tmp/fake-repo-t-case\nHEAD def456\nbranch refs/heads/orca/T-CASE\n"
        );
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    cleanupStaleResources({ db, config: testConfig() });

    // Despite case mismatch, the worktree should be protected
    expect(removeWorktreeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-t-case"),
    );
  });
});

// ---------------------------------------------------------------------------
// Drain mode: cleanupStaleResources is skipped during deploy drain
// ---------------------------------------------------------------------------

describe("Cleanup - drain mode skips cleanup to protect active worktrees", () => {
  let db: OrcaDb;
  let gitMock: ReturnType<typeof vi.fn>;
  let removeWorktreeMock: ReturnType<typeof vi.fn>;
  let rmSyncMock: ReturnType<typeof vi.fn>;
  let readdirSyncMock: ReturnType<typeof vi.fn>;
  let statSyncMock: ReturnType<typeof vi.fn>;
  let listOpenPrBranchesMock: ReturnType<typeof vi.fn>;
  let isDrainingMock: ReturnType<typeof vi.fn>;
  let cleanupStaleResources: typeof import("../src/cleanup/index.js").cleanupStaleResources;

  beforeEach(async () => {
    db = freshDb();
    vi.spyOn(console, "log").mockImplementation(() => {});

    const gitMod = await import("../src/git.js");
    gitMock = gitMod.git as unknown as ReturnType<typeof vi.fn>;
    gitMock.mockReset();
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n";
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    const wtMod = await import("../src/worktree/index.js");
    removeWorktreeMock = wtMod.removeWorktree as unknown as ReturnType<
      typeof vi.fn
    >;
    removeWorktreeMock.mockReset();

    const ghMod = await import("../src/github/index.js");
    listOpenPrBranchesMock = ghMod.listOpenPrBranches as unknown as ReturnType<
      typeof vi.fn
    >;
    listOpenPrBranchesMock.mockReset();
    listOpenPrBranchesMock.mockReturnValue(new Set());

    const fsMod = await import("node:fs");
    rmSyncMock = (fsMod as any).rmSync as unknown as ReturnType<typeof vi.fn>;
    rmSyncMock.mockReset();
    readdirSyncMock = fsMod.readdirSync as unknown as ReturnType<typeof vi.fn>;
    readdirSyncMock.mockReset();
    statSyncMock = fsMod.statSync as unknown as ReturnType<typeof vi.fn>;
    statSyncMock.mockReset();

    const deployMod = await import("../src/deploy.js");
    isDrainingMock = deployMod.isDraining as unknown as ReturnType<
      typeof vi.fn
    >;
    isDrainingMock.mockReset();
    isDrainingMock.mockReturnValue(false); // default: not draining

    const cleanupMod = await import("../src/cleanup/index.js");
    cleanupStaleResources = cleanupMod.cleanupStaleResources;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("during drain, cleanupStaleResources exits early without touching any worktrees", () => {
    // Seed a task in in_review with a worktree
    const taskId = seedTask(db, {
      linearIssueId: "T-DRAIN-REVIEW",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId, {
      worktreePath: "/tmp/fake-repo-T-DRAIN-REVIEW",
      phase: "implement",
    });

    // Simulate drain mode active
    isDrainingMock.mockReturnValue(true);

    cleanupStaleResources({ db, config: testConfig() });

    // Nothing should be removed — cleanup returned early
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
    // git should not have been called at all (early return before any git ops)
    expect(gitMock).not.toHaveBeenCalled();
  });

  test("after drain ends, in_review task worktree is preserved (not deleted)", () => {
    // Seed a task in in_review with a registered worktree
    const taskId = seedTask(db, {
      linearIssueId: "T-POST-DRAIN",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId, {
      worktreePath: "/tmp/fake-repo-T-POST-DRAIN",
      phase: "implement",
    });

    // Make git worktree list return the in_review task's worktree as registered
    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return (
          "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree /tmp/fake-repo-T-POST-DRAIN\nHEAD def456\nbranch refs/heads/orca/T-POST-DRAIN-inv-1\n"
        );
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    // Drain has ended — isDraining() returns false
    isDrainingMock.mockReturnValue(false);

    cleanupStaleResources({ db, config: testConfig() });

    // The in_review task's worktree must NOT be removed
    expect(removeWorktreeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-POST-DRAIN"),
    );
  });

  test("drain mode: tasks in changes_requested and awaiting_ci are also protected", () => {
    for (const status of [
      "changes_requested",
      "awaiting_ci",
    ] as const) {
      const taskId = seedTask(db, {
        linearIssueId: `T-DRAIN-${status}`,
        repoPath: "/tmp/fake-repo",
        orcaStatus: status,
      });
      const invId = insertInvocation(db, {
        linearIssueId: taskId,
        startedAt: now(),
        status: "completed",
      });
      updateInvocation(db, invId, {
        worktreePath: `/tmp/fake-repo-T-DRAIN-${status}`,
        phase: "fix",
      });
    }

    isDrainingMock.mockReturnValue(true);

    cleanupStaleResources({ db, config: testConfig() });

    // Early return during drain — no removals of any kind
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  test("full drain cycle: cleanup skipped during drain, in_review worktree preserved after drain ends", () => {
    // Seed an in_review task with a registered worktree
    const taskId = seedTask(db, {
      linearIssueId: "T-FULL-CYCLE",
      repoPath: "/tmp/fake-repo",
      orcaStatus: "in_review",
    });
    const invId = insertInvocation(db, {
      linearIssueId: taskId,
      startedAt: now(),
      status: "completed",
    });
    updateInvocation(db, invId, {
      worktreePath: "/tmp/fake-repo-T-FULL-CYCLE",
      phase: "implement",
    });

    gitMock.mockImplementation((args: string[]) => {
      if (args[0] === "worktree" && args[1] === "prune") return "";
      if (args[0] === "worktree" && args[1] === "list")
        return (
          "worktree /tmp/fake-repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
          "worktree /tmp/fake-repo-T-FULL-CYCLE\nHEAD def456\nbranch refs/heads/orca/T-FULL-CYCLE-inv-1\n"
        );
      if (args[0] === "for-each-ref") return "";
      return "";
    });

    // Phase 1: setDraining() → isDraining() returns true
    isDrainingMock.mockReturnValue(true);
    cleanupStaleResources({ db, config: testConfig() });

    // During drain: cleanup exits early — no git calls, no removals
    expect(gitMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(rmSyncMock).not.toHaveBeenCalled();

    // Phase 2: Drain ends → isDraining() returns false
    isDrainingMock.mockReturnValue(false);
    cleanupStaleResources({ db, config: testConfig() });

    // After drain: in_review worktree must still be preserved (not removed)
    expect(removeWorktreeMock).not.toHaveBeenCalledWith(
      expect.stringContaining("fake-repo-T-FULL-CYCLE"),
    );
  });
});
