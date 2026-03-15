// ecosystem.config.cjs
const path = require("path");

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

module.exports = {
  apps: [makeApp(4000), makeApp(4001)],
};
