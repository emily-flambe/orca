import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createWebhookRoute } from "../src/linear/webhook.js";
import type { WebhookDeps } from "../src/linear/webhook.js";
import type { OrcaDb } from "../src/db/index.js";
import type { LinearClient, WorkflowStateMap } from "../src/linear/client.js";
import type { DependencyGraph } from "../src/linear/graph.js";
import type { OrcaConfig } from "../src/config/index.js";

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

vi.mock("../src/linear/sync.js", () => ({
  processWebhookEvent: vi.fn(),
}));

import { processWebhookEvent } from "../src/linear/sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";
const TEST_PROJECT_ID = "proj-123";

function sign(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeConfig(overrides: Partial<{ linearWebhookSecret: string; linearProjectIds: string[] }> = {}): OrcaConfig {
  return {
    linearWebhookSecret: TEST_SECRET,
    linearProjectIds: [TEST_PROJECT_ID],
    ...overrides,
  } as unknown as OrcaConfig;
}

function makeDeps(configOverrides?: Partial<{ linearWebhookSecret: string; linearProjectIds: string[] }>): WebhookDeps {
  return {
    db: {} as OrcaDb,
    client: {} as LinearClient,
    graph: {} as DependencyGraph,
    config: makeConfig(configOverrides),
    stateMap: new Map() as WorkflowStateMap,
  };
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

function makeIssueEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Issue",
    data: {
      id: "issue-id-1",
      identifier: "PROJ-1",
      title: "Test issue",
      description: "A test issue",
      priority: 2,
      state: { id: "state-1", name: "Todo", type: "unstarted" },
      teamId: "team-1",
      projectId: TEST_PROJECT_ID,
      labelIds: [],
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebhookRoute", () => {
  let app: ReturnType<typeof createWebhookRoute>;
  let deps: WebhookDeps;

  beforeEach(() => {
    deps = makeDeps();
    app = createWebhookRoute(deps);
    vi.mocked(processWebhookEvent).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1. Missing signature header → 401
  it("missing linear-signature header returns 401 with invalid signature error", async () => {
    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body, { signature: null }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 2. Invalid signature → 401
  it("invalid signature returns 401", async () => {
    const body = makeIssueEvent();
    const wrongSig = sign(body + "tampered");
    const res = await app.request(makeRequest(body, { signature: wrongSig }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 3. Wrong-length signature → 401
  it("wrong-length signature header returns 401", async () => {
    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body, { signature: "abc123" }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 4. Valid sig + invalid JSON → 400
  it("valid signature with invalid JSON body returns 400", async () => {
    const body = "not valid json {{{";
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid body" });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 5. Valid sig + non-Issue event type → 200, no processing
  it("valid signature with non-Issue event type returns 200 without processing", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Comment",
      data: { id: "c1", identifier: "PROJ-1", title: "", priority: 0 },
    });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 6. Valid sig + Issue event with projectId not in config → 200, no processing
  it("valid signature with Issue event for unknown project returns 200 without processing", async () => {
    const body = makeIssueEvent({
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test issue",
        description: "A test issue",
        priority: 2,
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        teamId: "team-1",
        projectId: "unknown-project",
        labelIds: [],
      },
    });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 7. Valid sig + Issue event + matching projectId → calls processWebhookEvent
  it("valid signature with matching Issue event calls processWebhookEvent and returns 200", async () => {
    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 8. Valid sig + Issue event with no projectId → calls processWebhookEvent
  it("valid signature with Issue event without projectId calls processWebhookEvent and returns 200", async () => {
    const body = JSON.stringify({
      action: "create",
      type: "Issue",
      data: {
        id: "issue-id-1",
        identifier: "PROJ-1",
        title: "Test issue",
        priority: 2,
      },
    });
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 9. processWebhookEvent throws → still returns 200 (Linear retry prevention)
  it("when processWebhookEvent throws, still returns 200", async () => {
    vi.mocked(processWebhookEvent).mockRejectedValue(new Error("sync exploded"));

    const body = makeIssueEvent();
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(processWebhookEvent).toHaveBeenCalledOnce();
  });

  // 10. Signature uses plain hex (no sha256= prefix)
  it("rejects a sha256= prefixed signature that would match GitHub style", async () => {
    const body = makeIssueEvent();
    const prefixedSig = `sha256=${sign(body)}`;
    const res = await app.request(makeRequest(body, { signature: prefixedSig }));

    // The prefixed signature won't match the raw hex computed value
    expect(res.status).toBe(401);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });

  // 11. processWebhookEvent is called with correct deps args
  it("passes correct deps to processWebhookEvent", async () => {
    const body = makeIssueEvent();
    await app.request(makeRequest(body));

    expect(processWebhookEvent).toHaveBeenCalledWith(
      deps.db,
      deps.client,
      deps.graph,
      deps.config,
      deps.stateMap,
      expect.objectContaining({ type: "Issue" }),
      undefined, // labelIdCache not set
    );
  });

  // 12. labelIdCache is passed through when set
  it("passes labelIdCache to processWebhookEvent when provided", async () => {
    const labelIdCache = new Map<string, string>([["orca", "label-id-1"]]);
    const depsWithCache: WebhookDeps = { ...deps, labelIdCache };
    const appWithCache = createWebhookRoute(depsWithCache);

    const body = makeIssueEvent();
    await appWithCache.request(makeRequest(body));

    expect(processWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      labelIdCache,
    );
  });
});
