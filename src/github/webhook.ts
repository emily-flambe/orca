// ---------------------------------------------------------------------------
// GitHub webhook HTTP endpoint — Hono route with HMAC-SHA256 verification
//
// Listens for push events to main and triggers a graceful deploy drain.
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";

function log(msg: string): void {
  console.log(`[orca/github-webhook] ${msg}`);
}

function verifySignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  // Pad to same length for timing-safe compare
  if (sigHeader.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
}

export function createGithubWebhookRoute(deps: {
  secret: string;
  onPushToMain: (pushSha?: string) => void;
}): Hono {
  const app = new Hono();

  app.post("/api/webhooks/github", async (c) => {
    const sigHeader = c.req.header("x-hub-signature-256");
    if (!sigHeader) {
      log("rejected: missing x-hub-signature-256 header");
      return c.json({ error: "missing signature" }, 401);
    }

    const rawBody = await c.req.text();

    if (!verifySignature(rawBody, sigHeader, deps.secret)) {
      log("rejected: invalid signature");
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event");
    if (event !== "push") {
      return c.json({ ok: true });
    }

    let body: { ref?: string; after?: string };
    try {
      body = JSON.parse(rawBody) as { ref?: string; after?: string };
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    if (body.ref !== "refs/heads/main") {
      return c.json({ ok: true });
    }

    log(
      `push to main detected (SHA: ${body.after?.slice(0, 12) ?? "unknown"}) — triggering graceful deploy`,
    );
    const pushSha = body.after;
    setImmediate(() => deps.onPushToMain(pushSha));
    return c.json({ ok: true });
  });

  return app;
}
