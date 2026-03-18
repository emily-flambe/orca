// ---------------------------------------------------------------------------
// drain-monitor.test.ts — adversarial tests for checkDrainTimeout
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createDb, type OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level
// ---------------------------------------------------------------------------

const mockIsDraining = vi.fn<() => boolean>();
const mockGetDrainingForSeconds = vi.fn<() => number | null>();
const mockClearDraining = vi.fn<() => void>();

vi.mock("../src/deploy.js", () => ({
  isDraining: mockIsDraining,
  getDrainingForSeconds: mockGetDrainingForSeconds,
  clearDraining: mockClearDraining,
}));

const mockActiveHandles = new Map<number, unknown>();
vi.mock("../src/session-handles.js", () => ({
  get activeHandles() {
    return mockActiveHandles;
  },
}));

const mockSendAlertThrottled = vi.fn<() => void>();
vi.mock("../src/scheduler/alerts.js", () => ({
  sendAlertThrottled: mockSendAlertThrottled,
}));

const mockInsertSystemEvent = vi.fn<() => void>();
vi.mock("../src/db/queries.js", () => ({
  insertSystemEvent: mockInsertSystemEvent,
}));

// Import after mocks
const { checkDrainTimeout, DEFAULT_DRAIN_TRACKING_FILE } = await import(
  "../src/scheduler/drain-monitor.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 1,
    sessionTimeoutMin: 45,
    strandedTaskThresholdMin: 60,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxCostUsd: 10.0,
    budgetMaxTokens: 1_000_000_000,
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
    invocationLogRetentionHours: 168,
    resumeOnMaxTurns: true,
    resumeOnFix: true,
    maxWorktreeRetries: 3,
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    logMaxSizeMb: 10,
    linearApiKey: "test-api-key",
    linearWebhookSecret: "test-secret",
    linearProjectIds: ["proj-1"],
    taskFilterLabel: undefined,
    tunnelHostname: "test.example.com",
    githubWebhookSecret: undefined,
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    cronRetentionDays: 7,
    stateMapOverrides: undefined,
    logLevel: "info",
    projectRepoMap: new Map(),
    implementModel: "sonnet",
    reviewModel: "haiku",
    fixModel: "sonnet",
    drainTimeoutMin: 10,
    ...overrides,
  } as OrcaConfig;
}

function makeDeps(configOverrides: Partial<OrcaConfig> = {}) {
  return {
    db: createDb(":memory:") as OrcaDb,
    config: makeConfig(configOverrides),
    client: { createComment: vi.fn() } as any,
    graph: {} as any,
    stateMap: new Map(),
    inngest: {} as any,
  };
}

async function writeTmpTrackingState(
  filePath: string,
  state: { consecutiveZeroSessionSnapshots: number; firstZeroSessionAt: string | null },
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

async function readTmpTrackingState(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as { consecutiveZeroSessionSnapshots: number; firstZeroSessionAt: string | null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkDrainTimeout — not draining", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    mockIsDraining.mockReturnValue(false);
    mockGetDrainingForSeconds.mockReturnValue(null);
    mockActiveHandles.clear();
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(false);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns early without calling clearDraining", async () => {
    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).not.toHaveBeenCalled();
  });

  test("returns early without sending alerts", async () => {
    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);
    expect(mockSendAlertThrottled).not.toHaveBeenCalled();
  });

  test("resets state file to zero when not draining", async () => {
    // Pre-seed a non-zero state to confirm reset
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 5,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(0);
    expect(state.firstZeroSessionAt).toBeNull();
  });
});

describe("checkDrainTimeout — draining with active sessions", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(30); // 30 seconds
    // Put 2 active sessions
    mockActiveHandles.clear();
    mockActiveHandles.set(1, {} as any);
    mockActiveHandles.set(2, {} as any);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("does NOT auto-clear drain when sessions are active even past timeout", async () => {
    // drainDurationSec (30) < drainTimeoutSec (10 * 60 = 600), and sessions > 0
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).not.toHaveBeenCalled();
  });

  test("does NOT auto-clear drain when sessions are active AND past timeout", async () => {
    // Past timeout, but sessions are still active — should NOT clear
    mockGetDrainingForSeconds.mockReturnValue(700); // > 10 min timeout
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).not.toHaveBeenCalled();
  });

  test("resets consecutive zero-session counter when sessions become active", async () => {
    // Pre-seed a state where we had 1 zero-session snapshot
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(0);
    expect(state.firstZeroSessionAt).toBeNull();
  });
});

describe("checkDrainTimeout — auto-clear (past timeout, no sessions)", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(700); // > 10 min timeout
    mockActiveHandles.clear(); // 0 sessions
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("calls clearDraining when past timeout with 0 sessions", async () => {
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).toHaveBeenCalledOnce();
  });

  test("inserts a system event when auto-clearing", async () => {
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockInsertSystemEvent).toHaveBeenCalledOnce();
  });

  test("does NOT send alert when auto-clearing with only 1 prior snapshot", async () => {
    // No prior state — first encounter, snapCountAtClear = 1 < 2, no alert
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockSendAlertThrottled).not.toHaveBeenCalled();
  });

  test("sends alert when auto-clearing and prior snapshot count was at threshold", async () => {
    // snapshot #1 already recorded, now snapshot #2 triggers both alert and auto-clear
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);

    expect(mockSendAlertThrottled).toHaveBeenCalledOnce();
    expect(mockClearDraining).toHaveBeenCalledOnce();
  });
});

describe("checkDrainTimeout — consecutive zero-session snapshot alerting", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(30); // well under 10-min timeout
    mockActiveHandles.clear(); // 0 sessions
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("first zero-session snapshot: counter becomes 1, no alert", async () => {
    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    expect(mockSendAlertThrottled).not.toHaveBeenCalled();

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(1);
    expect(state.firstZeroSessionAt).not.toBeNull();
  });

  test("second zero-session snapshot: counter becomes 2, alert fires", async () => {
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    expect(mockSendAlertThrottled).toHaveBeenCalledOnce();
    expect(mockSendAlertThrottled.mock.calls[0]?.[1]).toBe("drain-zero-sessions");

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(2);
  });

  test("third zero-session snapshot fires alert (>= 2 check)", async () => {
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 2,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    expect(mockSendAlertThrottled).toHaveBeenCalledOnce();

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(3);
  });

  test("fourth snapshot also fires alert (subject to cooldown)", async () => {
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 3,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    expect(mockSendAlertThrottled).toHaveBeenCalledOnce();

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(4);
  });

  test("firstZeroSessionAt is preserved across multiple snapshots", async () => {
    const originalTs = "2026-01-01T12:00:00Z";
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: originalTs,
    });

    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    const state = await readTmpTrackingState(stateFile);
    expect(state.firstZeroSessionAt).toBe(originalTs);
  });

  test("firstZeroSessionAt is set on first zero-session snapshot", async () => {
    const deps = makeDeps();
    const before = new Date().toISOString();
    await checkDrainTimeout(deps, stateFile);
    const after = new Date().toISOString();

    const state = await readTmpTrackingState(stateFile);
    expect(state.firstZeroSessionAt).not.toBeNull();
    expect(state.firstZeroSessionAt! >= before).toBe(true);
    expect(state.firstZeroSessionAt! <= after).toBe(true);
  });
});

describe("checkDrainTimeout — state file does not exist", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "subdir", "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(30);
    mockActiveHandles.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates state file and parent directory if missing", async () => {
    const deps = makeDeps();
    await checkDrainTimeout(deps, stateFile);

    // File should be created
    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(1);
  });

  test("treats missing file as zero initial state (not an error)", async () => {
    const deps = makeDeps();
    // Should not throw
    await expect(checkDrainTimeout(deps, stateFile)).resolves.toBeUndefined();
  });
});

describe("checkDrainTimeout — exact timeout boundary", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockActiveHandles.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("does NOT auto-clear when drainDurationSec is exactly 1 second under timeout", async () => {
    mockGetDrainingForSeconds.mockReturnValue(599); // 1s under 10-min (600s)
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).not.toHaveBeenCalled();
  });

  test("auto-clears when drainDurationSec equals the timeout exactly", async () => {
    mockGetDrainingForSeconds.mockReturnValue(600); // exactly 10 min
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).toHaveBeenCalledOnce();
  });

  test("auto-clears when drainDurationSec is 1 second over timeout", async () => {
    mockGetDrainingForSeconds.mockReturnValue(601);
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    expect(mockClearDraining).toHaveBeenCalledOnce();
  });
});

describe("checkDrainTimeout — state file not reset after auto-clear", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(700);
    mockActiveHandles.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("state file is reset to zero after auto-clear", async () => {
    await writeTmpTrackingState(stateFile, {
      consecutiveZeroSessionSnapshots: 1,
      firstZeroSessionAt: "2026-01-01T00:00:00Z",
    });

    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);

    expect(mockClearDraining).toHaveBeenCalledOnce();

    const state = await readTmpTrackingState(stateFile);
    expect(state.consecutiveZeroSessionSnapshots).toBe(0);
    expect(state.firstZeroSessionAt).toBeNull();
  });
});

describe("checkDrainTimeout — getDrainDurationSeconds returns null while draining", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drain-test-"));
    stateFile = path.join(tmpDir, "drain-state-tracking.json");
    vi.clearAllMocks();
    mockIsDraining.mockReturnValue(true);
    mockGetDrainingForSeconds.mockReturnValue(null); // unusual: draining=true but no timestamp
    mockActiveHandles.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("falls back to 0 seconds and does NOT auto-clear (0 < any positive timeout)", async () => {
    const deps = makeDeps({ drainTimeoutMin: 10 });
    await checkDrainTimeout(deps, stateFile);
    // 0 < 600, so should not auto-clear
    expect(mockClearDraining).not.toHaveBeenCalled();
  });
});
