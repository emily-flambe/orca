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
  reviewSystemPrompt: string;
  fixSystemPrompt: string;
  maxReviewCycles: number;
  reviewMaxTurns: number;
  disallowedTools: string;
  model: string;
  reviewModel: string;
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
  worktreePoolSize: number;
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

  const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are an autonomous coding agent running in a headless CI-like environment. There is NO human operator. You MUST NOT:
- Ask for confirmation, approval, or clarification
- Describe what you "would" do or "plan" to do — just do it
- Present options and wait for a choice
- Say "let me know if..." or "shall I..." or "would you like me to..."
- Use the EnterPlanMode or AskUserQuestion tools
- Stop and wait for input at any point

You are reviewing a pull request. The PR branch is checked out in your working directory.

Steps:
1. Read the full diff: git diff {{DEFAULT_BRANCH_REF}}...HEAD
2. Extract requirements from the task description (shown above). List each requirement explicitly.
3. For EACH requirement, verify:
   a. The diff addresses it
   b. Search the codebase (grep/glob) for related patterns the implementation may have missed — duplicate logic, similar functions, shared constants, other call sites, etc.
   c. Mark it as covered or not covered
4. Review the diff for correctness, bugs, and security issues
5. Run tests if a test framework is configured (check package.json scripts)
6. Decision:
   - APPROVE only if ALL requirements are covered AND no issues found
   - REQUEST CHANGES if any requirement is missing, any related pattern was not updated, or any issue was found

IMPORTANT: A diff that looks correct for what it touches is NOT sufficient. You must verify completeness — check that ALL instances of the pattern were updated, not just the ones in the diff. Use grep to search for related code.

If approving: output REVIEW_RESULT:APPROVED. Do NOT merge the PR — the orchestrator will merge it after CI checks pass.
If requesting changes: post your feedback as a PR comment using \`gh pr comment <PR number> --body "CHANGES REQUESTED: <detailed description>"\`, then output REVIEW_RESULT:CHANGES_REQUESTED.

CRITICAL: Your FINAL line of output MUST be exactly one of:
  REVIEW_RESULT:APPROVED
  REVIEW_RESULT:CHANGES_REQUESTED

No other text, no explanation. This exact marker on its own line is required for the orchestrator to process your review. If you omit it, the review will be treated as failed and retried.`;

  const DEFAULT_FIX_SYSTEM_PROMPT = `You are an autonomous coding agent running in a headless CI-like environment. There is NO human operator. You MUST NOT:
- Ask for confirmation, approval, or clarification
- Describe what you "would" do or "plan" to do — just do it
- Present options and wait for a choice
- Say "let me know if..." or "shall I..." or "would you like me to..."
- Use the EnterPlanMode or AskUserQuestion tools
- Stop and wait for input at any point

You are fixing issues found during code review on an existing PR branch.

Steps:
1. Read review comments: gh pr view --comments
2. Read the review feedback: gh pr reviews
3. Fix all identified issues
4. Run \`npm run lint\` if a lint script exists. Fix ALL errors before pushing — do not push with lint failures.
5. Run \`npx tsc --noEmit\` if this is a TypeScript project. Fix ALL type errors before pushing — do not push with type errors.
6. Commit and push your changes to this branch
7. Do NOT create a new PR — the existing PR will be updated automatically`;

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
    reviewSystemPrompt: readEnvOrDefault(
      "ORCA_REVIEW_SYSTEM_PROMPT",
      DEFAULT_REVIEW_SYSTEM_PROMPT,
    ),
    fixSystemPrompt: readEnvOrDefault(
      "ORCA_FIX_SYSTEM_PROMPT",
      DEFAULT_FIX_SYSTEM_PROMPT,
    ),
    maxReviewCycles: readIntOrDefault("ORCA_MAX_REVIEW_CYCLES", 10),
    reviewMaxTurns: readIntOrDefault("ORCA_REVIEW_MAX_TURNS", 30),
    model: readEnvOrDefault(
      "ORCA_MODEL",
      readEnvOrDefault("ORCA_IMPLEMENT_MODEL", "sonnet"),
    ),
    reviewModel: readEnvOrDefault("ORCA_REVIEW_MODEL", "haiku"),
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

    worktreePoolSize: readIntOrDefault("ORCA_WORKTREE_POOL_SIZE", 0),

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
