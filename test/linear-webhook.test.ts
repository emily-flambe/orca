import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { createDb } from "../src/db/index.js";
import { createWebhookRoute } from "../src/linear/webhook.js";
import { DependencyGraph } from "../src/linear/graph.js";

// ---------------------------------------------------------------------------
// Mock processWebhookEvent from sync module
// ---------------------------------------------------------------------------

vi.mock("../src/linear/sync.js", () => ({
  processWebhookEvent: vi.fn(),
}));

import { processWebhookEvent } from "../src/linear/sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";

function sign(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function testConfig(overrides = {}) {
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
    port: 3000,
    dbPath: ":memory:",
    linearApiKey: "test-api-key",
    linearWebhookSecret: TEST_SECRET,
    linearProjectIds: ["proj-1"],
    linearReadyStateType: "unstarted",
    tunnelHostname: "test.example.com",
    projectRepoMap: new Map(),
    ...overrides,
  };
}

function makeIssueEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Issue",
    action: "create",
    data: {
      id: "issue-1",
      projectId: "proj-1",
      title: "Test issue",
      ...overrides,
    },
  });
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

  beforeEach(() => {
    vi.clearAllMocks();
    const db = createDb(":memory:");
    const config = testConfig();
    const graph = new DependencyGraph();
    const stateMap = new Map();
    const client = {} as Parameters<typeof createWebhookRoute>[0]["client"];

    app = createWebhookRoute({ db, client, graph, config, stateMap });
  });

  // 1. Valid signature + Issue event matching projectId → calls processWebhookEvent, returns 200
  it("valid signature + Issue event matching projectId calls processWebhookEvent and returns 200", async () => {
    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 2. Missing linear-signature header → 401
  it("missing linear-signature header returns 401", async () => {
    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body, { signature: null }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 3. Invalid signature → 401
  it("invalid signature returns 401", async () => {
    const body = makeIssueEvent();
    const tamperedSig = sign(body + "tampered");
    const res = await app.request(
      makeRequest(body, { signature: tamperedSig }),
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 4. Valid signature + invalid JSON → 400
  it("valid signature + invalid JSON body returns 400", async () => {
    const body = "not valid json {{{";
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid body" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 5. Valid signature + non-Issue event type → 200, processWebhookEvent not called
  it("valid signature + non-Issue event type returns 200 and does not call processWebhookEvent", async () => {
    const body = JSON.stringify({
      type: "Comment",
      action: "create",
      data: {},
    });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 6. Valid signature + Issue event with projectId NOT in config → 200, processWebhookEvent not called
  it("valid signature + Issue event with unrecognized projectId returns 200 and does not call processWebhookEvent", async () => {
    const body = makeIssueEvent({ projectId: "proj-other" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 7. Valid signature + Issue event with no projectId → allowed through, processWebhookEvent called
  it("valid signature + Issue event with null projectId passes filter and calls processWebhookEvent", async () => {
    const body = makeIssueEvent({ projectId: null });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 8. processWebhookEvent throws → still returns 200
  it("returns 200 even if processWebhookEvent throws", async () => {
    vi.mocked(processWebhookEvent).mockRejectedValueOnce(new Error("boom"));

    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });
});
