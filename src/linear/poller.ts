// ---------------------------------------------------------------------------
// Linear poller — fallback polling when tunnel is down
// ---------------------------------------------------------------------------

import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import { fullSync, type SyncResult } from "./sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PollerDeps {
  db: OrcaDb;
  client: LinearClient;
  graph: DependencyGraph;
  config: OrcaConfig;
  isTunnelConnected: () => boolean;
}

export interface PollerHealth {
  consecutiveFailures: number;
  currentIntervalMs: number;
  lastError: string | null;
  lastErrorCategory: "transient" | "permanent" | null;
  lastSuccessAt: string | null;
  lastSyncResult: SyncResult | null;
  stopped: boolean;
}

export interface PollerHandle {
  start(): void;
  stop(): void;
  health(): PollerHealth;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[orca/poller] ${message}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 30_000;
export const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes
export const JITTER_FACTOR = 0.2; // ±20% jitter

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/** Deterministic base backoff: 30s * 2^(failures-1), capped at 5 min. */
export function computeBackoffMs(failures: number): number {
  if (failures <= 0) return POLL_INTERVAL_MS;
  const base = POLL_INTERVAL_MS * Math.pow(2, failures - 1);
  return Math.min(base, MAX_BACKOFF_MS);
}

/** Backoff with ±20% jitter for actual scheduling (prevents thundering herd). */
export function computeBackoffWithJitterMs(
  failures: number,
  randomFn: () => number = Math.random,
): number {
  const base = computeBackoffMs(failures);
  if (failures <= 0) return base;
  const jitter = base * JITTER_FACTOR * (2 * randomFn() - 1);
  return Math.max(POLL_INTERVAL_MS, Math.round(base + jitter));
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function isPermanentError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("authentication failed") || msg.includes("HTTP 401") || msg.includes("HTTP 403");
}

// ---------------------------------------------------------------------------
// 7.1 Timer-based poller with exponential backoff
// ---------------------------------------------------------------------------

export function createPoller(deps: PollerDeps): PollerHandle {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastPollActive = false;
  let polling = false;
  let stopped = false;

  // Backoff state
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastErrorCategory: "transient" | "permanent" | null = null;
  let lastSuccessAt: string | null = null;
  let lastSyncResult: SyncResult | null = null;

  function scheduleNext(): void {
    if (stopped) return;
    const interval = computeBackoffWithJitterMs(consecutiveFailures);
    timerId = setTimeout(() => {
      tick().then(() => scheduleNext());
    }, interval);
  }

  async function tick(): Promise<void> {
    // Prevent overlapping ticks
    if (polling) return;
    polling = true;

    try {
      const tunnelUp = deps.isTunnelConnected();

      if (tunnelUp) {
        // 7.2 Tunnel recovered — log once and skip
        if (lastPollActive) {
          log("tunnel recovered, stopping poll");
          lastPollActive = false;
        }
        // Tunnel up is not a failure — reset backoff
        consecutiveFailures = 0;
        lastError = null;
        lastErrorCategory = null;
        return;
      }

      // 7.2 Tunnel is down — poll
      if (!lastPollActive) {
        log("tunnel down, polling Linear...");
        lastPollActive = true;
      }

      // 7.3 Reuse fullSync for simplicity — it's idempotent
      const result = await fullSync(deps.db, deps.client, deps.graph, deps.config);
      lastSyncResult = result;

      // Partial failure: some issues failed to upsert but the sync itself didn't throw.
      // Treat as a soft failure — track it but don't escalate backoff as aggressively.
      if (result.failed > 0) {
        consecutiveFailures++;
        lastError = `${result.failed}/${result.total} issues failed to sync`;
        lastErrorCategory = "transient";
        const nextInterval = computeBackoffMs(consecutiveFailures);
        log(
          `partial sync failure (failure #${consecutiveFailures}, next retry in ${Math.round(nextInterval / 1000)}s): ${lastError}`,
        );
        // Still update lastSuccessAt since we did process some issues
        if (result.succeeded > 0) {
          lastSuccessAt = new Date().toISOString();
        }
        return;
      }

      // Full success — reset backoff
      if (consecutiveFailures > 0) {
        log(`recovered after ${consecutiveFailures} consecutive failure(s)`);
      }
      consecutiveFailures = 0;
      lastError = null;
      lastErrorCategory = null;
      lastSuccessAt = new Date().toISOString();
    } catch (err) {
      consecutiveFailures++;
      lastError = String(err);

      if (isPermanentError(err)) {
        lastErrorCategory = "permanent";
        log(`permanent error, stopping poller: ${err}`);
        stopped = true;
        return;
      }

      lastErrorCategory = "transient";
      const nextInterval = computeBackoffMs(consecutiveFailures);
      log(
        `poll error (failure #${consecutiveFailures}, next retry in ${Math.round(nextInterval / 1000)}s): ${err}`,
      );
    } finally {
      polling = false;
    }
  }

  return {
    start(): void {
      if (timerId !== null) return; // Already started
      stopped = false;
      scheduleNext();
      log("started (interval: 30s)");
    },

    stop(): void {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
        log("stopped");
      }
    },

    health(): PollerHealth {
      return {
        consecutiveFailures,
        currentIntervalMs: computeBackoffMs(consecutiveFailures),
        lastError,
        lastErrorCategory,
        lastSuccessAt,
        lastSyncResult,
        stopped,
      };
    },
  };
}
