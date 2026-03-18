/**
 * Parses review session output for REVIEW_RESULT markers.
 * Extracted from scheduler's onReviewSuccess() for use in Inngest workflows.
 */

import { readFileSync, existsSync } from "node:fs";

export type ReviewResult = "APPROVED" | "CHANGES_REQUESTED" | "NO_MARKER";

export interface ParseReviewInput {
  summary: string | null;
  logPath: string | null;
  invocationId: number;
}

export interface ParseReviewOutput {
  result: ReviewResult;
  fixReason: string | null;
}

/**
 * Extract fix reason text that follows a CHANGES_REQUESTED marker.
 * Looks for text after "REVIEW_RESULT:CHANGES_REQUESTED" on the same line,
 * or any remaining text in the source string.
 */
function extractFixReason(text: string): string | null {
  const marker = "REVIEW_RESULT:CHANGES_REQUESTED";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const after = text.slice(idx + marker.length).trim();
  return after.length > 0 ? after : null;
}

/**
 * Scan the NDJSON session log for a REVIEW_RESULT marker in assistant messages.
 * Replicates the scheduler's extractMarkerFromLog() logic exactly.
 *
 * Returns the marker result and, for CHANGES_REQUESTED, the text block that
 * contained the marker (used for fix reason extraction).
 */
export function extractMarkerFromLog(
  logPath: string,
): { marker: "APPROVED" | "CHANGES_REQUESTED"; text: string } | null {
  try {
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "assistant") continue;
        // Extract all text from assistant message content
        const message = msg.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            if (b.text.includes("REVIEW_RESULT:APPROVED"))
              return { marker: "APPROVED", text: b.text };
            if (b.text.includes("REVIEW_RESULT:CHANGES_REQUESTED"))
              return { marker: "CHANGES_REQUESTED", text: b.text };
          }
        }
      } catch {
        // skip malformed JSON lines
      }
    }
  } catch {
    // skip if file unreadable
  }
  return null;
}

/**
 * Parse review session output for REVIEW_RESULT markers.
 *
 * 1. Check the summary string for REVIEW_RESULT:APPROVED or REVIEW_RESULT:CHANGES_REQUESTED
 * 2. If not found in summary, scan the NDJSON log file for assistant messages containing the marker
 * 3. Extract fix reason text after CHANGES_REQUESTED marker
 *
 * Pure function — no DB writes, no event emissions, no side effects.
 */
export function parseReview(input: ParseReviewInput): ParseReviewOutput {
  const summary = input.summary ?? "";

  // Step 1: Check summary for markers
  if (summary.includes("REVIEW_RESULT:APPROVED")) {
    return { result: "APPROVED", fixReason: null };
  }

  if (summary.includes("REVIEW_RESULT:CHANGES_REQUESTED")) {
    return {
      result: "CHANGES_REQUESTED",
      fixReason: extractFixReason(summary),
    };
  }

  // Step 2: Fall back to NDJSON log file
  if (input.logPath) {
    const logResult = extractMarkerFromLog(input.logPath);
    if (logResult) {
      if (logResult.marker === "APPROVED") {
        return { result: "APPROVED", fixReason: null };
      }
      return {
        result: "CHANGES_REQUESTED",
        fixReason: extractFixReason(logResult.text),
      };
    }
  }

  // Step 3: No marker found anywhere
  return { result: "NO_MARKER", fixReason: null };
}
