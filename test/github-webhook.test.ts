import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { createGithubWebhookRoute } from "../src/github/webhook.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret";

function sign(body: string, secret = TEST_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeRequest(
  body: string,
  opts: {
    signature?: string | null;
    event?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  // null means omit the header entirely; undefined means compute valid sig
  if (opts.signature !== null) {
    headers["x-hub-signature-256"] = opts.signature ?? sign(body);
  }
  if (opts.event !== undefined) {
    headers["x-github-event"] = opts.event;
  }
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

function makePushBody(
  overrides: {
    ref?: string;
    after?: string;
    deleted?: boolean;
  } = {},
): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    after: "abc123def456abc123def456abc123def456abc123",
    deleted: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGithubWebhookRoute", () => {
  let onPushToMain: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createGithubWebhookRoute>;

  beforeEach(() => {
    onPushToMain = vi.fn();
    app = createGithubWebhookRoute({ secret: TEST_SECRET, onPushToMain });
  });

  // 1. Valid push to main — happy path
  it("valid signature + push to main calls onPushToMain with SHA and returns 200", async () => {
    const sha = "abc123def456abc123def456abc123def456abc123";
    const body = makePushBody({ after: sha });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    // setImmediate is microtask-adjacent — flush it
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).toHaveBeenCalledOnce();
    expect(onPushToMain).toHaveBeenCalledWith(sha);
  });

  // 2. Missing signature header → 401
  it("missing x-hub-signature-256 header returns 401", async () => {
    const body = makePushBody();
    const res = await app.request(
      makeRequest(body, { signature: null, event: "push" }),
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "missing signature" });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 3. Invalid/tampered signature → 401
  it("invalid signature returns 401", async () => {
    const body = makePushBody();
    const tamperedSig = sign(body + "tampered");
    const res = await app.request(
      makeRequest(body, { signature: tamperedSig, event: "push" }),
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 4. Wrong-length signature header → 401
  it("wrong-length signature header returns 401", async () => {
    const body = makePushBody();
    // A valid-looking but wrong-length hex string
    const shortSig = "sha256=abc123";
    const res = await app.request(
      makeRequest(body, { signature: shortSig, event: "push" }),
    );

    expect(res.status).toBe(401);
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 5. Valid sig + non-push event → 200, no callback
  it("valid signature + ping event returns 200 and does not call onPushToMain", async () => {
    const body = JSON.stringify({ zen: "Avoid unnecessary abstraction." });
    const res = await app.request(makeRequest(body, { event: "ping" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 6. Valid sig + push to non-main branch → 200, no callback
  it("valid signature + push to non-main branch returns 200 and does not call onPushToMain", async () => {
    const body = makePushBody({ ref: "refs/heads/feature/my-branch" });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 7. Valid sig + deleted: true → 200, no callback
  it("valid signature + deleted push event returns 200 and does not call onPushToMain", async () => {
    const body = makePushBody({ deleted: true });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 8. Valid sig + null SHA (40 zeros) → 200, no callback
  it("valid signature + null SHA (40 zeros) returns 200 and does not call onPushToMain", async () => {
    const nullSha = "0".repeat(40);
    const body = makePushBody({ after: nullSha });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 9. Empty body with correct signature + no event header → 200 (falls through non-push path)
  it("empty body with correct signature and no event header returns 200 ok", async () => {
    const body = "";
    const res = await app.request(makeRequest(body));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 10. Valid sig + push to main + invalid JSON body → 400
  it("valid signature + push to main + invalid JSON body returns 400", async () => {
    const body = "not valid json {{{";
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid JSON" });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 11. after field absent entirely (not null SHA, just missing key) → 200, no callback
  // The source guards with !body.after which catches undefined. Explicit test for
  // the absent-key case (distinct from after: "000...0") to pin the behavior.
  it("valid signature + push to main + after field absent returns 200 and does not call onPushToMain", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main", deleted: false });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 12. after: "" (empty string) → 200, no callback
  // Empty string is falsy; !body.after catches it. Different code path from null SHA.
  it("valid signature + push to main + after empty string returns 200 and does not call onPushToMain", async () => {
    const body = makePushBody({ after: "" });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 13. Push to refs/heads/main-something — must NOT trigger onPushToMain
  // Guards against a prefix-match regression (e.g., startsWith instead of ===).
  it("valid signature + push to refs/heads/main-something returns 200 and does not call onPushToMain", async () => {
    const body = makePushBody({ ref: "refs/heads/main-something" });
    const res = await app.request(makeRequest(body, { event: "push" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  // 14. Wrong-length signature — assert error body is "invalid signature"
  // Test 4 covers status 401 but omits the error message. If the length-check
  // branch is removed, timingSafeEqual throws and the route returns 500, not 401,
  // so the status assertion catches the regression. This test adds the body assertion
  // as a belt-and-suspenders check and confirms the route stays in the 4xx path.
  it("wrong-length signature header returns 401 with invalid signature error", async () => {
    const body = makePushBody();
    const shortSig = "sha256=abc123";
    const res = await app.request(
      makeRequest(body, { signature: shortSig, event: "push" }),
    );

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
    expect(onPushToMain).not.toHaveBeenCalled();
  });
});
