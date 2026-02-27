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

export interface PollerDeps {
  db: OrcaDb;
  client: LinearClient;
  graph: DependencyGraph;
  config: OrcaConfig;
  isTunnelConnected: () => boolean;
}

export interface PollerHandle {
  start(): void;
  stop(): void;
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

const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// 7.1 Timer-based poller
// ---------------------------------------------------------------------------

export function createPoller(deps: PollerDeps): PollerHandle {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let lastPollActive = false;
  let polling = false;

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
        return;
      }

      // 7.2 Tunnel is down — poll
      if (!lastPollActive) {
        log("tunnel down, polling Linear...");
        lastPollActive = true;
      }

      // 7.3 Reuse fullSync for simplicity — it's idempotent
      await fullSync(deps.db, deps.client, deps.graph, deps.config);
    } catch (err) {
      log(`poll error: ${err}`);
    } finally {
      polling = false;
    }
  }

  return {
    start(): void {
      if (intervalId !== null) return; // Already started
      intervalId = setInterval(() => {
        tick();
      }, POLL_INTERVAL_MS);
      log("started (interval: 30s)");
    },

    stop(): void {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
        log("stopped");
      }
    },
  };
}
