// Monitor snapshot — health-checks orca and writes JSONL snapshots + alerts
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultState, processCheckResult } from "./monitor-snapshot-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
const TMP_DIR = join(PROJECT_DIR, "tmp");
const DEPLOY_STATE_FILE = join(PROJECT_DIR, "deploy-state.json");
const MONITOR_STATE_FILE = join(TMP_DIR, "monitor-snapshot-state.json");
const ALERTS_FILE = join(TMP_DIR, "alerts.jsonl");
const HEALTH_CHECK_TIMEOUT_MS = 5000;

function ensureTmpDir() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function readActivePort() {
  if (!existsSync(DEPLOY_STATE_FILE)) return 4000;
  try {
    const data = JSON.parse(readFileSync(DEPLOY_STATE_FILE, "utf8"));
    return data.activePort || 4000;
  } catch {
    return 4000;
  }
}

function loadMonitorState() {
  if (!existsSync(MONITOR_STATE_FILE)) return defaultState();
  try {
    return JSON.parse(readFileSync(MONITOR_STATE_FILE, "utf8"));
  } catch {
    return defaultState();
  }
}

function saveMonitorState(state) {
  writeFileSync(MONITOR_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function snapshotFile(nowIso) {
  // UTC date portion: YYYY-MM-DD
  const date = nowIso.slice(0, 10);
  return join(TMP_DIR, `orca-monitor-${date}.jsonl`);
}

function appendJsonl(filePath, obj) {
  appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function postWebhook(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Fire-and-forget; don't crash if webhook is unreachable
  } finally {
    clearTimeout(timer);
  }
}

async function emitAlert(alert) {
  const webhookUrl = process.env.ORCA_ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    await postWebhook(webhookUrl, alert);
  } else {
    appendJsonl(ALERTS_FILE, alert);
  }
}

/**
 * @param {number} port
 * @returns {Promise<{ up: boolean, port: number|null, error: string|null }>}
 */
async function checkHealth(port) {
  const url = `http://localhost:${port}/api/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return { up: true, port, error: null };
    }
    return { up: false, port: null, error: `HTTP_${res.status}` };
  } catch (err) {
    clearTimeout(timer);
    // Extract a short error code: prefer err.cause.code (e.g. ECONNREFUSED), else err.code, else name
    const code =
      (err.cause && err.cause.code) ||
      err.code ||
      (err.name === "AbortError" ? "ETIMEDOUT" : err.name) ||
      "UNKNOWN";
    return { up: false, port: null, error: code };
  }
}

/**
 * Fetch failed tasks from the API and return them with truncated reason.
 * @param {number} port
 * @returns {Promise<{ id: string, reason: string }[]>}
 */
async function fetchFailedTasks(port) {
  const url = `http://localhost:${port}/api/tasks`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const tasks = await res.json();
    return tasks
      .filter((t) => t.orcaStatus === "failed" && t.lastFailureReason)
      .map((t) => ({
        id: t.linearIssueId,
        reason: t.lastFailureReason.length > 80
          ? t.lastFailureReason.slice(0, 80) + "…"
          : t.lastFailureReason,
      }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}

async function main() {
  ensureTmpDir();

  const nowIso = new Date().toISOString();
  const port = readActivePort();
  const prevState = loadMonitorState();

  // Carry forward lastKnownPort from actual port read (even if DOWN, we know which port we checked)
  const stateWithPort = {
    ...prevState,
    lastKnownPort: prevState.lastKnownPort || port,
  };

  const checkResult = await checkHealth(port);

  let failedTasks = [];
  if (checkResult.up) {
    failedTasks = await fetchFailedTasks(port);
  }

  const { snapshot, newState, alert } = processCheckResult(
    stateWithPort,
    checkResult,
    nowIso,
    failedTasks,
  );

  // Write snapshot
  const snapshotPath = snapshotFile(nowIso);
  appendJsonl(snapshotPath, snapshot);

  // Persist state (update lastKnownPort to current port if UP, else keep prev)
  saveMonitorState(newState);

  // Emit alert if any
  if (alert) {
    await emitAlert(alert);
  }

  // Log to stdout
  console.log(JSON.stringify(snapshot));
  if (alert) {
    console.log("[monitor-snapshot] ALERT:", JSON.stringify(alert));
  }
}

main().catch((e) => {
  console.error("[monitor-snapshot] fatal:", e.message);
  process.exit(1);
});
