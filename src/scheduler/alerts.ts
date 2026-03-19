import {
  getInvocationsByTask,
  getTask,
  insertSystemEvent,
  getLastStartup,
  countSystemEventsSince,
  getSystemEventsSince,
} from "../db/queries.js";
import type { OrcaDb } from "../db/index.js";
import type { SchedulerDeps } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("alerts");
const log = (...args: unknown[]) => logger.info(...args);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  message: string;
  fields?: { title: string; value: string; short?: boolean }[];
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ESCALATION_THRESHOLD = 3;
const POST_DEPLOY_GRACE_MS = 600_000; // 10 min
const HEALING_INACTIVITY_RESET_MS = 3_600_000; // 1h

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  info: "#36a64f",
  warning: "warning",
  critical: "danger",
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const alertCooldowns = new Map<string, number>();

const healingCounters = new Map<
  string,
  { count: number; lastAttemptAt: number }
>();

let cachedDb: OrcaDb | null = null;

// ---------------------------------------------------------------------------
// Core alert functions
// ---------------------------------------------------------------------------

/**
 * Send an alert: insert system event, post Linear comment, fire webhook.
 * NEVER throws — all internal operations are individually try/caught.
 */
export function sendAlert(deps: SchedulerDeps, payload: AlertPayload): void {
  // 1. Insert system event
  try {
    insertSystemEvent(deps.db, {
      type: "self_heal",
      message: `[${payload.severity}] ${payload.title}: ${payload.message}`,
      metadata: {
        severity: payload.severity,
        title: payload.title,
        taskId: payload.taskId,
        fields: payload.fields,
      },
    });
  } catch (err) {
    log(`sendAlert: DB insert failed: ${err}`);
  }

  // 2. Post Linear comment (if taskId is set)
  if (payload.taskId) {
    try {
      deps.client
        .createComment(
          payload.taskId,
          `**[Orca Self-Heal] ${payload.title}**\n\n${payload.message}`,
        )
        .catch((err: unknown) => {
          log(`sendAlert: Linear comment failed for ${payload.taskId}: ${err}`);
        });
    } catch (err) {
      log(`sendAlert: Linear comment setup failed: ${err}`);
    }
  }

  // 3. Fire webhook (if configured)
  if (deps.config.alertWebhookUrl) {
    try {
      const webhookPayload = {
        text: `Orca: [${payload.severity}] ${payload.title}`,
        attachments: [
          {
            color: SEVERITY_COLORS[payload.severity],
            title: payload.title,
            text: payload.message,
            fields: payload.fields ?? [],
          },
        ],
      };

      fetch(deps.config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload),
      })
        .then((res) => {
          if (!res.ok) {
            log(`sendAlert: webhook returned ${res.status}`);
          }
        })
        .catch((err: unknown) => {
          log(`sendAlert: webhook failed: ${err}`);
        });
    } catch (err) {
      log(`sendAlert: webhook setup failed: ${err}`);
    }
  }
}

/**
 * Send an alert with per-key cooldown to prevent spam.
 */
export function sendAlertThrottled(
  deps: SchedulerDeps,
  key: string,
  payload: AlertPayload,
  cooldownMs: number,
): void {
  const now = Date.now();
  const lastSent = alertCooldowns.get(key);
  if (lastSent && now - lastSent < cooldownMs) {
    return;
  }
  alertCooldowns.set(key, now);
  sendAlert(deps, payload);
}

// ---------------------------------------------------------------------------
// Healing attempt tracking
// ---------------------------------------------------------------------------

/**
 * Initialize the alert system. Called once at startup.
 * Caches the DB reference for trackHealingAttempt's post-deploy grace check.
 */
export function initAlertSystem(db: OrcaDb): void {
  cachedDb = db;

  try {
    const oneHourAgo = new Date(
      Date.now() - HEALING_INACTIVITY_RESET_MS,
    ).toISOString();
    const selfHealCount = countSystemEventsSince(db, oneHourAgo, "self_heal");
    const healthCheckCount = countSystemEventsSince(
      db,
      oneHourAgo,
      "health_check",
    );
    log(
      `initAlertSystem: found ${selfHealCount} self_heal + ${healthCheckCount} health_check events in last 1h`,
    );

    // Reconstruct healingCounters from recent self_heal events
    const recentHeals = getSystemEventsSince(db, oneHourAgo, "self_heal");
    const countersByKey = new Map<
      string,
      { count: number; lastAttemptAt: number }
    >();
    for (const event of recentHeals) {
      let key = "unknown";
      if (event.metadata) {
        try {
          const meta = JSON.parse(event.metadata);
          if (meta.title) {
            key = meta.title;
          }
        } catch {
          // metadata not valid JSON — use "unknown"
        }
      }
      const eventTime = new Date(event.createdAt).getTime();
      const existing = countersByKey.get(key);
      if (existing) {
        existing.count++;
        if (eventTime > existing.lastAttemptAt) {
          existing.lastAttemptAt = eventTime;
        }
      } else {
        countersByKey.set(key, { count: 1, lastAttemptAt: eventTime });
      }
    }
    for (const [key, value] of countersByKey) {
      healingCounters.set(key, value);
    }

    if (countersByKey.size > 0) {
      log(
        `initAlertSystem: reconstructed ${countersByKey.size} healing counter(s) from DB`,
      );
    }
  } catch (err) {
    log(`initAlertSystem: counter reconstruction failed (non-fatal): ${err}`);
  }
}

/**
 * Track a healing attempt. Returns the current count for this key.
 * Resets after 1h of inactivity. Excludes events within 10 min of last startup.
 */
export function trackHealingAttempt(key: string): number {
  const now = Date.now();

  // Post-deploy exclusion
  if (cachedDb) {
    try {
      const lastStartup = getLastStartup(cachedDb);
      if (lastStartup) {
        const startupTime = new Date(lastStartup.createdAt).getTime();
        if (now - startupTime < POST_DEPLOY_GRACE_MS) {
          return 0;
        }
      }
    } catch {
      // If DB query fails, proceed without exclusion
    }
  }

  const entry = healingCounters.get(key);
  if (entry && now - entry.lastAttemptAt > HEALING_INACTIVITY_RESET_MS) {
    healingCounters.delete(key);
  }

  const current = healingCounters.get(key) ?? { count: 0, lastAttemptAt: now };
  current.count++;
  current.lastAttemptAt = now;
  healingCounters.set(key, current);

  return current.count;
}

/**
 * Returns true after 3 healing attempts in 1h for the same key.
 */
export function shouldEscalate(key: string): boolean {
  const entry = healingCounters.get(key);
  if (!entry) return false;

  const now = Date.now();
  if (now - entry.lastAttemptAt > HEALING_INACTIVITY_RESET_MS) {
    healingCounters.delete(key);
    return false;
  }

  return entry.count >= ESCALATION_THRESHOLD;
}

/**
 * Clear all counters. Called on auto-undrain.
 */
export function resetHealingCounters(): void {
  healingCounters.clear();
  alertCooldowns.clear();
}

/**
 * Returns the timestamp of the most recent healing attempt across all keys.
 */
export function lastHealingAttemptTimestamp(): number | null {
  let latest: number | null = null;
  for (const entry of healingCounters.values()) {
    if (latest === null || entry.lastAttemptAt > latest) {
      latest = entry.lastAttemptAt;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Legacy wrapper (preserved for backward compat)
// ---------------------------------------------------------------------------

export function sendPermanentFailureAlert(
  deps: SchedulerDeps,
  taskId: string,
  reason: string,
): void {
  const { db, config } = deps;
  const task = getTask(db, taskId);
  const invocations = getInvocationsByTask(db, taskId);
  const invocationIds = invocations.map((inv) => inv.id).join(", ") || "none";
  const retryCount = task?.retryCount ?? 0;
  const maxRetries = config.maxRetries;

  const message = [
    `**Task permanently failed**`,
    ``,
    `**Reason:** ${reason}`,
    `**Retry count:** ${retryCount}/${maxRetries}`,
    `**Invocations:** ${invocationIds}`,
  ].join("\n");

  sendAlert(deps, {
    severity: "critical",
    title: "Permanent Task Failure",
    message,
    taskId,
    fields: [
      { title: "Task ID", value: taskId, short: true },
      {
        title: "Retry count",
        value: `${retryCount}/${maxRetries}`,
        short: true,
      },
      { title: "Reason", value: reason, short: false },
      { title: "Invocations", value: invocationIds, short: false },
    ],
  });
}

// ---------------------------------------------------------------------------
// Zero-cost failure circuit breaker
// ---------------------------------------------------------------------------

/** In-memory log of zero-cost failure timestamps. */
const zeroCostFailures: number[] = [];

const ZERO_COST_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Number of zero-cost failures in the rolling window that trips the circuit breaker. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Record a zero-cost failure (session completed with $0 cost and non-zero exit).
 * Prunes entries older than the window.
 */
export function trackZeroCostFailure(): void {
  const now = Date.now();
  // Prune old entries
  const cutoff = now - ZERO_COST_WINDOW_MS;
  while (zeroCostFailures.length > 0 && zeroCostFailures[0] < cutoff) {
    zeroCostFailures.shift();
  }
  zeroCostFailures.push(now);
}

/**
 * Count zero-cost failures within the rolling window.
 */
export function countZeroCostFailuresInWindow(): number {
  const cutoff = Date.now() - ZERO_COST_WINDOW_MS;
  return zeroCostFailures.filter((t) => t >= cutoff).length;
}

/**
 * Returns true if the circuit breaker should trip (threshold failures in window).
 */
export function isCircuitBreakerTripped(threshold: number): boolean {
  return countZeroCostFailuresInWindow() >= threshold;
}

/** Reset for tests. */
export function resetZeroCostFailures(): void {
  zeroCostFailures.length = 0;
}

/** @internal */
export function _getZeroCostFailures(): number[] {
  return zeroCostFailures;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal */
export function _getHealingCounters(): Map<
  string,
  { count: number; lastAttemptAt: number }
> {
  return healingCounters;
}

/** @internal */
export function _getAlertCooldowns(): Map<string, number> {
  return alertCooldowns;
}
