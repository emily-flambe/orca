import { config as dotenvConfig } from "dotenv";
import { existsSync, statSync } from "node:fs";

export interface OrcaConfig {
  defaultCwd: string | undefined;
  projectRepoMap: Map<string, string>;
  concurrencyCap: number;
  agentConcurrencyCap: number;
  sessionTimeoutMin: number;
  maxRetries: number;
  budgetWindowHours: number;
  budgetMaxTokens: number;

  claudePath: string;
  defaultMaxTurns: number;
  implementSystemPrompt: string;
  fixSystemPrompt: string;
  disallowedTools: string;
  model: string;
  deployStrategy: "none" | "github_actions";
  maxDeployPollAttempts: number;
  maxCiPollAttempts: number;
  drainTimeoutMin: number;
  port: number;
  dbPath: string;
  logPath: string;
  // Linear integration
  linearApiKey: string;
  linearWebhookSecret: string;
  linearProjectIds: string[];
  tunnelHostname: string;
  // Alert webhook (optional — Slack/Discord compatible, fires on permanent failure)
  alertWebhookUrl: string | undefined;
  tunnelToken: string;
  // GitHub MCP server PAT (optional — adds GitHub MCP to agent sessions when set)
  githubMcpPat: string | undefined;
  cloudflaredPath: string;
  externalTunnel: boolean;

  logLevel: string;
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

function readBoolOrDefault(name: string, defaultValue: boolean): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  exitWithError(`${name} must be "true", "false", "1", or "0"`);
}

export function loadConfig(): OrcaConfig {
  dotenvConfig();

  // Optional: ORCA_DEFAULT_CWD (fallback when project description has no repo: line)
  const defaultCwdRaw = readEnv("ORCA_DEFAULT_CWD");
  let defaultCwd: string | undefined;
  if (defaultCwdRaw) {
    if (!existsSync(defaultCwdRaw) || !statSync(defaultCwdRaw).isDirectory()) {
      exitWithError("ORCA_DEFAULT_CWD must be a valid directory path");
    }
    defaultCwd = defaultCwdRaw;
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
      exitWithError("ORCA_LINEAR_PROJECT_IDS must be a JSON array of strings");
    }
    linearProjectIds = parsed as string[];
  } catch {
    exitWithError(
      'ORCA_LINEAR_PROJECT_IDS must be valid JSON (e.g. ["project-uuid"])',
    );
  }

  const tunnelHostname = readEnv("ORCA_TUNNEL_HOSTNAME");
  if (!tunnelHostname) {
    exitWithError("ORCA_TUNNEL_HOSTNAME is required");
  }

  const tunnelToken = readEnvOrDefault("ORCA_TUNNEL_TOKEN", "");

  const DEFAULT_IMPLEMENT_SYSTEM_PROMPT = `You are an autonomous coding agent running in a headless CI-like environment. There is NO human operator. You MUST NOT:
- Ask for confirmation, approval, or clarification
- Describe what you "would" do or "plan" to do — just do it
- Present options and wait for a choice
- Say "let me know if..." or "shall I..." or "would you like me to..."
- Use the EnterPlanMode or AskUserQuestion tools
- Stop and wait for input at any point

If you are uncertain about a requirement, make the best decision based on context and proceed. Wrong is better than stuck.

You are implementing a feature or fix. Follow this workflow:

## Before starting
1. Run \`git fetch origin && git rebase {{DEFAULT_BRANCH_REF}}\` to ensure you're up to date.
2. Read the task requirements carefully.
3. Check your current branch: \`git branch --show-current\`. Orca pre-creates a branch for you — you MUST use it. Do NOT create a new branch.

## Implementation workflow

For non-trivial tasks, use Claude Code's Agent tool to spawn adversarial subagents:

### Step 1: Implement
Spawn an \`implementer\` subagent (subagent_type: "implementer") with a prompt describing the requirements. Let it write the code.

### Step 2: Test/Attack
Spawn a \`tester\` subagent (subagent_type: "tester") to attack the implementation. Its goal is to find bugs, edge cases, and missing requirements. It should write failing tests or identify concrete issues.

### Step 3: Fix
Review the tester's findings. Fix legitimate issues. Dismiss false positives with reasoning.

### Step 4: Re-test (if fixes were needed)
If you made fixes in Step 3, spawn the tester subagent once more to verify the fixes and check for regressions.

**Skip subagents for trivial tasks** (single-line fixes, config changes, simple renames). Use your judgment.

## Self-review before pushing
After implementation is complete, review your own diff against the original requirements:
1. Run \`git diff {{DEFAULT_BRANCH_REF}}...HEAD\` to see the full diff.
2. Verify every requirement from the task description is addressed.
3. Search the codebase (grep/glob) for related patterns you may have missed — duplicate logic, similar functions, shared constants, other call sites.
4. If anything is missing or wrong, fix it now before pushing.

## Before pushing
1. Run \`git fetch origin && git rebase {{DEFAULT_BRANCH_REF}}\` again to pick up any changes.
2. Run \`npm run lint\` if a lint script exists. Fix ALL errors before pushing — do not push with lint failures.
3. Run \`npx tsc --noEmit\` if this is a TypeScript project. Fix ALL type errors before pushing — do not push with type errors.
4. Run the project's test suite if one exists (check package.json scripts).

## Finishing up
1. Stage and commit all changes with a descriptive commit message.
2. Run \`git fetch origin && git rebase {{DEFAULT_BRANCH_REF}}\` to ensure the branch is up to date immediately before opening the PR. If conflicts arise, resolve them and re-commit before proceeding.
3. Push the pre-created branch: \`git push -u origin HEAD\` — this pushes whatever branch is currently checked out. Do NOT switch branches before pushing.
4. Open a pull request: \`gh pr create --fill\`
5. Do NOT merge the PR. Leave it for review.
6. Include the Linear issue ID (from the task prompt) in the PR title.`;

  const DEFAULT_FIX_SYSTEM_PROMPT = `You are an autonomous coding agent running in a headless CI-like environment. There is NO human operator. You MUST NOT:
- Ask for confirmation, approval, or clarification
- Describe what you "would" do or "plan" to do — just do it
- Present options and wait for a choice
- Say "let me know if..." or "shall I..." or "would you like me to..."
- Use the EnterPlanMode or AskUserQuestion tools
- Stop and wait for input at any point

CI checks failed on your PR branch. Fix the failures and push.

Steps:
1. Read the CI failure output (check the PR checks or run the failing commands locally).
2. Fix all issues causing CI to fail.
3. Run \`npm run lint\` if a lint script exists. Fix ALL errors before pushing.
4. Run \`npx tsc --noEmit\` if this is a TypeScript project. Fix ALL type errors before pushing.
5. Run the project's test suite to verify fixes.
6. Commit and push your changes to this branch.
7. Do NOT create a new PR — the existing PR will be updated automatically.`;

  return {
    defaultCwd,
    projectRepoMap: new Map(),
    concurrencyCap: readIntOrDefault("ORCA_CONCURRENCY_CAP", 1),
    agentConcurrencyCap: readIntOrDefault("ORCA_AGENT_CONCURRENCY_CAP", 12),
    sessionTimeoutMin: readIntOrDefault("ORCA_SESSION_TIMEOUT_MIN", 45),
    maxRetries: readIntOrDefault("ORCA_MAX_RETRIES", 3),
    budgetWindowHours: readPositiveNumberOrDefault(
      "ORCA_BUDGET_WINDOW_HOURS",
      4,
    ),
    budgetMaxTokens: readPositiveNumberOrDefault(
      "ORCA_BUDGET_MAX_TOKENS",
      1_000_000_000,
    ),

    claudePath: readEnvOrDefault("ORCA_CLAUDE_PATH", "claude"),
    defaultMaxTurns: readIntOrDefault("ORCA_DEFAULT_MAX_TURNS", 50),
    implementSystemPrompt: readEnvOrDefault(
      "ORCA_IMPLEMENT_SYSTEM_PROMPT",
      DEFAULT_IMPLEMENT_SYSTEM_PROMPT,
    ),
    fixSystemPrompt: readEnvOrDefault(
      "ORCA_FIX_SYSTEM_PROMPT",
      DEFAULT_FIX_SYSTEM_PROMPT,
    ),
    model: readEnvOrDefault(
      "ORCA_MODEL",
      readEnvOrDefault("ORCA_IMPLEMENT_MODEL", "sonnet"),
    ),
    disallowedTools: readEnvOrDefault("ORCA_DISALLOWED_TOOLS", ""),
    deployStrategy: (() => {
      const val = readEnvOrDefault("ORCA_DEPLOY_STRATEGY", "none");
      if (val !== "none" && val !== "github_actions") {
        exitWithError(
          'ORCA_DEPLOY_STRATEGY must be "none" or "github_actions"',
        );
      }
      return val as "none" | "github_actions";
    })(),
    maxDeployPollAttempts: readIntOrDefault(
      "ORCA_DEPLOY_MAX_POLL_ATTEMPTS",
      60,
    ),
    maxCiPollAttempts: readIntOrDefault("ORCA_CI_MAX_POLL_ATTEMPTS", 240),
    drainTimeoutMin: readIntOrDefault("ORCA_DRAIN_TIMEOUT_MIN", 10),
    port: readIntOrDefault("ORCA_PORT", 3000),
    dbPath: readEnvOrDefault("ORCA_DB_PATH", "./orca.db"),
    logPath: readEnvOrDefault("ORCA_LOG_PATH", "./orca.log"),
    // Linear integration
    linearApiKey,
    linearWebhookSecret,
    linearProjectIds,
    tunnelHostname,
    alertWebhookUrl: readEnv("ORCA_ALERT_WEBHOOK_URL"),
    tunnelToken,
    githubMcpPat: readEnv("GITHUB_MCP_PAT") ?? readEnv("GITHUB_TOKEN"),
    cloudflaredPath: readEnvOrDefault("ORCA_CLOUDFLARED_PATH", "cloudflared"),
    externalTunnel: readBoolOrDefault("ORCA_EXTERNAL_TUNNEL", false),

    logLevel: (() => {
      const val = readEnvOrDefault("LOG_LEVEL", "info").toLowerCase();
      const valid = ["debug", "info", "warn", "error"];
      if (!valid.includes(val)) {
        exitWithError(
          `LOG_LEVEL must be one of: debug, info, warn, error (got "${val}")`,
        );
      }
      return val;
    })(),
  };
}

/**
 * Parse a `repo:` line from a Linear project description.
 * Returns the path (trimmed) or undefined if not found.
 */
export function parseRepoPath(description: string): string | undefined {
  for (const line of description.split("\n")) {
    const match = line.match(/^repo:\s*(.+)/i);
    if (match) {
      // Normalize escaped backslashes (Linear markdown stores \\ for \)
      const path = match[1]!.trim().replace(/\\\\/g, "\\");
      if (path.length > 0) return path;
    }
  }
  return undefined;
}

/**
 * Validate that every configured project ID resolves to a valid directory
 * via projectRepoMap or defaultCwd fallback. Exits with a clear error if not.
 */
export function validateProjectRepoPaths(config: OrcaConfig): void {
  const errors: string[] = [];

  for (const projectId of config.linearProjectIds) {
    const repoPath = config.projectRepoMap.get(projectId) ?? config.defaultCwd;
    if (!repoPath) {
      errors.push(
        `project ${projectId}: no repo: line in description and no ORCA_DEFAULT_CWD fallback`,
      );
    } else if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      errors.push(
        `project ${projectId}: path "${repoPath}" is not a valid directory`,
      );
    }
  }

  if (errors.length > 0) {
    exitWithError(
      `project repo path validation failed:\n  ${errors.join("\n  ")}`,
    );
  }
}
