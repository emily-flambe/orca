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
 * @returns {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string, prevBudgetUsed: number|null, prevSnapshotTs: string|null }}
 */
export function defaultState() {
  return {
    lastKnownPort: 4000,
    consecutiveDownCount: 0,
    downtimeStartedAt: null,
    lastStatus: "UP",
    prevBudgetUsed: null,
    prevSnapshotTs: null,
  };
}

/**
 * Compute the new state and any alerts from a check result.
 *
 * @param {{ lastKnownPort: number, consecutiveDownCount: number, downtimeStartedAt: string|null, lastStatus: string, prevBudgetUsed: number|null, prevSnapshotTs: string|null }} prevState
 * @param {{ up: boolean, port: number|null, error: string|null }} checkResult
 * @param {string} nowIso - ISO timestamp for this snapshot
 * @param {{ used: number, limit: number }|null} budgetData
 * @param {{ burnRateAlertThreshold?: number }} config
 * @returns {{
 *   snapshot: object,
 *   newState: object,
 *   alert: object|null,
 *   budgetAlerts: object[],
 * }}
 */
export function processCheckResult(
  prevState,
  checkResult,
  nowIso,
  budgetData = null,
  config = {},
) {
  const { up, port, error } = checkResult;
  const wasDown = prevState.lastStatus === "DOWN";
  const threshold = config.burnRateAlertThreshold ?? 20;

  if (up) {
    // Compute burn rate and budget alerts if budget data provided
    let burnRatePerHour = null;
    let projectedCapHitAt = null;
    const budgetAlerts = [];

    if (budgetData != null) {
      if (
        prevState.prevBudgetUsed != null &&
        prevState.prevSnapshotTs != null
      ) {
        const timeDeltaHours =
          (new Date(nowIso) - new Date(prevState.prevSnapshotTs)) / 3600000;
        if (timeDeltaHours > 0 && budgetData.used >= prevState.prevBudgetUsed) {
          burnRatePerHour =
            (budgetData.used - prevState.prevBudgetUsed) / timeDeltaHours;
          if (
            burnRatePerHour > 0 &&
            budgetData.limit > 0 &&
            budgetData.used < budgetData.limit
          ) {
            projectedCapHitAt = new Date(
              new Date(nowIso).getTime() +
                ((budgetData.limit - budgetData.used) / burnRatePerHour) *
                  3600000,
            ).toISOString();
          }
        }
      }

      if (burnRatePerHour != null && burnRatePerHour > threshold) {
        budgetAlerts.push({
          ts: nowIso,
          type: "budget_burn_rate_high",
          burnRatePerHour,
          threshold,
          projectedCapHitAt,
          message: `Budget burn rate $${burnRatePerHour.toFixed(2)}/hr exceeds threshold $${threshold}/hr`,
        });
      }

      if (budgetData.limit > 0 && budgetData.used / budgetData.limit > 0.7) {
        budgetAlerts.push({
          ts: nowIso,
          type: "budget_window_high",
          used: budgetData.used,
          limit: budgetData.limit,
          pct: Math.round((budgetData.used / budgetData.limit) * 100),
          message: `Budget window is ${Math.round((budgetData.used / budgetData.limit) * 100)}% consumed ($${budgetData.used.toFixed(2)} of $${budgetData.limit.toFixed(2)})`,
        });
      }
    }

    // Compute new state
    const newState = {
      lastKnownPort: port,
      consecutiveDownCount: 0,
      downtimeStartedAt: null,
      lastStatus: "UP",
      prevBudgetUsed:
        budgetData != null ? budgetData.used : prevState.prevBudgetUsed,
      prevSnapshotTs: budgetData != null ? nowIso : prevState.prevSnapshotTs,
    };

    let snapshot;
    let alert = null;

    if (wasDown && prevState.downtimeStartedAt) {
      // Recovery
      const downtimeMs =
        new Date(nowIso) - new Date(prevState.downtimeStartedAt);
      const downtimeDuration = formatDuration(Math.floor(downtimeMs / 1000));
      snapshot = {
        ts: nowIso,
        status: "UP",
        port,
        recoveredFromDowntime: true,
        downtimeDuration,
        downtimeStartedAt: prevState.downtimeStartedAt,
      };
      alert = {
        ts: nowIso,
        type: "recovery",
        downtimeDuration,
        downtimeStartedAt: prevState.downtimeStartedAt,
        message: `Orca recovered after ${downtimeDuration} downtime`,
      };
    } else {
      // Normal UP
      snapshot = {
        ts: nowIso,
        status: "UP",
        port,
      };
    }

    if (budgetData != null) {
      snapshot.budget = {
        used: budgetData.used,
        limit: budgetData.limit,
        burnRatePerHour: burnRatePerHour ?? null,
        projectedCapHitAt: projectedCapHitAt ?? null,
      };
    }

    return { snapshot, newState, alert, budgetAlerts };
  } else {
    // DOWN
    const consecutiveDownCount = prevState.consecutiveDownCount + 1;
    const downtimeStartedAt = prevState.downtimeStartedAt ?? nowIso;
    const lastKnownPort = prevState.lastKnownPort;

    const snapshot = {
      ts: nowIso,
      status: "DOWN",
      error: error ?? "UNKNOWN",
      lastKnownPort,
      consecutiveDownCount,
    };

    const newState = {
      lastKnownPort,
      consecutiveDownCount,
      downtimeStartedAt,
      lastStatus: "DOWN",
      prevBudgetUsed: prevState.prevBudgetUsed,
      prevSnapshotTs: prevState.prevSnapshotTs,
    };

    // Alert on 2nd DOWN and every subsequent DOWN
    let alert = null;
    if (consecutiveDownCount >= 2) {
      alert = {
        ts: nowIso,
        type: "downtime_alert",
        consecutiveDownCount,
        lastKnownPort,
        downtimeStartedAt,
        message: `Orca has been DOWN for ${consecutiveDownCount} consecutive snapshots (~${(consecutiveDownCount - 1) * 15}+ min)`,
      };
    }

    return { snapshot, newState, alert, budgetAlerts: [] };
  }
}
