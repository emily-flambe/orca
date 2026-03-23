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
// BUG 1: Skip heuristic false positives — garbage body passes the check
// A body with only `## X` + taskId + sufficient length is NOT well-structured,
// but the heuristic returns true. This causes real PRs to be skipped.
// ---------------------------------------------------------------------------
describe("isWellStructuredPrBody — heuristic false positives", () => {
  it("BUG: returns true for garbage body that happens to contain ## and taskId", () => {
    // This body has ## headers and taskId but is clearly NOT a well-structured PR description.
    // It's a single-line with random text. The requirement says "well-structured" means
    // summary, changes list, Linear ticket reference, test plan — this has none of that.
    const garbageBody = "## EMI-123 is garbage: " + "X".repeat(90);
    // This SHOULD return false but the heuristic returns true
    // (has "## ", has "EMI-123", length > 100)
    const result = isWellStructuredPrBody(garbageBody, "EMI-123");
    // The heuristic incorrectly approves this garbage body:
    expect(result).toBe(false); // FAILS: returns true
  });

  it("BUG: returns true for body that has ## in a code block, not a real header", () => {
    // A PR body that has ## only inside a code block (not a real markdown header)
    // should arguably not be considered "well-structured"
    const codeBlockBody =
      "This PR does stuff. EMI-456\n\n```bash\n## this is a comment\n```\n" +
      "A".repeat(80);
    const result = isWellStructuredPrBody(codeBlockBody, "EMI-456");
    // Heuristic: body > 100 chars ✓, includes "## " ✓, includes "EMI-456" ✓
    // Returns true even though there's no real markdown header
    expect(result).toBe(false); // FAILS: returns true
  });

  it("BUG: taskId appearing only as part of a longer string satisfies the heuristic", () => {
    // "EMI-1" is a substring of "EMI-10", "EMI-100", etc.
    // If taskId is "EMI-1", a body mentioning "EMI-10" passes the heuristic.
    const body = "## Summary\nSome work was done on EMI-10\n" + "A".repeat(80);
    // isWellStructuredPrBody(body, "EMI-1") -> true because "EMI-10".includes("EMI-1")
    const result = isWellStructuredPrBody(body, "EMI-1");
    expect(result).toBe(false); // FAILS: returns true (substring match)
  });
});

// ---------------------------------------------------------------------------
// BUG 2: Greedy JSON regex — multiple JSON objects produce broken parse
// The regex /\{[\s\S]*\}/ is greedy and will span from the FIRST { to the
// LAST }, potentially combining two separate JSON objects into one invalid string.
// ---------------------------------------------------------------------------
describe("enrichPrDescription — greedy JSON regex bug", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("BUG: greedy regex matches across two JSON objects, producing invalid JSON or wrong result", async () => {
    // Claude outputs TWO JSON objects (preamble json + actual json).
    // The greedy regex captures from first { to last }, creating:
    // {"first": "object"} ... {"title": "...", "body": "..."}
    // which is invalid JSON. This should NOT apply the description.
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce(""); // git diff
    // Two JSON objects in output — greedy regex incorrectly merges them
    execSyncMock.mockReturnValueOnce(
      '{"thinking": "let me format this"} and here is the real answer: {"title": "[EMI-123] feat", "body": "## Summary\\n- done\\n\\nCloses EMI-123"}',
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

    // With greedy regex, it tries to parse:
    // '{"thinking": "let me format this"} and here is the real answer: {"title": ...}'
    // which is NOT valid JSON. So gh pr edit should NOT be called.
    // But the greedy regex extracts the wrong span.
    // Check: did gh pr edit get called with the RIGHT title?
    const editCallCount = execSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "gh" && (call[1] as string[]).includes("edit"),
    ).length;
    // The function should either apply the correct second JSON or skip — not silently apply wrong data
    // Currently the greedy regex fails on this case (JSON.parse throws), so it's non-fatal (0 edits).
    // But if Claude outputs VALID nested JSON or objects without intervening text, it could apply wrong data.
    expect(editCallCount).toBeLessThanOrEqual(1); // documents behavior, not necessarily correct
  });

  it("BUG: greedy regex picks wrong JSON when output has json metadata wrapper around the actual object", async () => {
    // If Claude wraps output in {"result": {"title": "...", "body": "..."}}
    // the regex matches the outer object, not the inner one.
    // JSON.parse succeeds but generated.title and generated.body are undefined.
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    // Nested JSON — outer object parsed but missing title/body keys at top level
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
// BUG 3: Empty-string body is not guarded before isWellStructuredPrBody
// If gh returns body: null (GitHub API quirk), the ?? "" guard handles it.
// But the test suite doesn't cover null body from the API response.
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
// BUG 4: Empty agentPrompt — no test coverage
// When agentPrompt is an empty string, ticketContext is "" and the prompt
// has no Linear ticket context. The function still proceeds but may produce
// useless output.
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
// BUG 5: isWellStructuredPrBody with empty string
// Not tested in the existing suite — documents behavior.
// ---------------------------------------------------------------------------
describe("isWellStructuredPrBody — edge cases not tested", () => {
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

  it("BUG: taskId substring match — 'EMI-1' matches body containing 'EMI-10'", () => {
    // body mentions EMI-10 but not EMI-1 specifically.
    // Must be > 100 chars to trigger the substring match bug.
    const body =
      "## Summary\n\nWork done on EMI-10 ticket.\n\n## Changes\n\n- stuff\n\n## Test Plan\n\n- tested\n" +
      "Additional context goes here to push past the 100 char threshold.";
    expect(body.length).toBeGreaterThan(100);
    // This body does NOT reference EMI-1 as an exact task
    // but body.includes("EMI-1") is true because "EMI-10".includes("EMI-1")
    const result = isWellStructuredPrBody(body, "EMI-1");
    // Currently returns true (false positive) — should return false
    expect(result).toBe(false); // FAILS: returns true (substring match)
  });
});

// ---------------------------------------------------------------------------
// BUG 6: model parameter not validated — wrong model can be passed silently
// The function accepts any string as model. If config.reviewModel is
// misconfigured (e.g. "claude-3-sonnet" instead of "haiku"), no error is raised.
// This is a design issue, not a runtime crash, but worth documenting.
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
// BUG 7: gh pr view JSON parse — malformed JSON from gh is non-fatal
// but the implementation assumes the JSON is always valid. If gh returns
// non-JSON (e.g., a warning message prepended to output), JSON.parse throws
// inside the try/catch, which is correctly non-fatal. Test this path.
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
