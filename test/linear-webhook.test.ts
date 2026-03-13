// ---------------------------------------------------------------------------
// Linear webhook tests — createWebhookRoute
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createWebhookRoute } from "../src/linear/webhook.js";
import type { OrcaDb } from "../src/db/index.js";
import type { LinearClient, WorkflowStateMap } from "../src/linear/client.js";
import type { DependencyGraph } from "../src/linear/graph.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Mock processWebhookEvent — sync.ts has heavy transitive deps
// ---------------------------------------------------------------------------

vi.mock("../src/linear/sync.js", () => ({
  processWebhookEvent: vi.fn(),
}));

import { processWebhookEvent } from "../src/linear/sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-linear-secret";

function sign(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const testConfig = {
  linearWebhookSecret: TEST_SECRET,
  linearProjectIds: ["proj-1", "proj-2"],
  defaultCwd: undefined,
  projectRepoMap: new Map(),
  concurrencyCap: 1,
  sessionTimeoutMin: 45,
  maxRetries: 3,
  budgetWindowHours: 4,
  budgetMaxCostUsd: 100,
  budgetMaxTokens: 0,
  schedulerIntervalSec: 10,
  claudePath: "claude",
  defaultMaxTurns: 50,
  implementSystemPrompt: "",
  reviewSystemPrompt: "",
  fixSystemPrompt: "",
  maxReviewCycles: 3,
  reviewMaxTurns: 20,
  disallowedTools: "",
  implementModel: "sonnet",
  reviewModel: "haiku",
  fixModel: "sonnet",
  deployStrategy: "none" as const,
  deployPollIntervalSec: 30,
  deployTimeoutMin: 30,
  cleanupIntervalMin: 60,
  cleanupBranchMaxAgeMin: 120,
  invocationLogRetentionHours: 48,
  resumeOnMaxTurns: false,
  resumeOnFix: false,
  maxWorktreeRetries: 3,
  port: 4000,
  dbPath: ":memory:",
  logPath: "logs",
  logMaxSizeMb: 50,
  linearApiKey: "lin_api_test",
  taskFilterLabel: undefined,
  tunnelHostname: "",
  githubWebhookSecret: undefined,
  tunnelToken: "",
  cloudflaredPath: "cloudflared",
  externalTunnel: false,
  cronRetentionDays: 7,
} satisfies OrcaConfig;

const testDeps = {
  db: {} as OrcaDb,
  client: {} as LinearClient,
  graph: {} as DependencyGraph,
  config: testConfig,
  stateMap: new Map() as WorkflowStateMap,
};

function makeIssueBody(overrides: {
  type?: string;
  action?: string;
  projectId?: string | null;
} = {}): string {
  const event = {
    action: overrides.action ?? "create",
    type: overrides.type ?? "Issue",
    data: {
      id: "issue-abc",
      identifier: "TEST-1",
      title: "Test issue",
      description: "A test issue",
      priority: 1,
      state: { id: "state-1", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      ...(overrides.projectId !== undefined
        ? { projectId: overrides.projectId ?? undefined }
        : { projectId: "proj-1" }),
      labelIds: [],
    },
  };
  return JSON.stringify(event);
}

function makeRequest(
  body: string,
  opts: { signature?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.signature !== null) {
    headers["linear-signature"] = opts.signature ?? sign(body);
  }
  return new Request("http://localhost/api/webhooks/linear", {
    method: "POST",
    headers,
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebhookRoute", () => {
  let app: ReturnType<typeof createWebhookRoute>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    app = createWebhookRoute(testDeps);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // 1. Missing signature header → 401
  it("missing linear-signature header returns 401 with invalid signature error", async () => {
    const body = makeIssueBody();
    const res = await app.request(makeRequest(body, { signature: null }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 2. Wrong/tampered signature → 401
  it("wrong signature returns 401 with invalid signature error", async () => {
    const body = makeIssueBody();
    const tamperedSig = sign(body + "tampered");
    const res = await app.request(makeRequest(body, { signature: tamperedSig }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 3. Valid signature + non-Issue event type → 200, processWebhookEvent NOT called
  it("valid signature + non-Issue event type returns 200 and does not call processWebhookEvent", async () => {
    const body = makeIssueBody({ type: "Comment" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 4. Valid signature + Issue event + projectId not in config → 200, NOT called
  it("valid signature + Issue event + projectId not in config returns 200 and does not call processWebhookEvent", async () => {
    const body = makeIssueBody({ projectId: "proj-unknown" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 5. Valid signature + Issue event + projectId in config → 200, processWebhookEvent called once
  it("valid signature + Issue event + projectId in config returns 200 and calls processWebhookEvent once", async () => {
    const body = makeIssueBody({ projectId: "proj-1" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 6. Valid signature + Issue event + no projectId → 200, processWebhookEvent called (no project filter)
  it("valid signature + Issue event + no projectId returns 200 and calls processWebhookEvent", async () => {
    const event = {
      action: "create",
      type: "Issue",
      data: {
        id: "issue-abc",
        identifier: "TEST-1",
        title: "Test issue",
        description: "A test",
        priority: 1,
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        labelIds: [],
        // no projectId field
      },
    };
    const body = JSON.stringify(event);
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 7. Valid signature + invalid JSON body → 400
  it("valid signature + invalid JSON body returns 400 with invalid body error", async () => {
    const body = "not valid json {{{";
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid body" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 8. Valid signature + Issue event + processWebhookEvent throws → still 200
  it("valid signature + Issue event + processWebhookEvent throws still returns 200", async () => {
    (processWebhookEvent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
    const body = makeIssueBody({ projectId: "proj-2" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  // 9. Wrong-length signature → 401 (guards timingSafeEqual crash)
  it("wrong-length signature returns 401", async () => {
    const body = makeIssueBody();
    const shortSig = "abc123";
    const res = await app.request(makeRequest(body, { signature: shortSig }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
});
