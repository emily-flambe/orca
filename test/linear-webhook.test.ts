import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createWebhookRoute } from "../src/linear/webhook.js";
import type { OrcaDb } from "../src/db/index.js";
import type { LinearClient } from "../src/linear/client.js";
import type { DependencyGraph } from "../src/linear/graph.js";

// ---------------------------------------------------------------------------
// Module mock — processWebhookEvent
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

function testConfig(overrides: Record<string, unknown> = {}) {
  return {
    defaultCwd: "/tmp/test",
    concurrencyCap: 1,
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

function makeRequest(
  body: string,
  opts: {
    signature?: string | null;
  } = {},
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

function makeIssueBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "Issue",
    data: {
      id: "issue-123",
      projectId: "proj-1",
      ...overrides,
    },
    ...("type" in overrides ? {} : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebhookRoute (Linear)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(processWebhookEvent).mockResolvedValue(undefined);

    deps = {
      db: {} as OrcaDb,
      client: {} as LinearClient,
      graph: {} as DependencyGraph,
      config: testConfig({ linearWebhookSecret: TEST_SECRET, linearProjectIds: ["proj-1"] }),
      stateMap: new Map(),
      labelIdCache: undefined,
    };

    app = createWebhookRoute(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Happy path
  it("valid signature + Issue type + matching projectId calls processWebhookEvent and returns 200", async () => {
    const body = makeIssueBody({ projectId: "proj-1" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 2. Missing signature header
  it("missing linear-signature header returns 401 with invalid signature error", async () => {
    const body = makeIssueBody();
    const res = await app.request(makeRequest(body, { signature: null }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 3. Invalid/wrong signature
  it("invalid signature returns 401 with invalid signature error", async () => {
    const body = makeIssueBody();
    const wrongSig = sign(body + "tampered");
    const res = await app.request(makeRequest(body, { signature: wrongSig }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 4. Non-Issue event type
  it("valid signature + non-Issue type returns 200 and does not call processWebhookEvent", async () => {
    const body = JSON.stringify({ type: "Project", data: { id: "proj-999" } });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 5. Issue but wrong projectId
  it("valid signature + Issue + wrong projectId returns 200 and does not call processWebhookEvent", async () => {
    const body = makeIssueBody({ projectId: "proj-other" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 6. Issue with no projectId — no filter applied, processWebhookEvent IS called
  it("valid signature + Issue + absent projectId calls processWebhookEvent", async () => {
    const body = JSON.stringify({ type: "Issue", data: { id: "issue-abc" } });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 7. processWebhookEvent throws — still returns 200
  it("processWebhookEvent throwing still returns 200", async () => {
    vi.mocked(processWebhookEvent).mockRejectedValue(new Error("sync exploded"));

    const body = makeIssueBody({ projectId: "proj-1" });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  // 8. Invalid JSON body
  it("valid signature + invalid JSON body returns 400", async () => {
    const body = "not valid json {{{";
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: expect.any(String) });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
});
