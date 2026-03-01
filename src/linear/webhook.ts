// ---------------------------------------------------------------------------
// Linear webhook HTTP endpoint — Hono route with HMAC-SHA256 verification
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.js";
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient, WorkflowStateMap } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import { processWebhookEvent, type WebhookEvent } from "./sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  db: OrcaDb;
  client: LinearClient;
  graph: DependencyGraph;
  config: OrcaConfig;
  stateMap: WorkflowStateMap;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logger = createLogger("webhook");
function log(message: string): void { logger.info(message); }

// ---------------------------------------------------------------------------
// 5.2 HMAC-SHA256 verification
// ---------------------------------------------------------------------------

function verifySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");

  // Timing-safe comparison — both must be the same length as Buffers
  const sigBuffer = Buffer.from(signature, "utf-8");
  const computedBuffer = Buffer.from(computed, "utf-8");

  if (sigBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(sigBuffer, computedBuffer);
}

// ---------------------------------------------------------------------------
// 5.1 Hono route
// ---------------------------------------------------------------------------

export function createWebhookRoute(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.post("/api/webhooks/linear", async (c) => {
    // 5.2 Verify signature
    const signature = c.req.header("linear-signature");
    if (!signature) {
      log("rejected: missing signature header");
      return c.json({ error: "invalid signature" }, 401);
    }

    const rawBody = await c.req.text();

    if (!verifySignature(rawBody, signature, deps.config.linearWebhookSecret)) {
      log("rejected: invalid signature");
      return c.json({ error: "invalid signature" }, 401);
    }

    // 5.3 Parse and filter
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      log("rejected: invalid JSON body");
      return c.json({ error: "invalid signature" }, 401);
    }

    // Only process Issue events
    if (event.type !== "Issue") {
      return c.json({ ok: true });
    }

    // Filter by project if projectId is present
    if (
      event.data.projectId &&
      !deps.config.linearProjectIds.includes(event.data.projectId)
    ) {
      return c.json({ ok: true });
    }

    // 5.3 Pass to sync module
    try {
      await processWebhookEvent(
        deps.db,
        deps.client,
        deps.graph,
        deps.config,
        deps.stateMap,
        event,
      );
    } catch (err) {
      log(`error processing webhook event: ${err}`);
      // Still return 200 to prevent Linear from retrying
    }

    // 5.4 Success response
    return c.json({ ok: true });
  });

  return app;
}
