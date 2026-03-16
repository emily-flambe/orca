import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE_FILE = 'tmp/task-state-tracking.json';
const TRANSIENT_THRESHOLD = 2;
const AWAITING_CI_THRESHOLD = 4;
const SNAPSHOT_INTERVAL_MINUTES = 15;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const TRANSIENT_STATUSES = new Set(['running', 'dispatched', 'in_review']);

export function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {};
  }
  try {
    const contents = readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(contents);
  } catch {
    return {};
  }
}

export function saveState(state) {
  const dir = dirname(STATE_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * @param {Record<string, {status: string, firstSeenAt: string, consecutiveSnapshots: number, retryCount: number}>} previousState
 * @param {Array<{taskId: string, status: string, retryCount: number}>} tasks
 * @param {Date} now
 * @returns {{ newState: typeof previousState, alerts: Array<{taskId: string, status: string, consecutiveSnapshots: number, durationMinutes: number, retryCount: number}> }}
 */
export function updateState(previousState, tasks, now = new Date()) {
  const newState = {};
  const alerts = [];
  const nowIso = now.toISOString();

  for (const task of tasks) {
    const { taskId, status, retryCount } = task;

    // Skip terminal statuses — don't track them
    if (TERMINAL_STATUSES.has(status)) {
      continue;
    }

    const prev = previousState[taskId];

    let consecutiveSnapshots;
    let firstSeenAt;

    if (!prev || prev.status !== status) {
      // New task or status changed — start fresh
      consecutiveSnapshots = 1;
      firstSeenAt = nowIso;
    } else {
      // Same status as before — increment counter
      consecutiveSnapshots = prev.consecutiveSnapshots + 1;
      firstSeenAt = prev.firstSeenAt;
    }

    newState[taskId] = {
      status,
      firstSeenAt,
      consecutiveSnapshots,
      retryCount,
    };

    // Determine threshold for this status
    let threshold = null;
    if (status === 'awaiting_ci') {
      threshold = AWAITING_CI_THRESHOLD;
    } else if (TRANSIENT_STATUSES.has(status)) {
      threshold = TRANSIENT_THRESHOLD;
    }

    if (threshold !== null && consecutiveSnapshots >= threshold) {
      alerts.push({
        taskId,
        status,
        consecutiveSnapshots,
        durationMinutes: consecutiveSnapshots * SNAPSHOT_INTERVAL_MINUTES,
        retryCount,
      });
    }
  }

  return { newState, alerts };
}

/**
 * @param {Array<{taskId: string, status: string, consecutiveSnapshots: number, durationMinutes: number, retryCount: number}>} alerts
 * @returns {string[]}
 */
export function formatAlerts(alerts) {
  return alerts.map(
    (a) =>
      `⚠️  STUCK: ${a.taskId} in '${a.status}' for ${a.durationMinutes} min (${a.consecutiveSnapshots} snapshots, retry_count=${a.retryCount})`,
  );
}
