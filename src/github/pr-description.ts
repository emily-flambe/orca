import { execFileSync } from "node:child_process";
import { createLogger } from "../logger.js";
import { resolveClaudeBinary } from "../runner/index.js";

const logger = createLogger("github/pr-description");

/**
 * Returns true if the PR body already looks well-structured:
 * - has at least 2 top-level ## markdown headers (multiple sections)
 * - references the Linear issue ID as a whole word (not as a substring of another ID)
 * - is longer than 100 chars
 * If all three are true, we skip AI regeneration.
 */
export function isWellStructuredPrBody(body: string, taskId: string): boolean {
  if (body.length <= 100) return false;
  // Count top-level ## headers (at start of line)
  const headerMatches = body.match(/^## /gm);
  if (!headerMatches || headerMatches.length < 2) return false;
  // Word-boundary match for taskId so "EMI-1" doesn't match inside "EMI-10"
  const escapedId = taskId.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  if (!new RegExp(`(?<![A-Za-z0-9-])${escapedId}(?![A-Za-z0-9-])`).test(body))
    return false;
  return true;
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

  // 6. Parse JSON from output — try each `{` position to find a valid object
  let generated: { title: string; body: string } | null = null;
  try {
    // Walk through all `{` positions and try to parse from each one.
    // This handles cases where Claude emits preamble JSON or thinking blocks
    // before the actual answer object.
    let pos = 0;
    while ((pos = rawOutput.indexOf("{", pos)) !== -1) {
      try {
        const candidate = JSON.parse(rawOutput.slice(pos)) as unknown;
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          "title" in candidate &&
          "body" in candidate &&
          typeof (candidate as Record<string, unknown>).title === "string" &&
          typeof (candidate as Record<string, unknown>).body === "string"
        ) {
          generated = candidate as { title: string; body: string };
          break;
        }
      } catch {
        // Not valid JSON from this position — try next `{`
      }
      pos++;
    }
  } catch {
    // Outer catch for any unexpected errors in the loop
  }

  if (!generated) {
    logger.warn(
      `[EMI-367] enrichPrDescription: no valid JSON with title+body found in claude output for PR #${prNumber}`,
    );
    return;
  }
  if (!generated.title || !generated.body) {
    logger.warn(
      `[EMI-367] enrichPrDescription: generated JSON missing title or body for PR #${prNumber}`,
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
