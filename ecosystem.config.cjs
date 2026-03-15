// ecosystem.config.cjs
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Load .env so Inngest keys are available for CLI args
// ---------------------------------------------------------------------------
function loadDotenv() {
  const envPath = path.join(__dirname, ".env");
  const vars = {};
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch {
    // .env may not exist — use defaults
  }
  return vars;
}

const dotenv = loadDotenv();

// ---------------------------------------------------------------------------
// Orca app instances (blue/green deploy on ports 4000/4001)
// ---------------------------------------------------------------------------
function makeApp(port) {
  return {
    name: `orca-${port}`,
    script: "./node_modules/tsx/dist/cli.mjs",
    interpreter: "node",
    interpreter_args: "--no-warnings",
    args: "src/cli/index.ts start",
    cwd: __dirname,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    min_uptime: "30s",
    max_memory_restart: "2G",
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 120000,
    watch: false,
    env: {
      ORCA_PORT: String(port),
      ORCA_EXTERNAL_TUNNEL: "true",
      NODE_ENV: "production",
    },
    error_file: path.join(__dirname, "logs", `pm2-orca-${port}-error.log`),
    out_file: path.join(__dirname, "logs", `pm2-orca-${port}-out.log`),
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  };
}

// ---------------------------------------------------------------------------
// Inngest dev server (self-hosted, single-node mode)
// ---------------------------------------------------------------------------
const inngestEventKey = dotenv.INNGEST_EVENT_KEY || "local";
const inngestSigningKey = dotenv.INNGEST_SIGNING_KEY || "local";

const inngestApp = {
  name: "inngest",
  script: path.join(__dirname, "node_modules", "inngest-cli", "bin", process.platform === "win32" ? "inngest.exe" : "inngest"),
  interpreter: "none",
  args: [
    "start",
    "--sqlite-dir", path.join(__dirname, ".inngest"),
    "--port", "8288",
    "--event-key", inngestEventKey,
    "--signing-key", inngestSigningKey,
  ].join(" "),
  cwd: __dirname,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  kill_timeout: 5000,
  watch: false,
  error_file: path.join(__dirname, "logs", "pm2-inngest-error.log"),
  out_file: path.join(__dirname, "logs", "pm2-inngest-out.log"),
  merge_logs: true,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
};

module.exports = {
  apps: [makeApp(4000), makeApp(4001), inngestApp],
};
