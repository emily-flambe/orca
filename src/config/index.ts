import { config as dotenvConfig } from "dotenv";
import { existsSync, statSync } from "node:fs";

export interface OrcaConfig {
  defaultCwd: string;
  concurrencyCap: number;
  sessionTimeoutMin: number;
  maxRetries: number;
  budgetWindowHours: number;
  budgetMaxCostUsd: number;
  schedulerIntervalSec: number;
  claudePath: string;
  defaultMaxTurns: number;
  appendSystemPrompt: string;
  disallowedTools: string;
  port: number;
  dbPath: string;
  // Linear integration
  linearApiKey: string;
  linearWebhookSecret: string;
  linearProjectIds: string[];
  linearReadyStateType: string;
  tunnelHostname: string;
  tunnelToken: string;
  cloudflaredPath: string;
}

function exitWithError(message: string): never {
  console.error(`orca: ${message}`);
  process.exit(1);
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    exitWithError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    exitWithError(`${name} must be a positive number`);
  }
  return parsed;
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function readEnvOrDefault(name: string, defaultValue: string): string {
  return readEnv(name) ?? defaultValue;
}

function readIntOrDefault(name: string, defaultValue: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return defaultValue;
  return parsePositiveInt(name, raw);
}

function readPositiveNumberOrDefault(
  name: string,
  defaultValue: number,
): number {
  const raw = readEnv(name);
  if (raw === undefined) return defaultValue;
  return parsePositiveNumber(name, raw);
}

export function loadConfig(): OrcaConfig {
  dotenvConfig();

  // Required: ORCA_DEFAULT_CWD
  const defaultCwd = readEnv("ORCA_DEFAULT_CWD");
  if (!defaultCwd) {
    exitWithError(
      "ORCA_DEFAULT_CWD is required and must be a valid directory path",
    );
  }
  if (!existsSync(defaultCwd) || !statSync(defaultCwd).isDirectory()) {
    exitWithError(
      "ORCA_DEFAULT_CWD is required and must be a valid directory path",
    );
  }

  // Required: Linear integration
  const linearApiKey = readEnv("ORCA_LINEAR_API_KEY");
  if (!linearApiKey) {
    exitWithError("ORCA_LINEAR_API_KEY is required");
  }

  const linearWebhookSecret = readEnv("ORCA_LINEAR_WEBHOOK_SECRET");
  if (!linearWebhookSecret) {
    exitWithError("ORCA_LINEAR_WEBHOOK_SECRET is required");
  }

  const linearProjectIdsRaw = readEnv("ORCA_LINEAR_PROJECT_IDS");
  if (!linearProjectIdsRaw) {
    exitWithError("ORCA_LINEAR_PROJECT_IDS is required");
  }
  let linearProjectIds: string[];
  try {
    const parsed = JSON.parse(linearProjectIdsRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      exitWithError(
        "ORCA_LINEAR_PROJECT_IDS must be a non-empty JSON array of strings",
      );
    }
    if (!parsed.every((item: unknown) => typeof item === "string")) {
      exitWithError(
        "ORCA_LINEAR_PROJECT_IDS must be a JSON array of strings",
      );
    }
    linearProjectIds = parsed as string[];
  } catch {
    exitWithError(
      "ORCA_LINEAR_PROJECT_IDS must be valid JSON (e.g. [\"project-uuid\"])",
    );
  }

  const tunnelHostname = readEnv("ORCA_TUNNEL_HOSTNAME");
  if (!tunnelHostname) {
    exitWithError("ORCA_TUNNEL_HOSTNAME is required");
  }

  const tunnelToken = readEnvOrDefault("ORCA_TUNNEL_TOKEN", "");

  return {
    defaultCwd,
    concurrencyCap: readIntOrDefault("ORCA_CONCURRENCY_CAP", 3),
    sessionTimeoutMin: readIntOrDefault("ORCA_SESSION_TIMEOUT_MIN", 45),
    maxRetries: readIntOrDefault("ORCA_MAX_RETRIES", 3),
    budgetWindowHours: readPositiveNumberOrDefault(
      "ORCA_BUDGET_WINDOW_HOURS",
      4,
    ),
    budgetMaxCostUsd: readPositiveNumberOrDefault(
      "ORCA_BUDGET_MAX_COST_USD",
      10.0,
    ),
    schedulerIntervalSec: readIntOrDefault("ORCA_SCHEDULER_INTERVAL_SEC", 10),
    claudePath: readEnvOrDefault("ORCA_CLAUDE_PATH", "claude"),
    defaultMaxTurns: readIntOrDefault("ORCA_DEFAULT_MAX_TURNS", 50),
    appendSystemPrompt: readEnvOrDefault("ORCA_APPEND_SYSTEM_PROMPT", ""),
    disallowedTools: readEnvOrDefault("ORCA_DISALLOWED_TOOLS", ""),
    port: readIntOrDefault("ORCA_PORT", 3000),
    dbPath: readEnvOrDefault("ORCA_DB_PATH", "./orca.db"),
    // Linear integration
    linearApiKey,
    linearWebhookSecret,
    linearProjectIds,
    linearReadyStateType: readEnvOrDefault(
      "ORCA_LINEAR_READY_STATE_TYPE",
      "unstarted",
    ),
    tunnelHostname,
    tunnelToken,
    cloudflaredPath: readEnvOrDefault("ORCA_CLOUDFLARED_PATH", "cloudflared"),
  };
}
