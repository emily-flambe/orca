import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnSession,
  invocationLogs,
  resolveClaudeBinary,
} from "../src/runner/index.js";
import { spawnShellCommand, activeShellHandles } from "../src/runner/shell.js";
import { inngest } from "../src/inngest/client.js";

vi.mock("../src/inngest/client.js", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let invocationCounter = 10000;
function nextInvocationId(): number {
  return ++invocationCounter;
}

function makeScript(lines: string[]): string {
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1. NDJSON stream parsing
// ---------------------------------------------------------------------------

describe("NDJSON stream parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-runner-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("system/init sets handle.sessionId", async () => {
    const script = join(tmpDir, "init.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"abc-123"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    await handle.done;
    expect(handle.sessionId).toBe("abc-123");
  });

  test("result/success parses costUsd, numTurns, outputSummary", async () => {
    const script = join(tmpDir, "success.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.042,num_turns:7,result:"all done"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.costUsd).toBeCloseTo(0.042);
    expect(result.numTurns).toBe(7);
    expect(result.outputSummary).toBe("all done");
    expect(result.exitCode).toBe(0);
  });

  test("result/error_max_turns sets outputSummary to 'max turns reached'", async () => {
    const script = join(tmpDir, "max-turns.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"error_max_turns",total_cost_usd:0.01,num_turns:10}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("error_max_turns");
    expect(result.outputSummary).toBe("max turns reached");
  });

  test("result/error_during_execution joins errors array", async () => {
    const script = join(tmpDir, "exec-error.js");
    const errors = ["tool failed", "network timeout"];
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",errors:${JSON.stringify(errors)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("error_during_execution");
    expect(result.outputSummary).toBe("tool failed; network timeout");
  });

  test("malformed JSON lines are skipped, result still succeeds after them", async () => {
    const script = join(tmpDir, "malformed.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write("this is not json\\n");',
        'process.stdout.write("{broken json\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"survived"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.outputSummary).toBe("survived");
  });

  test("result text > 500 chars is truncated to 500 in outputSummary", async () => {
    const longText = "x".repeat(600);
    const script = join(tmpDir, "long-result.js");
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(longText)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    // The raw truncated portion should be at most 500 chars (possibly prepended marker makes it longer)
    // Check that the base truncated text is exactly 500 'x' chars
    expect(result.outputSummary).toBe("x".repeat(500));
  });

  test("REVIEW_RESULT marker beyond 500 chars gets prepended to outputSummary", async () => {
    // Put REVIEW_RESULT:APPROVED after position 500 so it won't be in the truncated part
    const prefix = "y".repeat(510);
    const resultText = prefix + " REVIEW_RESULT:APPROVED";
    const script = join(tmpDir, "review-marker.js");
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.outputSummary).toContain("REVIEW_RESULT:APPROVED");
    // Marker should appear at the start (prepended)
    expect(result.outputSummary.startsWith("REVIEW_RESULT:APPROVED")).toBe(
      true,
    );
  });

  test("REVIEW_RESULT marker within first 500 chars is NOT prepended again", async () => {
    const resultText = "REVIEW_RESULT:APPROVED short result";
    const script = join(tmpDir, "review-inline.js");
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    // Should appear exactly once, not duplicated
    const count = (result.outputSummary.match(/REVIEW_RESULT:APPROVED/g) ?? [])
      .length;
    expect(count).toBe(1);
  });

  test("PR URL beyond 500 chars gets prepended to outputSummary", async () => {
    const prefix = "z".repeat(510);
    const prUrl = "https://github.com/owner/repo/pull/42";
    const resultText = prefix + " " + prUrl;
    const script = join(tmpDir, "pr-url.js");
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.outputSummary).toContain(prUrl);
    expect(result.outputSummary.startsWith(prUrl)).toBe(true);
  });

  test("total_cost_usd takes precedence over cost_usd", async () => {
    const script = join(tmpDir, "cost-precedence.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.099,cost_usd:0.001,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.costUsd).toBeCloseTo(0.099);
  });

  test("falls back to cost_usd when total_cost_usd absent", async () => {
    const script = join(tmpDir, "cost-fallback.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",cost_usd:0.007,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.costUsd).toBeCloseTo(0.007);
  });

  test("usage tokens: input + cache_creation + cache_read summed as inputTokens", async () => {
    const script = join(tmpDir, "tokens.js");
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 200,
    };
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok",usage:${JSON.stringify(usage)}}) + "\\n");`,
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.inputTokens).toBe(175); // 100 + 50 + 25
    expect(result.outputTokens).toBe(200);
  });

  test("process exits with code 0 and no result message => success with 'process exited cleanly'", async () => {
    const script = join(tmpDir, "no-result.js");
    writeFileSync(
      script,
      makeScript([
        // Emit a non-result line so there's some output but no result message
        'process.stdout.write(JSON.stringify({type:"assistant",message:"hello"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toContain("process exited cleanly");
  });
});

// ---------------------------------------------------------------------------
// 2. Rate limit detection
// ---------------------------------------------------------------------------

describe("Rate limit detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-ratelimit-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rate_limit_event with overageStatus 'rejected' + non-zero exit => subtype rate_limited", async () => {
    const script = join(tmpDir, "rate-limited.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"daily",resetsAt:"2026-01-01T12:00:00Z"}) + "\\n");',
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("rate_limited");
    expect(result.exitCode).toBe(1);
  });

  test("rateLimitResetsAt is propagated from resetsAt field", async () => {
    const script = join(tmpDir, "rate-limited-resets.js");
    const resetsAt = "2026-03-15T06:00:00Z";
    writeFileSync(
      script,
      makeScript([
        `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"hourly",resetsAt:${JSON.stringify(resetsAt)}}) + "\\n");`,
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("rate_limited");
    expect(result.rateLimitResetsAt).toBe(resetsAt);
  });

  test("rate_limit_event with overageStatus NOT 'rejected' does NOT trigger rate_limited subtype", async () => {
    const script = join(tmpDir, "rate-not-rejected.js");
    writeFileSync(
      script,
      makeScript([
        // overageStatus is "allowed", not "rejected"
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"allowed",rateLimitType:"daily",resetsAt:"2026-01-01T12:00:00Z"}) + "\\n");',
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    // Should be process_error, not rate_limited
    expect(result.subtype).toBe("process_error");
  });

  test("rate_limit_event with overageStatus 'rejected' but exit code 0 does NOT override result", async () => {
    // If the process exits 0 with no result message, it should be success not rate_limited
    const script = join(tmpDir, "rate-exit-0.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"daily",resetsAt:"2026-01-01T12:00:00Z"}) + "\\n");',
        // Exit 0 — no result message
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    // Exit 0, no result message: "process exited cleanly" path, not rate_limited
    // (rate_limited requires non-zero exit or signal)
    expect(result.subtype).toBe("success");
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. invocationLogs Map management
// ---------------------------------------------------------------------------

describe("invocationLogs Map management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-logs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("invocationLogs has entry for invocationId after spawnSession", async () => {
    const script = join(tmpDir, "quick.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();

    // Verify map entry exists right after spawn (before done)
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    // Entry should be present immediately after spawn
    expect(invocationLogs.has(id)).toBe(true);

    await handle.done;
    // Entry may still be present (deleted after 60s timer), that's OK
  });

  test("buffer accumulates lines emitted by mock script", async () => {
    const script = join(tmpDir, "multi-line.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"s1"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"assistant",message:"step 1"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"assistant",message:"step 2"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:2,result:"done"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const logState = await new Promise<{ buffer: string[] }>((resolve) => {
      const handle = spawnSession({
        agentPrompt: "test",
        worktreePath: tmpDir,
        maxTurns: 5,
        invocationId: id,
        projectRoot: tmpDir,
        claudePath: process.execPath,
        claudeArgs: [script],
      });

      // Capture the log state before it's potentially cleaned up
      const state = invocationLogs.get(id)!;
      handle.done.then(() => resolve(state));
    });

    // Should have buffered 4 lines (init + 2 assistant + result)
    expect(logState.buffer.length).toBe(4);
  });

  test("buffer caps at 100 lines, shifting oldest", async () => {
    // Emit 110 lines, buffer should hold only the last 100
    const lines: string[] = [];
    for (let i = 0; i < 110; i++) {
      lines.push(
        `process.stdout.write(JSON.stringify({type:"assistant",seq:${i}}) + "\\n");`,
      );
    }
    lines.push(
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");',
    );

    const script = join(tmpDir, "overflow.js");
    writeFileSync(script, lines.join("\n"));

    const id = nextInvocationId();
    const logState = await new Promise<{ buffer: string[] }>((resolve) => {
      const handle = spawnSession({
        agentPrompt: "test",
        worktreePath: tmpDir,
        maxTurns: 5,
        invocationId: id,
        projectRoot: tmpDir,
        claudePath: process.execPath,
        claudeArgs: [script],
      });

      const state = invocationLogs.get(id)!;
      handle.done.then(() => resolve(state));
    });

    // 111 lines total, capped at 100
    expect(logState.buffer.length).toBe(100);
  });

  test("emitter fires 'line' events for each stdout line", async () => {
    const script = join(tmpDir, "emitter.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"e1"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"emit test"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const receivedLines: string[] = [];

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const state = invocationLogs.get(id)!;
    state.emitter.on("line", (line: string) => receivedLines.push(line));

    await handle.done;

    expect(receivedLines.length).toBe(2);
    expect(receivedLines[0]).toContain('"system"');
    expect(receivedLines[1]).toContain('"result"');
  });
});

// ---------------------------------------------------------------------------
// 4. Session resume argument construction
// ---------------------------------------------------------------------------

describe("Session resume argument construction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-resume-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--resume and session ID appear in args when resumeSessionId is provided", async () => {
    // Script that writes process.argv as a JSON line then exits cleanly
    const script = join(tmpDir, "argv-reporter.js");
    writeFileSync(
      script,
      makeScript([
        // Emit a result so the session completes cleanly
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test prompt",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      resumeSessionId: "resume-xyz-456",
    });

    const result = await handle.done;
    // The result field contains the argv JSON (it may be truncated, but --resume is short)
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).toContain("--resume");
    expect(argv).toContain("resume-xyz-456");
  });

  test("no --resume in args when resumeSessionId is not provided", async () => {
    const script = join(tmpDir, "argv-no-resume.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test prompt",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No resumeSessionId
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).not.toContain("--resume");
  });

  test("model arg appears in args when model is provided", async () => {
    const script = join(tmpDir, "argv-model.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      model: "claude-haiku-4-5",
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// 5. resolveClaudeBinary
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary", () => {
  test("on non-Windows: returns requested command with empty prefixArgs", () => {
    if (process.platform === "win32") {
      // On Windows the function may try to resolve via 'where', skip this test
      return;
    }

    const result = resolveClaudeBinary("/usr/local/bin/my-claude-unique-9999");
    expect(result.command).toBe("/usr/local/bin/my-claude-unique-9999");
    expect(result.prefixArgs).toEqual([]);
  });

  test("calling twice with same path returns consistent result (caching)", () => {
    // Use a unique path so we don't collide with other test cache entries
    const uniquePath =
      process.platform === "win32"
        ? "C:\\unique-test-path-99887766\\claude.exe"
        : "/unique-test-path-99887766/claude";

    const first = resolveClaudeBinary(uniquePath);
    const second = resolveClaudeBinary(uniquePath);

    // Both calls must return the same shape
    expect(second.command).toBe(first.command);
    expect(second.prefixArgs).toEqual(first.prefixArgs);
  });

  test("non-Windows path with explicit execPath returns it unchanged", () => {
    if (process.platform === "win32") {
      return;
    }

    // process.execPath is always available and non-.cmd on non-Windows
    const result = resolveClaudeBinary(process.execPath);
    expect(result.command).toBe(process.execPath);
    expect(result.prefixArgs).toEqual([]);
  });

  test("on Windows: explicit non-.cmd path falls through to direct", () => {
    if (process.platform !== "win32") {
      return;
    }

    // An .exe path that doesn't exist: not a .cmd shim, falls through to direct
    const fakePath = "C:\\nonexistent-unique-path-12345\\node.exe";
    const result = resolveClaudeBinary(fakePath);
    // Should return direct (since it's not .cmd)
    expect(result.command).toBe(fakePath);
    expect(result.prefixArgs).toEqual([]);
  });

  test("on Windows: .cmd file that does not match shim pattern falls through to direct", () => {
    if (process.platform !== "win32") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "orca-resolve-test-"));
    try {
      const cmdPath = join(dir, "fake-claude-unique-7788.cmd");
      writeFileSync(cmdPath, "@echo off\necho hello\n");

      // This .cmd doesn't match the shim regex, so falls through to direct
      const result = resolveClaudeBinary(cmdPath);
      expect(result.command).toBe(cmdPath);
      expect(result.prefixArgs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. shell.ts spawnShellCommand
// ---------------------------------------------------------------------------

describe("shell.ts spawnShellCommand", () => {
  test("runs a command and captures stdout output", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(
      `node -e "process.stdout.write('hello shell')"`,
      { timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello shell");
    expect(result.timedOut).toBe(false);
  });

  test("captures stderr output combined with stdout", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(
      `node -e "process.stdout.write('out');process.stderr.write('err')"`,
      { timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  test("returns non-zero exitCode for failing command", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(`node -e "process.exit(42)"`, {
      timeoutMs: 10_000,
      invocationId: id,
    });

    const result = await handle.done;
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  test("activeShellHandles is populated during execution and deleted after close", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(
      `node -e "process.stdout.write('active test')"`,
      { timeoutMs: 10_000, invocationId: id },
    );

    // Map should contain the handle while running
    expect(activeShellHandles.has(id)).toBe(true);

    await handle.done;

    // Map should be cleaned up after close
    expect(activeShellHandles.has(id)).toBe(false);
  });

  test("timedOut is true and process is killed when command exceeds timeoutMs", async () => {
    const id = nextInvocationId();
    // Use a command that exits quickly on its own after a small delay so we
    // can verify timedOut without relying on SIGKILL working on Windows shells.
    // The command exits after 500ms; we set timeoutMs to 100ms so the timeout
    // fires first and sets timedOut=true. The process then exits on its own
    // shortly after, allowing the done promise to resolve.
    const handle = spawnShellCommand(
      `node -e "setTimeout(function(){process.exit(0)},500)"`,
      { timeoutMs: 100, invocationId: id },
    );

    const result = await handle.done;
    expect(result.timedOut).toBe(true);
  }, 15_000);

  test("kill() method terminates the command early", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(
      `node -e "setTimeout(function(){},60000)"`,
      { timeoutMs: 30_000, invocationId: id },
    );

    // Wait for process to actually spawn before killing
    await new Promise((r) => setTimeout(r, 500));
    handle.kill();

    const result = await handle.done;
    // Not a timeout (we called kill manually), but process should have exited
    expect(result.timedOut).toBe(false);
    // exitCode may be null (signal) or non-zero
    const exitedAbnormally = result.exitCode !== 0 || result.exitCode === null;
    expect(exitedAbnormally).toBe(true);
  }, 30_000);

  test("cwd option is passed to the spawned process", async () => {
    const id = nextInvocationId();
    const handle = spawnShellCommand(
      `node -e "process.stdout.write(process.cwd())"`,
      {
        timeoutMs: 10_000,
        invocationId: id,
        cwd: tmpdir(),
      },
    );

    const result = await handle.done;
    // Output should contain the tmpdir path (normalized)
    expect(result.output.toLowerCase()).toContain(
      tmpdir().toLowerCase().replace(/\\/g, "/").split("/")[1] ?? "tmp",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Inngest event emission
// ---------------------------------------------------------------------------

describe("Inngest event emission", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-inngest-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("inngest.send called with session/completed when inngestContext provided and session succeeds", async () => {
    const script = join(tmpDir, "inngest-success.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"sess-abc"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.05,num_turns:3,result:"done well"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-42",
        phase: "implement",
        retryCount: 1,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/completed");
    expect(call.data.invocationId).toBe(id);
    expect(call.data.linearIssueId).toBe("LIN-42");
    expect(call.data.phase).toBe("implement");
    expect(call.data.status).toBe("completed");
    expect(call.data.exitCode).toBe(0);
    expect(call.data.summary).toBe("done well");
    expect(call.data.sessionId).toBe("sess-abc");
    expect(typeof call.data.durationMs).toBe("number");
  });

  test("inngest.send called with session/failed when inngestContext provided and session exits non-zero", async () => {
    const script = join(tmpDir, "inngest-fail.js");
    writeFileSync(
      script,
      makeScript([
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-99",
        phase: "review",
        retryCount: 2,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    expect(call.data.invocationId).toBe(id);
    expect(call.data.linearIssueId).toBe("LIN-99");
    expect(call.data.phase).toBe("review");
    expect(call.data.retryCount).toBe(2);
    expect(call.data.status).toBe("failed");
    expect(call.data.exitCode).toBe(1);
    expect(typeof call.data.summary).toBe("string");
    expect(call.data.sessionId).toBeNull();
  });

  test("inngest.send is NOT called when inngestContext is not provided", async () => {
    const script = join(tmpDir, "inngest-no-context.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No inngestContext
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // BUG PROBE: rate_limited fires session/failed — verify the event name and
  // check that sessionId is included (it will be null since no system/init).
  test("inngest.send called with session/failed when session is rate_limited", async () => {
    const script = join(tmpDir, "inngest-rate-limited.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"daily",resetsAt:"2026-03-20T00:00:00Z"}) + "\\n");',
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-200",
        phase: "implement",
        retryCount: 1,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    expect(call.data.status).toBe("failed");
    expect(call.data.retryCount).toBe(1);
    // rate_limited subtype has exitCode 1
    expect(call.data.exitCode).toBe(1);
    // sessionId should be null (no system/init received)
    expect(call.data.sessionId).toBeNull();
    // reason should contain "rate limited"
    expect(typeof call.data.reason).toBe("string");
    expect((call.data.reason as string).toLowerCase()).toContain("rate");
  });

  // BUG PROBE: retryCount defaults to 0 when undefined in inngestContext.
  // Tests that the fallback ?? 0 works correctly for session/failed path.
  test("retryCount defaults to 0 when not provided in inngestContext (session/failed path)", async () => {
    const script = join(tmpDir, "inngest-retry-default.js");
    writeFileSync(
      script,
      makeScript([
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-300",
        phase: "review",
        // retryCount intentionally omitted
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    expect(call.data.retryCount).toBe(0);
  });

  // BUG PROBE: session/completed event includes durationMs > 0.
  // Verify durationMs is a positive number, not zero or negative.
  test("session/completed durationMs is a positive number", async () => {
    const script = join(tmpDir, "inngest-duration.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-400",
        phase: "implement",
        retryCount: 0,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/completed");
    expect(typeof call.data.durationMs).toBe("number");
    expect(call.data.durationMs as number).toBeGreaterThan(0);
  });

  // BUG PROBE: session/failed from the proc.on("error") spawn error path
  // fires with correct fields. The proc.on("error") path has its OWN
  // inngest.send call separate from tryResolve — verify it works.
  // NOTE: We cannot easily trigger a real spawn error in tests (requires a
  // non-existent executable). We verify the error path via process_error
  // caused by a non-zero exit with no result message instead.
  test("session/failed from process_error (non-zero exit, no result) includes correct fields", async () => {
    const script = join(tmpDir, "inngest-process-error.js");
    writeFileSync(
      script,
      makeScript([
        // No result message, just exits with code 2
        "process.exit(2);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-500",
        phase: "gate2",
        retryCount: 3,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    expect(call.data.exitCode).toBe(2);
    expect(call.data.retryCount).toBe(3);
    expect(call.data.sessionId).toBeNull();
    // "reason" and "summary" should both be the outputSummary
    expect(call.data.reason).toBe(call.data.summary);
    // The summary should mention the exit code
    expect((call.data.summary as string)).toContain("2");
  });

  // BUG PROBE: error_during_execution fires session/failed, not session/completed.
  // Verify this is the actual behavior (testing the non-success subtype routing).
  test("error_during_execution fires session/failed (not session/completed)", async () => {
    const script = join(tmpDir, "inngest-exec-error.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",errors:["tool X failed"]}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-600",
        phase: "implement",
        retryCount: 0,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    expect(call.data.status).toBe("failed");
    // The summary/reason should reference the tool error
    expect((call.data.summary as string)).toContain("tool X failed");
  });

  // BUG PROBE: session/failed does NOT include a durationMs field.
  // The session/completed schema requires durationMs but session/failed does not.
  // This tests that callers cannot rely on durationMs from session/failed events.
  test("session/failed event does NOT include durationMs field", async () => {
    const script = join(tmpDir, "inngest-failed-duration.js");
    writeFileSync(
      script,
      makeScript([
        "process.exit(1);",
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-700",
        phase: "implement",
        retryCount: 0,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/failed");
    // This WILL PASS — session/failed genuinely lacks durationMs.
    // Documenting that the asymmetry exists so it can be evaluated intentionally.
    expect(call.data.durationMs).toBeUndefined();
  });

  // BUG PROBE: sessionId is correctly captured and included in session/completed
  // when a system/init message was received before the result.
  test("session/completed includes sessionId from system/init", async () => {
    const script = join(tmpDir, "inngest-session-id.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"my-session-xyz"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      inngestContext: {
        linearIssueId: "LIN-800",
        phase: "implement",
        retryCount: 0,
      },
    });

    await handle.done;

    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as { name: string; data: Record<string, unknown> };
    expect(call.name).toBe("session/completed");
    expect(call.data.sessionId).toBe("my-session-xyz");
  });

  // BUG PROBE: Verify mocks do NOT contaminate across tests.
  // The beforeEach calls vi.clearAllMocks(), but if that didn't work, a previous
  // test's calls would bleed into this one.
  test("mock state is clean at start (no calls from prior tests)", async () => {
    // Do NOT run any spawnSession. The mock should be clean from vi.clearAllMocks().
    const sendMock = vi.mocked(inngest.send);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
