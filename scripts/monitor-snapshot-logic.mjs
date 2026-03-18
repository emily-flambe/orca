// Pure functions for monitor-snapshot — no I/O, fully testable

/**
 * Format a duration in seconds as human-readable string, e.g. "16m 9s" or "1h 5m 30s"
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Default state for a fresh monitor-snapshot-state.json
 * @returns {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string }}
 */
export function defaultState() {
  return {
    lastKnownPort: 4000,
    consecutiveDownCount: 0,
    downtimeStartedAt: null,
    lastStatus: 'UP',
  };
}

/**
 * Compute the new state and any alerts from a check result.
 *
 * @param {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string }} prevState
 * @param {{ up: boolean, port: number|null, error: string|null }} checkResult
 * @param {string} nowIso - ISO timestamp for this snapshot
 * @returns {{
 *   snapshot: object,
 *   newState: object,
 *   alert: object|null,
 * }}
 */
export function processCheckResult(prevState, checkResult, nowIso) {
  const { up, port, error } = checkResult;
  const wasDown = prevState.lastStatus === 'DOWN';

  if (up) {
    // Compute new state first
    const newState = {
      lastKnownPort: port,
      consecutiveDownCount: 0,
      downtimeStartedAt: null,
      lastStatus: 'UP',
    };

    let snapshot;
    let alert = null;

    if (wasDown && prevState.downtimeStartedAt) {
      // Recovery
      const downtimeMs = new Date(nowIso) - new Date(prevState.downtimeStartedAt);
      const downtimeDuration = formatDuration(Math.floor(downtimeMs / 1000));
      snapshot = {
        ts: nowIso,
        status: 'UP',
        port,
        recoveredFromDowntime: true,
        downtimeDuration,
        downtimeStartedAt: prevState.downtimeStartedAt,
      };
      alert = {
        ts: nowIso,
        type: 'recovery',
        downtimeDuration,
        downtimeStartedAt: prevState.downtimeStartedAt,
        message: `Orca recovered after ${downtimeDuration} downtime`,
      };
    } else {
      // Normal UP
      snapshot = {
        ts: nowIso,
        status: 'UP',
        port,
      };
    }

    return { snapshot, newState, alert };
  } else {
    // DOWN
    const consecutiveDownCount = prevState.consecutiveDownCount + 1;
    const downtimeStartedAt = prevState.downtimeStartedAt ?? nowIso;
    const lastKnownPort = prevState.lastKnownPort;

    const snapshot = {
      ts: nowIso,
      status: 'DOWN',
      error: error ?? 'UNKNOWN',
      lastKnownPort,
      consecutiveDownCount,
    };

    const newState = {
      lastKnownPort,
      consecutiveDownCount,
      downtimeStartedAt,
      lastStatus: 'DOWN',
    };

    // Alert on 2nd DOWN and every subsequent DOWN
    let alert = null;
    if (consecutiveDownCount >= 2) {
      alert = {
        ts: nowIso,
        type: 'downtime_alert',
        consecutiveDownCount,
        lastKnownPort,
        downtimeStartedAt,
        message: `Orca has been DOWN for ${consecutiveDownCount} consecutive snapshots (~${(consecutiveDownCount - 1) * 15}+ min)`,
      };
    }

    return { snapshot, newState, alert };
  }
}
