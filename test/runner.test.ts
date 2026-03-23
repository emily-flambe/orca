import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnSession,
  invocationLogs,
  resolveClaudeBinary,
} from "../src/runner/index.js";
import { spawnShellCommand, activeShellHandles } from "../src/runner/shell.js";

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
// 6. MCP config per-session
// ---------------------------------------------------------------------------

describe("MCP config per-session", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("--mcp-config and --strict-mcp-config appear in args when mcpServers is set", async () => {
    const script = join(tmpDir, "argv-mcp.js");
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
      mcpServers: {
        myServer: { type: "http", url: "http://localhost:9000" },
      },
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("--strict-mcp-config");
  });

  test("mcp config file is written with correct JSON content before session runs", async () => {
    const script = join(tmpDir, "argv-mcp-content.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const mcpServers = {
      myHttpServer: {
        type: "http" as const,
        url: "http://localhost:9000",
        headers: { Authorization: "Bearer token123" },
      },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    // Check the file exists on disk before the session completes
    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    // The file should exist immediately after spawnSession returns (before done)
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(expectedMcpPath)).toBe(true);

    const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));
    expect(fileContent).toEqual({ mcpServers });

    await handle.done;
  });

  test("mcp config file is deleted after session ends", async () => {
    const script = join(tmpDir, "argv-mcp-cleanup.js");
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
      mcpServers: {
        myServer: { type: "http", url: "http://localhost:9000" },
      },
    });

    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);

    await handle.done;

    const { existsSync } = await import("node:fs");
    expect(existsSync(expectedMcpPath)).toBe(false);
  });

  test("no --mcp-config in args when mcpServers is not provided", async () => {
    const script = join(tmpDir, "argv-no-mcp.js");
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
      // No mcpServers
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--strict-mcp-config");

    // Verify no mcp file was written
    const unexpectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    const { existsSync } = await import("node:fs");
    expect(existsSync(unexpectedMcpPath)).toBe(false);
  });

  test("no --mcp-config in args when mcpServers is an empty object", async () => {
    const script = join(tmpDir, "argv-empty-mcp.js");
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
      mcpServers: {}, // empty object — should NOT trigger mcp config
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--strict-mcp-config");

    // Verify no mcp file was written
    const unexpectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    const { existsSync } = await import("node:fs");
    expect(existsSync(unexpectedMcpPath)).toBe(false);
  });

  test("--mcp-config path arg references a file in logs dir with -mcp.json suffix", async () => {
    const script = join(tmpDir, "argv-mcp-path.js");
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
      mcpServers: {
        myServer: { type: "http", url: "http://localhost:9000" },
      },
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);
    const mcpIdx = argv.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    const mcpPath = argv[mcpIdx + 1];
    expect(mcpPath).toMatch(/-mcp\.json$/);
    expect(mcpPath).toContain(String(id));
    // Should be inside the logs dir of the project root
    expect(mcpPath).toContain("logs");
  });

  test("stdio-type mcp server config is written correctly", async () => {
    const script = join(tmpDir, "argv-mcp-stdio.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const mcpServers = {
      myStdioServer: {
        command: "npx",
        args: ["@modelcontextprotocol/server-everything"],
        env: { MY_ENV: "value" },
      },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(expectedMcpPath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));
    expect(fileContent).toEqual({ mcpServers });

    await handle.done;
  });

  test("multiple mcp servers are all written to the config file", async () => {
    const script = join(tmpDir, "argv-mcp-multi.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    const id = nextInvocationId();
    const mcpServers = {
      server1: { type: "http" as const, url: "http://localhost:9001" },
      server2: { command: "npx", args: ["some-mcp-server"] },
      server3: {
        type: "http" as const,
        url: "http://localhost:9003",
        headers: { "X-Api-Key": "abc" },
      },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(expectedMcpPath)).toBe(true);
    const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));
    expect(Object.keys(fileContent.mcpServers)).toHaveLength(3);
    expect(fileContent.mcpServers).toEqual(mcpServers);

    await handle.done;
  });

  test("env var references in http url are expanded before writing config", async () => {
    const script = join(tmpDir, "argv-mcp-envvar-url.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    process.env["ORCA_TEST_MCP_PORT"] = "9876";
    try {
      const id = nextInvocationId();
      const handle = spawnSession({
        agentPrompt: "test",
        worktreePath: tmpDir,
        maxTurns: 5,
        invocationId: id,
        projectRoot: tmpDir,
        claudePath: process.execPath,
        claudeArgs: [script],
        mcpServers: {
          myServer: {
            type: "http",
            url: "http://localhost:${ORCA_TEST_MCP_PORT}/mcp",
            headers: { Authorization: "Bearer $ORCA_TEST_MCP_PORT" },
          },
        },
      });

      const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
      const { readFileSync } = await import("node:fs");
      const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));

      expect(fileContent.mcpServers.myServer.url).toBe(
        "http://localhost:9876/mcp",
      );
      expect(fileContent.mcpServers.myServer.headers.Authorization).toBe(
        "Bearer 9876",
      );

      await handle.done;
    } finally {
      delete process.env["ORCA_TEST_MCP_PORT"];
    }
  });

  test("env var references in stdio env values are expanded before writing config", async () => {
    const script = join(tmpDir, "argv-mcp-envvar-stdio.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    process.env["ORCA_TEST_MCP_SECRET"] = "supersecret";
    try {
      const id = nextInvocationId();
      const handle = spawnSession({
        agentPrompt: "test",
        worktreePath: tmpDir,
        maxTurns: 5,
        invocationId: id,
        projectRoot: tmpDir,
        claudePath: process.execPath,
        claudeArgs: [script],
        mcpServers: {
          myStdioServer: {
            command: "npx",
            args: ["some-server"],
            env: { API_KEY: "$ORCA_TEST_MCP_SECRET" },
          },
        },
      });

      const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
      const { readFileSync } = await import("node:fs");
      const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));

      expect(fileContent.mcpServers.myStdioServer.env.API_KEY).toBe(
        "supersecret",
      );

      await handle.done;
    } finally {
      delete process.env["ORCA_TEST_MCP_SECRET"];
    }
  });

  test("unset env var references expand to empty string", async () => {
    const script = join(tmpDir, "argv-mcp-envvar-unset.js");
    writeFileSync(
      script,
      makeScript([
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ]),
    );

    // Ensure the var is not set
    delete process.env["ORCA_TEST_MCP_UNSET_VAR"];

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: {
        myServer: {
          type: "http",
          url: "http://localhost:${ORCA_TEST_MCP_UNSET_VAR}/mcp",
        },
      },
    });

    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);
    const { readFileSync } = await import("node:fs");
    const fileContent = JSON.parse(readFileSync(expectedMcpPath, "utf8"));

    expect(fileContent.mcpServers.myServer.url).toBe("http://localhost:/mcp");

    await handle.done;
  });
});

// ---------------------------------------------------------------------------
// 7. shell.ts spawnShellCommand
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
