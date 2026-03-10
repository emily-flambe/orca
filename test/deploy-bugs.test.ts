// ---------------------------------------------------------------------------
// deploy-bugs.test.ts
//
// Tests for edge cases in the GitHub webhook handler — branch deletion and
// null SHA events that should NOT trigger a deploy.
// ---------------------------------------------------------------------------

import { describe, test, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("GitHub webhook — branch deletion and null SHA filtering", () => {
  test("deleting main branch does NOT trigger deploy (deleted=true)", async () => {
    const { createGithubWebhookRoute } = await import(
      "../src/github/webhook.js"
    );

    const SECRET = "test-secret";
    const onPushToMain = vi.fn();
    const app = createGithubWebhookRoute({ secret: SECRET, onPushToMain });

    const payload = JSON.stringify({
      ref: "refs/heads/main",
      before: "abc123def456abc123def456abc123def456abc1",
      after: "0000000000000000000000000000000000000000",
      deleted: true,
      created: false,
      forced: false,
    });

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signPayload(payload, SECRET),
      },
      body: payload,
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  test("push with zero/null SHA does NOT trigger deploy", async () => {
    const { createGithubWebhookRoute } = await import(
      "../src/github/webhook.js"
    );

    const SECRET = "test-secret";
    const onPushToMain = vi.fn();
    const app = createGithubWebhookRoute({ secret: SECRET, onPushToMain });

    const payload = JSON.stringify({
      ref: "refs/heads/main",
      before: "abc123def456abc123def456abc123def456abc1",
      after: "0000000000000000000000000000000000000000",
    });

    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": signPayload(payload, SECRET),
      },
      body: payload,
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(onPushToMain).not.toHaveBeenCalled();
  });

  test("normal push to main DOES trigger deploy", async () => {
    const { createGithubWebhookRoute } = await import(
      "../src/github/webhook.js"
    );

    // Capture setImmediate to synchronously check if callback was scheduled
    const scheduledCallbacks: Array<() => void> = [];
    const originalSetImmediate = globalThis.setImmediate;
    // @ts-expect-error — overriding setImmediate for test
    globalThis.setImmediate = (fn: () => void) => {
      scheduledCallbacks.push(fn);
    };

    try {
      const SECRET = "test-secret";
      const onPushToMain = vi.fn();
      const app = createGithubWebhookRoute({ secret: SECRET, onPushToMain });

      const SHA = "abc123def456abc123def456abc123def456abc1";
      const payload = JSON.stringify({
        ref: "refs/heads/main",
        before: "0000000000000000000000000000000000000000",
        after: SHA,
        deleted: false,
      });

      const req = new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-hub-signature-256": signPayload(payload, SECRET),
        },
        body: payload,
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);

      // Execute the setImmediate callback
      for (const cb of scheduledCallbacks) cb();

      expect(onPushToMain).toHaveBeenCalledWith(SHA);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });
});
