// ---------------------------------------------------------------------------
// Unit tests for src/github/pr-description.ts
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
import { resolveClaudeBinary } from "../src/runner/index.js";
import {
  isWellStructuredPrBody,
  enrichPrDescription,
} from "../src/github/pr-description.js";

const execSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const resolveMock = resolveClaudeBinary as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// isWellStructuredPrBody
// ---------------------------------------------------------------------------

describe("isWellStructuredPrBody", () => {
  it("returns false when body is too short", () => {
    expect(isWellStructuredPrBody("Short body", "EMI-123")).toBe(false);
  });

  it("returns false when no ## headers present", () => {
    const longBody = "A".repeat(200) + "EMI-123";
    expect(isWellStructuredPrBody(longBody, "EMI-123")).toBe(false);
  });

  it("returns false when taskId not in body", () => {
    const body = "## Summary\n" + "A".repeat(200);
    expect(isWellStructuredPrBody(body, "EMI-123")).toBe(false);
  });

  it("returns false when body length is exactly 100", () => {
    // Need length > 100, headers, and taskId — remove length
    const body = "## Summary\nEMI-123\n" + "A".repeat(80); // total ~100
    expect(isWellStructuredPrBody(body, "EMI-123")).toBe(false);
  });

  it("returns true when body has all required sections, taskId, and sufficient length", () => {
    const body =
      "## Summary\n\n- Did the thing\n\n## Changes\n\n- File changed\n\n## Test Plan\n\n- Tested\n\nCloses EMI-123\n" +
      "A".repeat(50);
    expect(isWellStructuredPrBody(body, "EMI-123")).toBe(true);
  });

  it("returns false when body has headers and length but missing taskId", () => {
    const body =
      "## Summary\n\n- Did something\n\n## Changes\n\n" + "A".repeat(100);
    expect(isWellStructuredPrBody(body, "EMI-456")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enrichPrDescription
// ---------------------------------------------------------------------------

const baseOpts = {
  prNumber: 42,
  taskId: "EMI-123",
  agentPrompt: "Implement the feature",
  repoPath: "/repo",
  claudePath: "claude",
  model: "haiku",
};

describe("enrichPrDescription", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    resolveMock.mockReturnValue({ command: "claude", prefixArgs: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips enrichment when PR body is already well-structured", async () => {
    const wellStructuredBody =
      "## Summary\n\n- Did the thing\n\n## Changes\n\n- Changed files\n\n## Test Plan\n\n- Tested\n\nCloses EMI-123\n" +
      "A".repeat(50);
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "Existing title", body: wellStructuredBody }),
    );

    await enrichPrDescription(baseOpts);

    // gh pr view called once, claude never called
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock.mock.calls[0]![1]).toContain("pr");
  });

  it("calls claude and applies generated title/body when PR body is not well-structured", async () => {
    // First call: gh pr view returns sparse body
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: "short" }),
    );
    // Second call: git diff
    execSyncMock.mockReturnValueOnce("diff --git a/foo.ts b/foo.ts\n+new line");
    // Third call: claude -p returns JSON
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] Add feature",
        body: "## Summary\n- Did it\n\n## Changes\n- x\n\n## Test Plan\n- tested\n\nCloses EMI-123",
      }),
    );
    // Fourth call: gh pr edit
    execSyncMock.mockReturnValueOnce("");

    await enrichPrDescription(baseOpts);

    expect(execSyncMock).toHaveBeenCalledTimes(4);

    // Verify gh pr edit was called with new title and body
    const editCall = execSyncMock.mock.calls[3]!;
    expect(editCall[0]).toBe("gh");
    expect(editCall[1]).toContain("edit");
    expect(editCall[1]).toContain("--title");
    expect(editCall[1]).toContain("[EMI-123] Add feature");
    expect(editCall[1]).toContain("--body");
  });

  it("is non-fatal when gh pr view fails", async () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("gh: not found");
    });

    // Should not throw
    await expect(enrichPrDescription(baseOpts)).resolves.toBeUndefined();
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("is non-fatal when claude invocation fails", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: "short" }),
    );
    // git diff
    execSyncMock.mockReturnValueOnce("");
    // claude fails
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("claude: timeout");
    });

    await expect(enrichPrDescription(baseOpts)).resolves.toBeUndefined();
    // No gh pr edit call
    expect(execSyncMock).toHaveBeenCalledTimes(3);
  });

  it("is non-fatal when claude output contains no JSON", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    // claude returns non-JSON
    execSyncMock.mockReturnValueOnce("I cannot generate that.");

    await expect(enrichPrDescription(baseOpts)).resolves.toBeUndefined();
    // No gh pr edit call
    expect(execSyncMock).toHaveBeenCalledTimes(3);
  });

  it("is non-fatal when generated JSON is missing title", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ body: "## Summary\n- thing" }),
    );

    await expect(enrichPrDescription(baseOpts)).resolves.toBeUndefined();
    expect(execSyncMock).toHaveBeenCalledTimes(3);
  });

  it("is non-fatal when gh pr edit fails", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "My PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] Fix it",
        body: "## Summary\n- fixed\n\n## Changes\n- x\n\n## Test Plan\n- tested\n\nCloses EMI-123",
      }),
    );
    // gh pr edit fails
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("gh: permission denied");
    });

    await expect(enrichPrDescription(baseOpts)).resolves.toBeUndefined();
    expect(execSyncMock).toHaveBeenCalledTimes(4);
  });

  it("uses resolveClaudeBinary for the claude command", async () => {
    resolveMock.mockReturnValue({
      command: "node",
      prefixArgs: ["/path/to/cli.js"],
    });
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        title: "[EMI-123] title",
        body: "## Summary\n- x\n\n## Changes\n- y\n\n## Test Plan\n- z\n\nCloses EMI-123",
      }),
    );
    execSyncMock.mockReturnValueOnce("");

    await enrichPrDescription(baseOpts);

    const claudeCall = execSyncMock.mock.calls[2]!;
    expect(claudeCall[0]).toBe("node");
    expect(claudeCall[1]).toContain("/path/to/cli.js");
  });

  it("extracts JSON from claude output that contains preamble text", async () => {
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({ title: "PR", body: "short" }),
    );
    execSyncMock.mockReturnValueOnce("");
    // Output with preamble before JSON
    execSyncMock.mockReturnValueOnce(
      'Here is the JSON:\n{"title":"[EMI-123] feat","body":"## Summary\\n- done\\n\\n## Changes\\n- x\\n\\n## Test Plan\\n- y\\n\\nCloses EMI-123"}',
    );
    execSyncMock.mockReturnValueOnce("");

    await enrichPrDescription(baseOpts);

    const editCall = execSyncMock.mock.calls[3]!;
    expect(editCall[1]).toContain("[EMI-123] feat");
  });
});
