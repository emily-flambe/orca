import { execFileSync } from "node:child_process";
import { createLogger } from "../logger.js";
import { resolveClaudeBinary } from "../runner/index.js";

const logger = createLogger("github/pr-description");

/**
 * Returns true if the PR body already looks well-structured:
 * - has ## markdown headers
 * - references the Linear issue ID
 * - is longer than 100 chars
 * If all three are true, we skip AI regeneration.
 */
export function isWellStructuredPrBody(body: string, taskId: string): boolean {
  return body.length > 100 && body.includes("## ") && body.includes(taskId);
}

/**
 * Enrich a PR's title and body using Claude haiku in non-interactive print mode.
 *
 * Fetches the current PR title/body, checks if it's already well-structured
 * (skips if so), then uses `claude -p` with haiku to generate a structured
 * description from the git diff and Linear ticket context.
 *
 * Non-fatal: logs and returns on any error so the pipeline continues.
 */
export async function enrichPrDescription(opts: {
  prNumber: number;
  taskId: string;
  agentPrompt: string;
  repoPath: string;
  claudePath: string;
  model: string; // e.g. "haiku"
}): Promise<void> {
  const { prNumber, taskId, agentPrompt, repoPath, claudePath, model } = opts;

  // 1. Get current PR title + body
  let prTitle: string;
  let prBody: string;
  try {
    const prJson = execFileSync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "title,body"],
      { encoding: "utf-8", cwd: repoPath },
    );
    const pr = JSON.parse(prJson) as { title: string; body: string };
    prTitle = pr.title ?? "";
    prBody = pr.body ?? "";
  } catch (err) {
    logger.warn(
      `[EMI-367] enrichPrDescription: failed to fetch PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 2. Skip if already well-structured
  if (isWellStructuredPrBody(prBody, taskId)) {
    logger.info(
      `[EMI-367] PR #${prNumber}: already well-structured, skipping enrichment`,
    );
    return;
  }

  // 3. Get git diff (branch vs main), truncated to 8KB
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "origin/main...HEAD"], {
      encoding: "utf-8",
      cwd: repoPath,
      maxBuffer: 500 * 1024,
    });
    diff = diff.slice(0, 8000);
  } catch {
    // Non-fatal — continue with empty diff
  }

  // 4. Build prompt for haiku
  const ticketContext = agentPrompt.slice(0, 3000);
  const prompt = `You are generating a structured GitHub PR description. Output ONLY valid JSON — no markdown fences, no explanation.

Linear ticket:
${ticketContext}

Current PR title: ${prTitle}

Git diff (may be truncated):
${diff}

Generate a JSON object with exactly these two keys:
- "title": a concise PR title (max 70 chars) that starts with "[${taskId}]" and summarizes what changed
- "body": a GitHub Markdown PR body with these sections:
  ## Summary
  (2-3 bullet points describing what was done)

  ## Changes
  (bullet list of specific code changes)

  ## Test Plan
  (what was tested or how to verify)

  Closes ${taskId}

Output only the JSON object, nothing else.`;

  // 5. Call claude in print mode with haiku
  let rawOutput: string;
  try {
    const { command, prefixArgs } = resolveClaudeBinary(claudePath);
    rawOutput = execFileSync(
      command,
      [
        ...prefixArgs,
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ],
      {
        encoding: "utf-8",
        cwd: repoPath,
        timeout: 90_000,
        maxBuffer: 100 * 1024,
      },
    );
  } catch (err) {
    logger.warn(
      `[EMI-367] enrichPrDescription: claude invocation failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 6. Parse JSON from output
  let generated: { title: string; body: string };
  try {
    // Extract first JSON object from output (claude sometimes adds preamble)
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        `[EMI-367] enrichPrDescription: no JSON found in claude output for PR #${prNumber}`,
      );
      return;
    }
    generated = JSON.parse(jsonMatch[0]) as { title: string; body: string };
    if (!generated.title || !generated.body) {
      logger.warn(
        `[EMI-367] enrichPrDescription: generated JSON missing title or body for PR #${prNumber}`,
      );
      return;
    }
  } catch (err) {
    logger.warn(
      `[EMI-367] enrichPrDescription: JSON parse failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 7. Apply via gh pr edit
  try {
    execFileSync(
      "gh",
      [
        "pr",
        "edit",
        String(prNumber),
        "--title",
        generated.title,
        "--body",
        generated.body,
      ],
      { encoding: "utf-8", cwd: repoPath },
    );
    logger.info(
      `[EMI-367] PR #${prNumber}: description enriched (title: "${generated.title}")`,
    );
  } catch (err) {
    logger.warn(
      `[EMI-367] enrichPrDescription: gh pr edit failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
