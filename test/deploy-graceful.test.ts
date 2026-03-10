// ---------------------------------------------------------------------------
// deploy-graceful.test.ts
//
// Tests for triggerGracefulDeploy() — SHA dedup, cooldown, and drain logic.
//
// deploy.ts uses module-level state (draining, lastDeployTriggeredAt,
// startupSha). We use vi.resetModules() + dynamic import in beforeEach to
// get a fresh module instance for each test.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be at top level, before any imports of the mocked module)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock("../src/db/queries.js", () => ({
  countActiveSessions: vi.fn().mockReturnValue(0),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeployModule = typeof import("../src/deploy.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
  // Minimal OrcaDb stand-in — deploy.ts only uses it via countActiveSessions
  return {} as import("../src/db/index.js").OrcaDb;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("triggerGracefulDeploy", () => {
  let deployModule: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Re-apply mocks after module reset so the freshly imported module gets them
    vi.mock("node:child_process", () => ({
      execFileSync: vi.fn(),
      spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
    }));
    vi.mock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));
    vi.mock("../src/db/queries.js", () => ({
      countActiveSessions: vi.fn().mockReturnValue(0),
    }));

    deployModule = await import("../src/deploy.js");
  });

  // -------------------------------------------------------------------------
  // 1. SHA dedup: same SHA → skip deploy
  // -------------------------------------------------------------------------

  test("skips deploy when pushedSha matches current HEAD", async () => {
    const { execFileSync } = await import("node:child_process");
    const sha = "abc123def456abc123def456abc123def456abc1";

    // initDeployState() reads git HEAD — return the same SHA as pushed
    vi.mocked(execFileSync).mockReturnValue(sha + "\n");

    // existsSync returns false → no deploy-state.json
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    deployModule.initDeployState();

    const db = makeDb();
    deployModule.triggerGracefulDeploy(db, { pushSha: sha });

    expect(deployModule.isDraining()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Cooldown active: recent deployedAt → skip deploy
  // -------------------------------------------------------------------------

  test("skips deploy when cooldown is active (deployedAt 1 minute ago)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, readFileSync } = await import("node:fs");

    // initDeployState(): git returns a different SHA so SHA check won't skip
    vi.mocked(execFileSync).mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");

    // initDeployState(): deploy-state.json exists with recent deployedAt
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ deployedAt: oneMinuteAgo }),
    );

    deployModule.initDeployState();

    const db = makeDb();
    // Use a different SHA so SHA dedup doesn't trigger
    deployModule.triggerGracefulDeploy(db, {
      pushSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(deployModule.isDraining()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Cooldown expired: old deployedAt → proceed with deploy
  // -------------------------------------------------------------------------

  test("proceeds with deploy when cooldown has expired (deployedAt 20 minutes ago)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, readFileSync } = await import("node:fs");

    // initDeployState(): git returns SHA A
    vi.mocked(execFileSync).mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");

    // initDeployState(): deploy-state.json exists but deployedAt is 20 minutes ago
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ deployedAt: twentyMinutesAgo }),
    );

    deployModule.initDeployState();

    // Use fake timers so the poll setTimeout doesn't fire during the test
    vi.useFakeTimers();

    const db = makeDb();
    deployModule.triggerGracefulDeploy(db, {
      pushSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(deployModule.isDraining()).toBe(true);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 4. No deploy-state.json → proceed with deploy
  // -------------------------------------------------------------------------

  test("proceeds with deploy when deploy-state.json does not exist", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");

    // initDeployState(): git returns SHA A
    vi.mocked(execFileSync).mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");

    // initDeployState(): no deploy-state.json
    vi.mocked(existsSync).mockReturnValue(false);

    deployModule.initDeployState();

    vi.useFakeTimers();

    const db = makeDb();
    deployModule.triggerGracefulDeploy(db, {
      pushSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(deployModule.isDraining()).toBe(true);

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 5. git rev-parse fails → proceed with deploy
  // -------------------------------------------------------------------------

  test("proceeds with deploy when git rev-parse throws (startupSha is null)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");

    // initDeployState(): git fails → startupSha stays null
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("git not found");
    });

    // No deploy-state.json
    vi.mocked(existsSync).mockReturnValue(false);

    deployModule.initDeployState();

    vi.useFakeTimers();

    const db = makeDb();
    // Even with a SHA, null startupSha means the check is skipped → proceeds
    deployModule.triggerGracefulDeploy(db, {
      pushSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(deployModule.isDraining()).toBe(true);

    vi.useRealTimers();
  });
});
