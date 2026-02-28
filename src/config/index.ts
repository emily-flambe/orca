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
  reviewSystemPrompt: string;
  fixSystemPrompt: string;
  maxReviewCycles: number;
  reviewMaxTurns: number;
  disallowedTools: string;
  deployStrategy: "none" | "github_actions";
  deployPollIntervalSec: number;
  deployTimeoutMin: number;
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

  const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are reviewing a pull request. The PR branch is checked out in your working directory.

Steps:
1. Read the full diff: git diff origin/main...HEAD
2. Review for correctness, bugs, and security issues
3. Run tests if a test framework is configured (check package.json scripts)
4. Verify the implementation matches the task requirements (shown above in the prompt)
5. Decision:
   - If the PR is good: run \`gh pr merge --squash --delete-branch\`, then output REVIEW_RESULT:APPROVED
   - If changes are needed: run \`gh pr review --request-changes -b "detailed description"\`, then output REVIEW_RESULT:CHANGES_REQUESTED

You MUST output exactly one of REVIEW_RESULT:APPROVED or REVIEW_RESULT:CHANGES_REQUESTED.`;

  const DEFAULT_FIX_SYSTEM_PROMPT = `You are fixing issues found during code review on an existing PR branch.

Steps:
1. Read review comments: gh pr view --comments
2. Read the review feedback: gh pr reviews
3. Fix all identified issues
4. Commit and push your changes to this branch
5. Do NOT create a new PR — the existing PR will be updated automatically`;

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
      1000.0,
    ),
    schedulerIntervalSec: readIntOrDefault("ORCA_SCHEDULER_INTERVAL_SEC", 10),
    claudePath: readEnvOrDefault("ORCA_CLAUDE_PATH", "claude"),
    defaultMaxTurns: readIntOrDefault("ORCA_DEFAULT_MAX_TURNS", 50),
    appendSystemPrompt: readEnvOrDefault("ORCA_APPEND_SYSTEM_PROMPT", ""),
    reviewSystemPrompt: readEnvOrDefault("ORCA_REVIEW_SYSTEM_PROMPT", DEFAULT_REVIEW_SYSTEM_PROMPT),
    fixSystemPrompt: readEnvOrDefault("ORCA_FIX_SYSTEM_PROMPT", DEFAULT_FIX_SYSTEM_PROMPT),
    maxReviewCycles: readIntOrDefault("ORCA_MAX_REVIEW_CYCLES", 3),
    reviewMaxTurns: readIntOrDefault("ORCA_REVIEW_MAX_TURNS", 30),
    disallowedTools: readEnvOrDefault("ORCA_DISALLOWED_TOOLS", ""),
    deployStrategy: (() => {
      const val = readEnvOrDefault("ORCA_DEPLOY_STRATEGY", "none");
      if (val !== "none" && val !== "github_actions") {
        exitWithError('ORCA_DEPLOY_STRATEGY must be "none" or "github_actions"');
      }
      return val as "none" | "github_actions";
    })(),
    deployPollIntervalSec: readIntOrDefault("ORCA_DEPLOY_POLL_INTERVAL_SEC", 30),
    deployTimeoutMin: readIntOrDefault("ORCA_DEPLOY_TIMEOUT_MIN", 30),
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
