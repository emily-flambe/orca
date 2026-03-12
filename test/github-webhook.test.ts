// ---------------------------------------------------------------------------
// GitHub webhook signature verification tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createGithubWebhookRoute } from "../src/github/webhook.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-webhook-secret";

function makeSignature(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    body,
    headers,
  });
}

function makeApp(onPushToMain = vi.fn()) {
  return createGithubWebhookRoute({ secret: SECRET, onPushToMain });
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("GitHub webhook signature verification", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/other" });
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a missing signature header", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "missing signature" });
  });

  it("rejects an invalid (tampered) signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature("tampered body"),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid signature" });
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body, "wrong-secret"),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed header (wrong prefix)", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const app = makeApp();
    // Build a sha1-prefixed header of the correct length
    const correctSig = makeSignature(body);
    const malformed = "sha1=" + correctSig.slice(5); // same length, wrong prefix
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": malformed,
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a signature of the wrong length", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": "sha256=tooshort",
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("handles an empty body with a valid signature", async () => {
    const body = "";
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "ping",
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

describe("GitHub webhook event routing", () => {
  it("ignores non-push events and returns ok", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const body = JSON.stringify({});
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "ping",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  it("ignores push events to non-main branches", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const body = JSON.stringify({
      ref: "refs/heads/feature-branch",
      after: "a".repeat(40),
    });
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  it("calls onPushToMain for a valid push to main", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const sha = "abc123".padEnd(40, "0");
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: sha,
      deleted: false,
    });
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
    // setImmediate defers the call; flush microtasks + macrotasks
    await new Promise((r) => setImmediate(r));
    expect(onPushToMain).toHaveBeenCalledWith(sha);
  });

  it("ignores branch deletion events (deleted: true)", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "0".repeat(40),
      deleted: true,
    });
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  it("ignores push events with null SHA (40 zeros)", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "0".repeat(40),
    });
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  it("ignores push events with missing after field", async () => {
    const onPushToMain = vi.fn();
    const app = makeApp(onPushToMain);
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  it("returns 400 for push events with invalid JSON body", async () => {
    const body = "not json at all";
    const app = makeApp();
    const res = await app.fetch(
      makeRequest(body, {
        "x-hub-signature-256": makeSignature(body),
        "x-github-event": "push",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: "invalid JSON" });
  });
});
