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
 * @returns {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string, consecutiveStuckDrainCount: number, stuckDrainStartedAt: string|null }}
 */
export function defaultState() {
  return {
    lastKnownPort: 4000,
    consecutiveDownCount: 0,
    downtimeStartedAt: null,
    lastStatus: 'UP',
    consecutiveStuckDrainCount: 0,
    stuckDrainStartedAt: null,
  };
}

/**
 * Compute the new state and any alerts from a check result.
 *
 * @param {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string, consecutiveStuckDrainCount: number, stuckDrainStartedAt: string|null }} prevState
 * @param {{ up: boolean, port: number|null, error: string|null, draining?: boolean, drainingForSeconds?: number, activeSessions?: number }} checkResult
 * @param {string} nowIso - ISO timestamp for this snapshot
 * @returns {{
 *   snapshot: object,
 *   newState: object,
 *   alert: object|null,
 * }}
 */
export function processCheckResult(prevState, checkResult, nowIso) {
  const { up, port, error, draining, drainingForSeconds, activeSessions } = checkResult;
  const wasDown = prevState.lastStatus === 'DOWN';

  if (up) {
    // Detect stuck drain: draining=true with zero active sessions
    const isStuckDrain = draining === true && activeSessions === 0;
    const consecutiveStuckDrainCount = isStuckDrain
      ? (prevState.consecutiveStuckDrainCount ?? 0) + 1
      : 0;
    const stuckDrainStartedAt = isStuckDrain
      ? (prevState.stuckDrainStartedAt ?? nowIso)
      : null;

    // Compute new state first
    const newState = {
      lastKnownPort: port,
      consecutiveDownCount: 0,
      downtimeStartedAt: null,
      lastStatus: 'UP',
      consecutiveStuckDrainCount,
      stuckDrainStartedAt,
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

    // Include drain info in snapshot when draining
    if (draining) {
      snapshot.draining = true;
      if (drainingForSeconds !== undefined) {
        snapshot.drainingForSeconds = drainingForSeconds;
      }
      if (activeSessions !== undefined) {
        snapshot.activeSessions = activeSessions;
      }
    }

    // Alert on 2nd consecutive snapshot with drain+zero-sessions (and every subsequent one)
    if (consecutiveStuckDrainCount >= 2) {
      const stuckForSeconds = stuckDrainStartedAt
        ? Math.floor((new Date(nowIso) - new Date(stuckDrainStartedAt)) / 1000)
        : null;
      const stuckDuration = stuckForSeconds !== null ? formatDuration(stuckForSeconds) : 'unknown';
      alert = {
        ts: nowIso,
        type: 'stuck_drain_alert',
        consecutiveStuckDrainCount,
        stuckDrainStartedAt,
        drainingForSeconds,
        message: `Orca drain stuck: draining with zero active sessions for ${consecutiveStuckDrainCount} consecutive snapshots (~${stuckDuration})`,
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
      consecutiveStuckDrainCount: 0,
      stuckDrainStartedAt: null,
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
