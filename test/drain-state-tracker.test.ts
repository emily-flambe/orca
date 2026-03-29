// ---------------------------------------------------------------------------
// drain-state-tracker.test.ts — adversarial tests for trackDrainState()
// ---------------------------------------------------------------------------
//
// trackDrainState() is the file-based persistent drain tracking function in
// src/scheduler/drain-state-tracker.ts. It was added in EMI-348 with zero
// test coverage. These tests attack every branch.
//
// Note: This file is intentionally separate from drain-timeout.test.ts because
// that file has a top-level vi.mock("node:fs/promises") that would interfere
// with the real filesystem operations these tests rely on.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  trackDrainState,
  type DrainTrackingState,
} from "../src/scheduler/drain-state-tracker.js";
import { _getAlertCooldowns } from "../src/scheduler/alerts.js";
import { createDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps() {
  const db = createDb(":memory:");
  const config: OrcaConfig = {
    defaultCwd: "/tmp/test",
    concurrencyCap: 1,
    agentConcurrencyCap: 12,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 50,
    implementSystemPrompt: "",
    reviewSystemPrompt: "",
    fixSystemPrompt: "",
    maxReviewCycles: 3,
    reviewMaxTurns: 30,
    disallowedTools: "",
    model: "sonnet",
    reviewModel: "haiku",
    deployStrategy: "none",
    maxDeployPollAttempts: 60,
    maxCiPollAttempts: 240,
    drainTimeoutMin: 10,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-webhook-secret",
    linearProjectIds: ["proj-1"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    projectRepoMap: new Map(),
    githubMcpPat: undefined,
    worktreePoolSize: 0,
  };
  return {
    db,
    config,
    graph: {
      isDispatchable: vi.fn().mockReturnValue(true),
      computeEffectivePriority: vi.fn(),
      rebuild: vi.fn(),
    } as any,
    client: {
      createComment: vi.fn().mockResolvedValue(undefined),
      createAttachment: vi.fn().mockResolvedValue(undefined),
    } as any,
    stateMap: new Map(),
  };
}

async function readState(filePath: string): Promise<DrainTrackingState> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as DrainTrackingState;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let tmpFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-drain-track-"));
  tmpFile = path.join(tmpDir, "drain-state-tracking.json");
  _getAlertCooldowns().clear();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: non-stuck scenarios (isDraining=false or activeSessions > 0)
// ---------------------------------------------------------------------------

describe("trackDrainState — not stuck", () => {
  test("not draining + no state file: file is not created", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, false, 0, tmpFile);
    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("not draining with activeSessions=0 still does not create file (isDraining gates)", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, false, 0, tmpFile);
    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("not draining + existing stale file: deletes the file", async () => {
    const staleState: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 3,
      firstSeenAt: new Date().toISOString(),
    };
    await fs.writeFile(tmpFile, JSON.stringify(staleState), "utf8");

    const deps = makeDeps();
    await trackDrainState(deps, false, 0, tmpFile);

    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("draining with activeSessions=1: not stuck — deletes existing file", async () => {
    const staleState: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 2,
      firstSeenAt: new Date().toISOString(),
    };
    await fs.writeFile(tmpFile, JSON.stringify(staleState), "utf8");

    const deps = makeDeps();
    // isDraining=true but activeSessions=1 means drain is progressing (sessions still running)
    await trackDrainState(deps, true, 1, tmpFile);

    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("draining with activeSessions=5: not stuck — no file created", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 5, tmpFile);
    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("not draining: no alert fires regardless of previous state", async () => {
    const staleState: DrainTrackingState = {
      consecutiveZeroSessionSnapshots: 100,
      firstSeenAt: new Date().toISOString(),
    };
    await fs.writeFile(tmpFile, JSON.stringify(staleState), "utf8");

    const deps = makeDeps();
    await trackDrainState(deps, false, 0, tmpFile);

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    expect(getRecentSystemEvents(deps.db).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: stuck scenarios (isDraining=true AND activeSessions=0)
// ---------------------------------------------------------------------------

describe("trackDrainState — stuck drain", () => {
  test("first stuck snapshot: creates file with count=1", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);

    expect(await fileExists(tmpFile)).toBe(true);
    const state = await readState(tmpFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(1);
  });

  test("first stuck snapshot: firstSeenAt is a valid ISO timestamp", async () => {
    const deps = makeDeps();
    const before = new Date();
    await trackDrainState(deps, true, 0, tmpFile);
    const after = new Date();

    const state = await readState(tmpFile);
    const seenAt = new Date(state.firstSeenAt);
    expect(seenAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(seenAt.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
  });

  test("second consecutive stuck snapshot: count=2", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);

    const state = await readState(tmpFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(2);
  });

  test("third consecutive stuck snapshot: count=3", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);

    const state = await readState(tmpFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(3);
  });

  test("firstSeenAt is preserved across consecutive stuck snapshots", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    const firstState = await readState(tmpFile);
    const firstSeenAt = firstState.firstSeenAt;

    await trackDrainState(deps, true, 0, tmpFile);
    const secondState = await readState(tmpFile);

    expect(secondState.firstSeenAt).toBe(firstSeenAt);
  });

  test("no alert fires on first stuck snapshot (count=1 is below threshold of 2)", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    expect(getRecentSystemEvents(deps.db).length).toBe(0);
  });

  test("alert fires on second consecutive stuck snapshot (count=2 >= threshold)", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile); // count=1
    await trackDrainState(deps, true, 0, tmpFile); // count=2 — alert fires

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    expect(getRecentSystemEvents(deps.db).length).toBeGreaterThan(0);
  });

  test("alert message includes consecutive snapshot count and duration", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    const events = getRecentSystemEvents(deps.db);
    expect(events.length).toBeGreaterThan(0);
    const event = events[0]!;
    // The event message should reference the drain state
    expect(event.message).toContain("Stuck Drain State");
  });

  test("alert is throttled by 30-minute cooldown: third snapshot does not re-fire", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile); // count=1
    await trackDrainState(deps, true, 0, tmpFile); // count=2, alert fires
    await trackDrainState(deps, true, 0, tmpFile); // count=3, cooldown suppresses alert

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    // Only 1 alert should have fired (the 2nd snapshot trigger)
    expect(getRecentSystemEvents(deps.db).length).toBe(1);
  });

  test("clearing cooldown allows alert to fire again on next snapshot", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile); // alert fires

    _getAlertCooldowns().clear(); // simulate cooldown expiry

    await trackDrainState(deps, true, 0, tmpFile); // alert fires again

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    expect(getRecentSystemEvents(deps.db).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: drain recovery (stuck → not stuck transitions)
// ---------------------------------------------------------------------------

describe("trackDrainState — stuck then cleared", () => {
  test("stuck 2 times then sessions resume: file is deleted", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile); // count=1
    await trackDrainState(deps, true, 0, tmpFile); // count=2

    expect(await fileExists(tmpFile)).toBe(true);

    await trackDrainState(deps, true, 1, tmpFile); // sessions active — not stuck

    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("stuck 2 times then drain clears: file is deleted", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);

    await trackDrainState(deps, false, 0, tmpFile); // isDraining=false

    expect(await fileExists(tmpFile)).toBe(false);
  });

  test("after recovery, next stuck cycle starts fresh at count=1", async () => {
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);
    await trackDrainState(deps, true, 0, tmpFile);

    // Recovery
    await trackDrainState(deps, true, 1, tmpFile);

    // New stuck cycle
    await trackDrainState(deps, true, 0, tmpFile);

    const state = await readState(tmpFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: resilience / error handling
// ---------------------------------------------------------------------------

describe("trackDrainState — error handling", () => {
  test("never throws when state file does not exist (ENOENT)", async () => {
    const deps = makeDeps();
    const nonExistent = path.join(tmpDir, "no-such-file.json");
    await expect(
      trackDrainState(deps, true, 0, nonExistent),
    ).resolves.toBeUndefined();
  });

  test("never throws when state file contains invalid JSON", async () => {
    await fs.writeFile(tmpFile, "INVALID JSON {{{", "utf8");
    const deps = makeDeps();
    await expect(
      trackDrainState(deps, true, 0, tmpFile),
    ).resolves.toBeUndefined();
  });

  test("after invalid JSON: state resets to count=1 (lost state treated as first snapshot)", async () => {
    await fs.writeFile(tmpFile, "CORRUPT DATA", "utf8");
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);

    const state = await readState(tmpFile);
    // State lost — starts fresh at 1
    expect(state.consecutiveZeroSessionSnapshots).toBe(1);
  });

  test("after invalid JSON: no alert fires (count=1 is below threshold)", async () => {
    await fs.writeFile(tmpFile, "BAD JSON", "utf8");
    const deps = makeDeps();
    await trackDrainState(deps, true, 0, tmpFile);

    const { getRecentSystemEvents } = await import("../src/db/queries.js");
    expect(getRecentSystemEvents(deps.db).length).toBe(0);
  });

  test("never throws even if called with activeSessions=0 and isDraining=false simultaneously", async () => {
    const deps = makeDeps();
    await expect(
      trackDrainState(deps, false, 0, tmpFile),
    ).resolves.toBeUndefined();
  });

  test("directory is created if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "deep", "nested");
    const nestedFile = path.join(nestedDir, "drain-state.json");
    const deps = makeDeps();

    await expect(
      trackDrainState(deps, true, 0, nestedFile),
    ).resolves.toBeUndefined();

    expect(await fileExists(nestedFile)).toBe(true);
  });
});
