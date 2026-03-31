import { execFileSync } from "node:child_process";
import { createLogger } from "../logger.js";
import { resolveClaudeBinary } from "../runner/index.js";
import { getDefaultBranch } from "../git.js";

const logger = createLogger("github/pr-description");

/**
 * Returns true if the PR body already looks well-structured:
 * - is longer than 100 chars
 * - contains all three required sections: ## Summary, ## Changes, ## Test Plan
 * - references the Linear issue ID as a whole word (not as a substring of another ID)
 * If all three are true, we skip AI regeneration.
 */
export function isWellStructuredPrBody(body: string, taskId: string): boolean {
  if (body.length <= 100) return false;
  // Must have all three required sections as actual top-level headers
  const requiredSections = ["## Summary", "## Changes", "## Test Plan"];
  if (!requiredSections.every((s) => body.includes(s))) return false;
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
  ghPath?: string;
}): Promise<void> {
  const {
    prNumber,
    taskId,
    agentPrompt,
    repoPath,
    claudePath,
    model,
    ghPath = "gh",
  } = opts;

  // 1. Get current PR title + body
  let prTitle: string;
  let prBody: string;
  try {
    const prJson = execFileSync(
      ghPath,
      ["pr", "view", String(prNumber), "--json", "title,body"],
      { encoding: "utf-8", cwd: repoPath },
    );
    const pr = JSON.parse(prJson) as { title: string; body: string };
    prTitle = pr.title ?? "";
    prBody = pr.body ?? "";
  } catch (err) {
    logger.warn(
      `[${taskId}] enrichPrDescription: failed to fetch PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 2. Skip if already well-structured
  if (isWellStructuredPrBody(prBody, taskId)) {
    logger.info(
      `[${taskId}] PR #${prNumber}: already well-structured, skipping enrichment`,
    );
    return;
  }

  // 3. Get git diff (branch vs default branch), truncated to 8KB
  const defaultBranch = getDefaultBranch(repoPath);
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", `origin/${defaultBranch}...HEAD`], {
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
      `[${taskId}] enrichPrDescription: claude invocation failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // 6. Parse JSON from output — strip markdown fences first, then walk `{` positions
  // Claude sometimes wraps output in ```json...``` even when asked not to, which
  // causes JSON.parse to fail on the trailing backticks.
  const strippedOutput = rawOutput
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let generated: { title: string; body: string } | null = null;
  const isValidGenerated = (c: unknown): c is { title: string; body: string } =>
    c !== null &&
    typeof c === "object" &&
    "title" in c &&
    "body" in c &&
    typeof (c as Record<string, unknown>).title === "string" &&
    typeof (c as Record<string, unknown>).body === "string";

  try {
    // First: try parsing the stripped output directly (handles pure JSON response)
    try {
      const candidate = JSON.parse(strippedOutput) as unknown;
      if (isValidGenerated(candidate)) {
        generated = candidate;
      }
    } catch {
      // Not pure JSON — fall through to positional search
    }

    if (!generated) {
      // Walk through all `{` positions. For each, try:
      //   (a) parse from `{` to the last `}` — handles trailing content like code fences
      //   (b) parse from `{` to end of string — handles pure JSON with trailing whitespace
      let pos = 0;
      const lastBrace = strippedOutput.lastIndexOf("}");
      while ((pos = strippedOutput.indexOf("{", pos)) !== -1) {
        const slices =
          lastBrace > pos
            ? [
                strippedOutput.slice(pos, lastBrace + 1),
                strippedOutput.slice(pos),
              ]
            : [strippedOutput.slice(pos)];
        for (const slice of slices) {
          try {
            const candidate = JSON.parse(slice) as unknown;
            if (isValidGenerated(candidate)) {
              generated = candidate;
              break;
            }
          } catch {
            // Not valid JSON from this slice — continue
          }
        }
        if (generated) break;
        pos++;
      }
    }
  } catch {
    // Outer catch for any unexpected errors in the loop
  }

  if (!generated) {
    logger.warn(
      `[${taskId}] enrichPrDescription: no valid JSON with title+body found in claude output for PR #${prNumber}`,
    );
    return;
  }
  if (!generated.title || !generated.body) {
    logger.warn(
      `[${taskId}] enrichPrDescription: generated JSON missing title or body for PR #${prNumber}`,
    );
    return;
  }

  // 6b. Validate generated content matches requirements
  const titlePrefix = `[${taskId}]`;
  if (!generated.title.startsWith(titlePrefix)) {
    logger.warn(
      `[${taskId}] enrichPrDescription: generated title does not start with "${titlePrefix}" for PR #${prNumber}, skipping`,
    );
    return;
  }
  if (generated.title.length > 70) {
    logger.warn(
      `[${taskId}] enrichPrDescription: generated title exceeds 70 chars (${generated.title.length}) for PR #${prNumber}, truncating`,
    );
    generated.title = generated.title.slice(0, 70);
  }
  const requiredSections = ["## Summary", "## Changes", "## Test Plan"];
  const missingSections = requiredSections.filter(
    (s) => !generated!.body.includes(s),
  );
  if (missingSections.length > 0) {
    logger.warn(
      `[${taskId}] enrichPrDescription: generated body missing sections ${missingSections.join(", ")} for PR #${prNumber}, skipping`,
    );
    return;
  }

  // 7. Apply via gh pr edit
  try {
    execFileSync(
      ghPath,
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
      `[${taskId}] PR #${prNumber}: description enriched (title: "${generated.title}")`,
    );
  } catch (err) {
    logger.warn(
      `[${taskId}] enrichPrDescription: gh pr edit failed for PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
