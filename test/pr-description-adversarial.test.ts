// ---------------------------------------------------------------------------
// Adversarial tests for src/github/pr-description.ts
// Tester agent: finds bugs, edge cases, and missing requirements.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../src/runner/index.js", () => ({
  resolveClaudeBinary: vi
    .fn()
    .mockReturnValue({ command: "claude", prefixArgs: [] }),
}));

import { execFileSync } from "node:child_process";
import {
  isWellStructuredPrBody,
  enrichPrDescription,
} from "../src/github/pr-description.js";

const execSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Skip heuristic — requires all three specific sections plus taskId match
// ---------------------------------------------------------------------------
describe("isWellStructuredPrBody — heuristic false positives", () => {
  it("returns false for garbage body that happens to contain ## and taskId", () => {
    // Body has ## and taskId but lacks required sections (Summary, Changes, Test Plan)
    const garbageBody = "## EMI-123 is garbage: " + "X".repeat(90);
    const result = isWellStructuredPrBody(garbageBody, "EMI-123");
    expect(result).toBe(false);
  });

  it("returns false for body that has ## only in a code block, not real headers", () => {
    // ## inside a code block — lacks required sections
    const codeBlockBody =
      "This PR does stuff. EMI-456\n\n```bash\n## this is a comment\n```\n" +
      "A".repeat(80);
    const result = isWellStructuredPrBody(codeBlockBody, "EMI-456");
    expect(result).toBe(false);
  });

  it("returns false when taskId appears only as substring of a longer ID", () => {
    // Body mentions EMI-10 but taskId is EMI-1 — word-boundary regex prevents substring match
    const body = "## Summary\nSome work was done on EMI-10\n" + "A".repeat(80);
    const result = isWellStructuredPrBody(body, "EMI-1");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON parsing — iterative {-position search handles multiple JSON objects
// The implementation walks through all `{` positions to find the first valid
// object with both title and body keys.
// ---------------------------------------------------------------------------
describe("enrichPrDescription — JSON parsing with multiple objects", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the correct JSON object when Claude emits preamble then the real answer", async () => {
    // Claude outputs a preamble object followed by the actual answer.
    // The iterative search skips the first object (lacks title+body) and finds the second.
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    execSyncMock.mockReturnValueOnce(
      '{"thinking": "let me format this"} and here is the real answer: {"title": "[EMI-123] feat", "body": "## Summary\\n- done\\n\\n## Changes\\n- x\\n\\n## Test Plan\\n- y\\n\\nCloses EMI-123"}',
    );
    execSyncMock.mockReturnValueOnce(""); // gh pr edit

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "Implement the feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    // The iterative search finds the second JSON object with correct title+body
    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(1);
  });

  it("skips gh pr edit when Claude wraps output in a metadata object without title/body at top level", async () => {
    // Claude wraps output in {"result": {...}} — outer object has no title/body keys.
    // The iterative search finds the outer object first (no title/body), then the inner
    // object has title+body but is nested, so it won't be found as a top-level match.
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      '{"result": {"title": "[EMI-123] feat", "body": "## Summary\\n- done"}}',
    );
    execSyncMock.mockReturnValueOnce("");

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "Implement the feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    // gh pr edit should NOT be called — title and body are missing at top level
    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Null/undefined body from GitHub API — ?? "" guard handles it correctly
// ---------------------------------------------------------------------------
describe("enrichPrDescription — null/undefined body from GitHub API", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should handle null body from GitHub API without throwing", async () => {
    // GitHub can return null for body field on PRs with no description
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: null }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] feat",
        body: "## Summary\n- done\n\n## Changes\n- x\n\n## Test Plan\n- y\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce(""); // gh pr edit

    // Should not throw — ?? "" guard handles null
    await expect(
      enrichPrDescription({
        prNumber: 42,
        taskId: "EMI-123",
        agentPrompt: "feature",
        repoPath: "/repo",
        claudePath: "claude",
        model: "haiku",
      }),
    ).resolves.toBeUndefined();

    // Should have proceeded to call claude and gh pr edit
    expect(execSyncMock).toHaveBeenCalledTimes(4);
  });

  it("should handle undefined body from GitHub API without throwing", async () => {
    // If body is not present in the JSON response at all
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR" }), // no body key
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] feat",
        body: "## Summary\n- done\n\n## Changes\n- x\n\n## Test Plan\n- y\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce("");

    await expect(
      enrichPrDescription({
        prNumber: 42,
        taskId: "EMI-123",
        agentPrompt: "feature",
        repoPath: "/repo",
        claudePath: "claude",
        model: "haiku",
      }),
    ).resolves.toBeUndefined();

    expect(execSyncMock).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Empty agentPrompt — function proceeds without ticket context
// ---------------------------------------------------------------------------
describe("enrichPrDescription — empty agentPrompt", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proceeds without throwing when agentPrompt is empty string", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] Something",
        body: "## Summary\n- stuff\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce("");

    await expect(
      enrichPrDescription({
        prNumber: 42,
        taskId: "EMI-123",
        agentPrompt: "", // empty — no context passed to haiku
        repoPath: "/repo",
        claudePath: "claude",
        model: "haiku",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isWellStructuredPrBody — edge cases
// ---------------------------------------------------------------------------
describe("isWellStructuredPrBody — edge cases", () => {
  it("returns false for empty string", () => {
    expect(isWellStructuredPrBody("", "EMI-123")).toBe(false);
  });

  it("returns false for body that is exactly 100 characters (boundary off-by-one)", () => {
    // Requirement: > 100 chars. Exactly 100 should return false.
    const body = "## Summary\nEMI-123 " + "A".repeat(80); // need total = 100
    // Construct a body of exactly 100 chars with headers and taskId
    const base = "## Summary\nEMI-123\n";
    const padded = base + "A".repeat(100 - base.length);
    expect(padded.length).toBe(100);
    expect(isWellStructuredPrBody(padded, "EMI-123")).toBe(false);
  });

  it("returns false for body that is 101 chars but has no taskId", () => {
    const body = "## Summary\n" + "A".repeat(91); // 102 chars, no taskId
    expect(body.length).toBeGreaterThan(100);
    expect(isWellStructuredPrBody(body, "EMI-999")).toBe(false);
  });

  it("returns false when taskId appears only as substring of a longer ID in a well-structured body", () => {
    // Body has all required sections but only mentions EMI-10 (not EMI-1).
    // Word-boundary regex prevents EMI-1 from matching inside EMI-10.
    const body =
      "## Summary\n\nWork done on EMI-10 ticket.\n\n## Changes\n\n- stuff\n\n## Test Plan\n\n- tested\n" +
      "Additional context goes here to push past the 100 char threshold.";
    expect(body.length).toBeGreaterThan(100);
    const result = isWellStructuredPrBody(body, "EMI-1");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Model parameter passthrough — passed directly to claude without validation
// ---------------------------------------------------------------------------
describe("enrichPrDescription — model parameter passthrough", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes model string directly to claude without validation", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] feat",
        body: "## Summary\n- done\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce("");

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "claude-3-opus-20240229", // expensive model, not haiku
    });

    // Verify the model arg was passed through unchanged
    const claudeCall = execSyncMock.mock.calls[2]!;
    expect(claudeCall[1]).toContain("--model");
    const modelIdx = (claudeCall[1] as string[]).indexOf("--model");
    expect((claudeCall[1] as string[])[modelIdx + 1]).toBe(
      "claude-3-opus-20240229",
    );
    // No validation — an expensive model silently passes through
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON from gh pr view — non-fatal error handling
// ---------------------------------------------------------------------------
describe("enrichPrDescription — malformed JSON from gh pr view", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is non-fatal when gh pr view returns non-JSON output", async () => {
    // gh sometimes emits warnings before JSON (e.g., auth warnings)
    execSyncMock.mockReturnValueOnce(
      "Warning: token has been refreshed\nnot valid json at all",
    );

    await expect(
      enrichPrDescription({
        prNumber: 42,
        taskId: "EMI-123",
        agentPrompt: "feature",
        repoPath: "/repo",
        claudePath: "claude",
        model: "haiku",
      }),
    ).resolves.toBeUndefined();

    // gh pr view called once, nothing else
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("is non-fatal when gh pr view returns empty string", async () => {
    execSyncMock.mockReturnValueOnce("");

    await expect(
      enrichPrDescription({
        prNumber: 42,
        taskId: "EMI-123",
        agentPrompt: "feature",
        repoPath: "/repo",
        claudePath: "claude",
        model: "haiku",
      }),
    ).resolves.toBeUndefined();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Content validation — generated output must match requirements
// ---------------------------------------------------------------------------
describe("enrichPrDescription — content validation", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips gh pr edit when title does not start with [taskId]", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "feat: something without task prefix",
        body: "## Summary\n- done\n\n## Changes\n- x\n\n## Test Plan\n- y\n\nCloses EMI-123",
      }),
    );

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(0);
  });

  it("skips gh pr edit when body is missing required sections", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] feat: something",
        body: "## Summary\n- done\n\nCloses EMI-123",
        // Missing ## Changes and ## Test Plan
      }),
    );

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(0);
  });

  it("truncates title exceeding 70 chars but still applies", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    const longTitle =
      "[EMI-123] feat: this title is way too long and exceeds the seventy char limit by a lot";
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: longTitle,
        body: "## Summary\n- done\n\n## Changes\n- x\n\n## Test Plan\n- y\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce(""); // gh pr edit

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(1);
    const titleIdx = (editCalls[0]![1] as string[]).indexOf("--title");
    const appliedTitle = (editCalls[0]![1] as string[])[titleIdx + 1];
    expect(appliedTitle!.length).toBeLessThanOrEqual(70);
    expect(appliedTitle).toContain("[EMI-123]");
  });

  it("applies when title and body both meet requirements", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] feat: add thing",
        body: "## Summary\n- done\n\n## Changes\n- added x\n\n## Test Plan\n- ran tests\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce(""); // gh pr edit

    await enrichPrDescription({
      prNumber: 42,
      taskId: "EMI-123",
      agentPrompt: "feature",
      repoPath: "/repo",
      claudePath: "claude",
      model: "haiku",
    });

    const editCalls = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    );
    expect(editCalls).toHaveLength(1);
  });
});
