// ---------------------------------------------------------------------------
// Linear webhook route tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { OrcaConfig } from "../src/config/index.js";
import type { OrcaDb } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Mock processWebhookEvent so tests don't need real DB/scheduler deps
// ---------------------------------------------------------------------------

vi.mock("../src/linear/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/linear/sync.js")>();
  return {
    ...actual,
    processWebhookEvent: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";

function sign(body: string, secret = TEST_SECRET): string {
  // Linear uses plain hex HMAC-SHA256 — no "sha256=" prefix
  return createHmac("sha256", secret).update(body).digest("hex");
}

function testConfig(overrides: Partial<OrcaConfig> = {}): OrcaConfig {
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

function makeIssuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Test issue",
      priority: 2,
      state: { id: "s1", name: "Todo", type: "unstarted" },
      projectId: "proj-1",
    },
    ...overrides,
  });
}

async function buildApp(configOverrides: Partial<OrcaConfig> = {}) {
  const { createWebhookRoute } = await import("../src/linear/webhook.js");
  const config = testConfig(configOverrides);
  return createWebhookRoute({
    db: {} as OrcaDb,
    client: {} as never,
    graph: {} as never,
    config,
    stateMap: new Map(),
  });
}

async function getProcessWebhookEventMock() {
  const syncMod = await import("../src/linear/sync.js");
  return syncMod.processWebhookEvent as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebhookRoute — Linear webhook", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let processWebhookEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    app = await buildApp();
    processWebhookEvent = await getProcessWebhookEventMock();
    processWebhookEvent.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // HMAC verification
  // -------------------------------------------------------------------------

  it("valid signature returns 200", async () => {
    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  it("missing linear-signature header returns 401", async () => {
    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(res.status).toBe(401);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it("invalid (tampered) signature returns 401", async () => {
    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body + "tamper"),
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it("wrong-length signature returns 401", async () => {
    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": "deadbeef",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Event filtering
  // -------------------------------------------------------------------------

  it("non-Issue type event returns 200 without calling processWebhookEvent", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Comment",
      data: { id: "c1", body: "hello" },
    });
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it("Issue event with wrong projectId returns 200 without calling processWebhookEvent", async () => {
    const body = makeIssuePayload({
      data: {
        id: "issue-x",
        identifier: "OTHER-1",
        title: "Other project issue",
        priority: 0,
        state: { id: "s2", name: "Todo", type: "unstarted" },
        projectId: "proj-other",
      },
    });
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  it("Issue event with matching projectId calls processWebhookEvent", async () => {
    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  it("Issue event with no projectId in data passes through (not filtered)", async () => {
    // When projectId is absent, the filter condition is falsy so it passes through
    const body = JSON.stringify({
      action: "update",
      type: "Issue",
      data: {
        id: "issue-2",
        identifier: "PROJ-2",
        title: "No project",
        priority: 0,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        // projectId intentionally omitted
      },
    });
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  it("processWebhookEvent throws but route still returns 200", async () => {
    processWebhookEvent.mockRejectedValueOnce(new Error("DB exploded"));

    const body = makeIssuePayload();
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // JSON parse error
  // -------------------------------------------------------------------------

  it("invalid JSON body with valid signature returns 400", async () => {
    const body = "not { valid json {{{";
    const res = await app.request("/api/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "linear-signature": sign(body),
      },
      body,
    });

    expect(res.status).toBe(400);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
});
