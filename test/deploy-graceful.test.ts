// ---------------------------------------------------------------------------
// deploy-graceful.test.ts
//
// Tests for deploy drain state — setDraining() and isDraining().
//
// triggerGracefulDeploy() was removed. deploy.sh now handles deploys directly
// by calling POST /api/deploy/drain, which sets the draining flag, then
// killing the old instance immediately (preserved worktrees handle resume).
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be at top level, before any imports of the mocked module)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeployModule = typeof import("../src/deploy.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deploy drain state", () => {
  let deployModule: DeployModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Re-apply mocks after module reset
    vi.mock("node:child_process", () => ({
      execFileSync: vi.fn(),
    }));
    vi.mock("node:fs", () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }));

    deployModule = await import("../src/deploy.js");
  });

  test("isDraining returns false initially", () => {
    expect(deployModule.isDraining()).toBe(false);
  });

  test("setDraining sets isDraining to true", () => {
    deployModule.setDraining();
    expect(deployModule.isDraining()).toBe(true);
  });

  test("setDraining is idempotent (second call is ignored)", () => {
    deployModule.setDraining();
    deployModule.setDraining(); // should not throw
    expect(deployModule.isDraining()).toBe(true);
  });

  test("initDeployState does not crash when git rev-parse fails", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("git not found");
    });

    expect(() => deployModule.initDeployState()).not.toThrow();
  });

  test("initDeployState does not crash when deploy-state.json has invalid JSON", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    vi.mocked(execFileSync).mockReturnValue("abc123\n");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new SyntaxError("bad json");
    });

    expect(() => deployModule.initDeployState()).not.toThrow();
  });
});
