import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Live handle to the cloudflared tunnel process. */
export interface TunnelHandle {
  /** Returns whether the tunnel is currently connected. */
  isTunnelConnected(): boolean;
  /** Graceful shutdown: SIGTERM, then SIGKILL after 5 s. Fire-and-forget. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.js";
const logger = createLogger("tunnel");

// ---------------------------------------------------------------------------
// Output pattern matching
// ---------------------------------------------------------------------------

/**
 * Patterns from cloudflared's log output that indicate a successful connection.
 * cloudflared logs messages like:
 *   "Connection <id> registered"
 *   "Registered tunnel connection"
 */
const CONNECTED_PATTERNS = [
  /connection.*registered/i,
  /registered.*tunnel.*connection/i,
  /tunnel.*is.*ready/i,
];

/**
 * Patterns that indicate the tunnel has disconnected or encountered an error.
 */
const DISCONNECTED_PATTERNS = [
  /connection.*disconnected/i,
  /connection.*lost/i,
  /unregistered.*tunnel.*connection/i,
  /quitting/i,
];

function matchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(line));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link startTunnel}. */
export interface TunnelOptions {
  /** Path to the `cloudflared` binary. Defaults to `"cloudflared"`. */
  cloudflaredPath?: string;
  /** Dashboard-managed tunnel token. When set, passes `--token` to cloudflared
   *  and skips local config file / credentials entirely. */
  token?: string;
}

/**
 * Spawn a `cloudflared tunnel run` child process and return a handle for
 * monitoring its connection state and shutting it down.
 *
 * If a {@link TunnelOptions.token | token} is provided the tunnel runs in
 * dashboard-managed mode (`cloudflared tunnel run --token <token>`).
 * Otherwise cloudflared reads its local config files as before.
 *
 * @returns A {@link TunnelHandle} for health checks and shutdown.
 */
export function startTunnel(options?: TunnelOptions): TunnelHandle {
  const bin = options?.cloudflaredPath ?? "cloudflared";
  const token = options?.token;
  let connected = false;
  let proc: ChildProcess | null = null;
  let stopped = false;

  const args = token
    ? ["tunnel", "run", "--token", token]
    : ["tunnel", "run"];

  logger.info(`spawning: ${bin} ${args.join(" ").replace(token ?? "", "<redacted>")}`);

  proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // -----------------------------------------------------------------------
  // Stream handlers
  // -----------------------------------------------------------------------

  function handleLine(line: string): void {
    if (!line) return;

    logger.info(line);

    if (matchesAny(line, CONNECTED_PATTERNS)) {
      if (!connected) {
        logger.info("tunnel connected");
      }
      connected = true;
    } else if (matchesAny(line, DISCONNECTED_PATTERNS)) {
      if (connected) {
        logger.info("tunnel disconnected");
      }
      connected = false;
    }
  }

  // cloudflared writes most status messages to stderr, but we monitor both
  // streams for robustness.
  if (proc.stdout) {
    let stdoutBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      // Keep the last incomplete line in the buffer
      stdoutBuf = lines.pop()!;
      for (const line of lines) {
        handleLine(line);
      }
    });
  }

  if (proc.stderr) {
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop()!;
      for (const line of lines) {
        handleLine(line);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------

  proc.on("error", (err: Error) => {
    logger.error(`spawn error: ${err.message}`);
    connected = false;
    proc = null;
  });

  proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    if (!stopped) {
      // Unexpected exit
      logger.error(
        `process exited unexpectedly (code: ${code ?? "null"}, signal: ${signal ?? "none"})`,
      );
    } else {
      logger.info(
        `process exited (code: ${code ?? "null"}, signal: ${signal ?? "none"})`,
      );
    }
    connected = false;
    proc = null;
  });

  // -----------------------------------------------------------------------
  // Handle
  // -----------------------------------------------------------------------

  return {
    isTunnelConnected(): boolean {
      return connected;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;

      if (!proc || proc.exitCode !== null || proc.killed) {
        logger.info("process already exited, nothing to stop");
        return;
      }

      logger.info("sending SIGTERM to cloudflared");
      proc.kill("SIGTERM");

      // Escalate to SIGKILL after 5 seconds if still alive.
      // Mirrors the killSession pattern from src/runner/index.ts.
      const ref = proc;
      const killTimer = setTimeout(() => {
        if (ref.exitCode === null && !ref.killed) {
          logger.info("cloudflared did not exit within 5 s, sending SIGKILL");
          ref.kill("SIGKILL");
        }
      }, 5_000);

      // If the process exits before the timer fires, clear the timer so it
      // does not keep the event loop alive.
      ref.on("exit", () => {
        clearTimeout(killTimer);
      });
    },
  };
}
