// ---------------------------------------------------------------------------
// Linear poller — fallback polling when tunnel is down
// ---------------------------------------------------------------------------

import type { OrcaDb } from "../db/index.js";
import type { OrcaConfig } from "../config/index.js";
import type { LinearClient } from "./client.js";
import type { DependencyGraph } from "./graph.js";
import { fullSync } from "./sync.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorKind = "transient" | "permanent";

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
  lastErrorKind: ErrorKind | null;
  lastSuccessAt: string | null;
  circuitOpen: boolean;
  halted: boolean;
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
export const CIRCUIT_OPEN_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(err: unknown): ErrorKind {
  const msg = String(err);
  if (msg.includes("authentication failed")) return "permanent";
  return "transient";
}

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

export function computeBackoffMs(failures: number): number {
  if (failures <= 0) return POLL_INTERVAL_MS;
  // Exponential: 30s * 2^(failures-1), capped at 5 min
  const backoff = POLL_INTERVAL_MS * Math.pow(2, failures - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

/**
 * Add ±20% random jitter to an interval to prevent thundering herd.
 * Exported for testing — pass a fixed random value to make it deterministic.
 */
export function addJitter(ms: number, rand: number = Math.random()): number {
  const factor = 0.8 + rand * 0.4; // 0.8 to 1.2
  return Math.round(ms * factor);
}

// ---------------------------------------------------------------------------
// 7.1 Timer-based poller with exponential backoff + error recovery
// ---------------------------------------------------------------------------

export function createPoller(deps: PollerDeps): PollerHandle {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastPollActive = false;
  let polling = false;
  let stopped = false;

  // Backoff state
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastErrorKind: ErrorKind | null = null;
  let lastSuccessAt: string | null = null;
  let halted = false; // permanent error — stop retrying

  function scheduleNext(): void {
    if (stopped || halted) return;
    const base = computeBackoffMs(consecutiveFailures);
    const interval = addJitter(base);
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
        lastErrorKind = null;
        return;
      }

      // 7.2 Tunnel is down — poll
      if (!lastPollActive) {
        log("tunnel down, polling Linear...");
        lastPollActive = true;
      }

      // 7.3 Reuse fullSync for simplicity — it's idempotent
      await fullSync(deps.db, deps.client, deps.graph, deps.config);

      // Success — reset backoff
      if (consecutiveFailures > 0) {
        log(`recovered after ${consecutiveFailures} consecutive failure(s)`);
      }
      consecutiveFailures = 0;
      lastError = null;
      lastErrorKind = null;
      lastSuccessAt = new Date().toISOString();
    } catch (err) {
      consecutiveFailures++;
      lastError = String(err);
      lastErrorKind = classifyError(err);

      // Permanent errors (e.g. auth failures) — halt polling entirely
      if (lastErrorKind === "permanent") {
        halted = true;
        log(`CRITICAL: permanent error, polling halted: ${err}`);
        return;
      }

      // Circuit breaker — log critical once when threshold is crossed
      if (consecutiveFailures === CIRCUIT_OPEN_THRESHOLD) {
        log(
          `CRITICAL: ${CIRCUIT_OPEN_THRESHOLD} consecutive failures, circuit open — retries continue at max backoff`,
        );
      }

      const nextInterval = computeBackoffMs(consecutiveFailures);
      log(
        `poll error (failure #${consecutiveFailures}, next retry ~${Math.round(nextInterval / 1000)}s): ${err}`,
      );
    } finally {
      polling = false;
    }
  }

  return {
    start(): void {
      if (timerId !== null) return; // Already started
      stopped = false;
      halted = false;
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
        lastErrorKind,
        lastSuccessAt,
        circuitOpen: consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD,
        halted,
      };
    },
  };
}
