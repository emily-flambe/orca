// ---------------------------------------------------------------------------
// parseReview() tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReview } from "../src/inngest/activities/parse-review.js";
import type {
  ParseReviewInput,
  ParseReviewOutput,
} from "../src/inngest/activities/parse-review.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `parse-review-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNdjsonLog(
  dir: string,
  filename: string,
  lines: unknown[],
): string {
  const logPath = join(dir, filename);
  writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return logPath;
}

function assistantMessage(text: string): unknown {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseReview", () => {
  test("APPROVED found in summary", () => {
    const result = parseReview({
      summary: "Everything looks good. REVIEW_RESULT:APPROVED",
      logPath: null,
      invocationId: 1,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "APPROVED",
      fixReason: null,
    });
  });

  test("CHANGES_REQUESTED found in summary with fix reason", () => {
    const result = parseReview({
      summary:
        "REVIEW_RESULT:CHANGES_REQUESTED The error handling in foo() is missing a try/catch",
      logPath: null,
      invocationId: 2,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "CHANGES_REQUESTED",
      fixReason: "The error handling in foo() is missing a try/catch",
    });
  });

  test("CHANGES_REQUESTED found in summary without fix reason", () => {
    const result = parseReview({
      summary: "REVIEW_RESULT:CHANGES_REQUESTED",
      logPath: null,
      invocationId: 3,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "CHANGES_REQUESTED",
      fixReason: null,
    });
  });

  test("no marker in summary, APPROVED found in log file", () => {
    tmpDir = makeTmpDir();
    const logPath = writeNdjsonLog(tmpDir, "4.ndjson", [
      { type: "user", message: { content: "review this PR" } },
      assistantMessage("I reviewed the code. REVIEW_RESULT:APPROVED"),
    ]);

    const result = parseReview({
      summary: "I reviewed the code and it looks fine.",
      logPath,
      invocationId: 4,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "APPROVED",
      fixReason: null,
    });
  });

  test("no marker in summary, CHANGES_REQUESTED found in log file with reason", () => {
    tmpDir = makeTmpDir();
    const logPath = writeNdjsonLog(tmpDir, "5.ndjson", [
      assistantMessage(
        "REVIEW_RESULT:CHANGES_REQUESTED Missing unit tests for edge cases",
      ),
    ]);

    const result = parseReview({
      summary: "Review complete.",
      logPath,
      invocationId: 5,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "CHANGES_REQUESTED",
      fixReason: "Missing unit tests for edge cases",
    });
  });

  test("no marker anywhere returns NO_MARKER", () => {
    tmpDir = makeTmpDir();
    const logPath = writeNdjsonLog(tmpDir, "6.ndjson", [
      assistantMessage("I looked at the code but forgot to give a verdict."),
    ]);

    const result = parseReview({
      summary: "Review session completed.",
      logPath,
      invocationId: 6,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "NO_MARKER",
      fixReason: null,
    });
  });

  test("null summary returns NO_MARKER when no log available", () => {
    const result = parseReview({
      summary: null,
      logPath: null,
      invocationId: 7,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "NO_MARKER",
      fixReason: null,
    });
  });

  test("empty summary returns NO_MARKER when no log available", () => {
    const result = parseReview({
      summary: "",
      logPath: null,
      invocationId: 8,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "NO_MARKER",
      fixReason: null,
    });
  });

  test("missing log file falls through to NO_MARKER", () => {
    const result = parseReview({
      summary: "No marker here.",
      logPath: "/nonexistent/path/999.ndjson",
      invocationId: 9,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "NO_MARKER",
      fixReason: null,
    });
  });

  test("malformed JSON lines in log are skipped", () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, "10.ndjson");
    // Write mix of valid and invalid JSON
    writeFileSync(
      logPath,
      [
        "not valid json at all",
        JSON.stringify(assistantMessage("REVIEW_RESULT:APPROVED")),
      ].join("\n"),
    );

    const result = parseReview({
      summary: "No marker in summary.",
      logPath,
      invocationId: 10,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "APPROVED",
      fixReason: null,
    });
  });

  test("non-assistant message types in log are ignored", () => {
    tmpDir = makeTmpDir();
    const logPath = writeNdjsonLog(tmpDir, "11.ndjson", [
      {
        type: "system",
        message: {
          content: [{ type: "text", text: "REVIEW_RESULT:APPROVED" }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "REVIEW_RESULT:APPROVED" }],
        },
      },
    ]);

    const result = parseReview({
      summary: null,
      logPath,
      invocationId: 11,
    });

    expect(result).toEqual<ParseReviewOutput>({
      result: "NO_MARKER",
      fixReason: null,
    });
  });

  test("summary takes priority over log file", () => {
    tmpDir = makeTmpDir();
    const logPath = writeNdjsonLog(tmpDir, "12.ndjson", [
      assistantMessage("REVIEW_RESULT:CHANGES_REQUESTED Fix the tests"),
    ]);

    const result = parseReview({
      summary: "REVIEW_RESULT:APPROVED",
      logPath,
      invocationId: 12,
    });

    // Summary wins — APPROVED, not CHANGES_REQUESTED from log
    expect(result).toEqual<ParseReviewOutput>({
      result: "APPROVED",
      fixReason: null,
    });
  });
});
