// ---------------------------------------------------------------------------
// GET /api/tasks/:id/transitions — state transition audit log tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/index.js";
import { createApiRoutes } from "../src/api/routes.js";
import { insertTask, updateTaskStatus } from "../src/db/queries.js";
import type { OrcaDb } from "../src/db/index.js";
import type { OrcaConfig } from "../src/config/index.js";
import type { Hono } from "hono";

vi.mock("../src/deploy.js", () => ({
  isDraining: vi.fn().mockReturnValue(false),
  getDrainingSeconds: vi.fn().mockReturnValue(null),
  setDraining: vi.fn(),
  clearDraining: vi.fn(),
  initDeployState: vi.fn(),
  getDrainingForSeconds: vi.fn().mockReturnValue(null),
}));

const mockInngest = { send: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(overrides?: Partial<OrcaConfig>): OrcaConfig {
  return {
    defaultCwd: "/tmp",
    projectRepoMap: new Map(),
    concurrencyCap: 3,
    sessionTimeoutMin: 45,
    maxRetries: 3,
    budgetWindowHours: 4,
    budgetMaxTokens: 1_000_000_000,
    claudePath: "claude",
    defaultMaxTurns: 20,
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
    port: 3000,
    dbPath: ":memory:",
    logPath: "./orca.log",
    linearApiKey: "test",
    linearWebhookSecret: "test",
    linearProjectIds: ["test-project"],
    tunnelHostname: "test.example.com",
    alertWebhookUrl: undefined,
    tunnelToken: "",
    cloudflaredPath: "cloudflared",
    externalTunnel: false,
    logLevel: "info",
    ...overrides,
  };
}

function deriveLifecycle(status: string): {
  lifecycleStage: string;
  currentPhase: string | null;
} {
  const map: Record<
    string,
    { lifecycleStage: string; currentPhase: string | null }
  > = {
    backlog: { lifecycleStage: "backlog", currentPhase: null },
    ready: { lifecycleStage: "ready", currentPhase: null },
    running: { lifecycleStage: "active", currentPhase: "implement" },
    in_review: { lifecycleStage: "active", currentPhase: "review" },
    changes_requested: { lifecycleStage: "active", currentPhase: "fix" },
    awaiting_ci: { lifecycleStage: "active", currentPhase: "ci" },
    deploying: { lifecycleStage: "active", currentPhase: "deploy" },
    done: { lifecycleStage: "done", currentPhase: null },
    failed: { lifecycleStage: "failed", currentPhase: null },
    canceled: { lifecycleStage: "canceled", currentPhase: null },
  };
  return map[status] ?? { lifecycleStage: status, currentPhase: null };
}

function makeTask(overrides?: Record<string, unknown>) {
  const statusStr = (overrides?.lifecycleStage as string) ?? "ready";
  const lifecycle = deriveLifecycle(statusStr);
  return {
    linearIssueId: "TEST-1",
    agentPrompt: "Fix the bug",
    repoPath: "/tmp/repo",
    lifecycleStage: lifecycle.lifecycleStage,
    currentPhase: lifecycle.currentPhase,
    priority: 2,
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/tasks/:id/transitions", () => {
  let db: OrcaDb;
  let app: Hono;

  beforeEach(() => {
    db = createDb(":memory:");
    app = createApiRoutes({
      db,
      config: makeConfig(),
      syncTasks: vi.fn().mockResolvedValue(0),
      client: {} as any,
      stateMap: new Map(),
      projectMeta: [],
      inngest: mockInngest,
    });
  });

  it("returns empty array for task with no transitions", async () => {
    insertTask(db, makeTask({ linearIssueId: "TRANS-1" }));
    const res = await app.request("/api/tasks/TRANS-1/transitions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns transitions in insertion order", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "TRANS-2", lifecycleStage: "ready" }),
    );
    updateTaskStatus(db, "TRANS-2", "running");
    updateTaskStatus(db, "TRANS-2", "in_review");

    const res = await app.request("/api/tasks/TRANS-2/transitions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].fromStatus).toBe("ready");
    expect(body[0].toStatus).toBe("running");
    expect(body[1].fromStatus).toBe("running");
    expect(body[1].toStatus).toBe("in_review");
  });

  it("returns 404 for missing task", async () => {
    const res = await app.request("/api/tasks/NONEXISTENT-TRANS/transitions");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });

  it("records reason on transitions", async () => {
    insertTask(
      db,
      makeTask({ linearIssueId: "TRANS-3", lifecycleStage: "ready" }),
    );
    updateTaskStatus(db, "TRANS-3", "failed", {
      reason: "session_failed_db_fallback",
    });

    const res = await app.request("/api/tasks/TRANS-3/transitions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].toStatus).toBe("failed");
    expect(body[0].reason).toBe("session_failed_db_fallback");
  });
});
