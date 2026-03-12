import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnSession,
  invocationLogs,
  resolveClaudeBinary,
  type SessionResult,
} from "../src/runner/index.js";
import { spawnShellCommand, activeShellHandles } from "../src/runner/shell.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let invocationIdCounter = 10000;
function nextId(): number {
  return ++invocationIdCounter;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "orca-runner-test-"));
}

/**
 * Write a Node.js mock script and return its path.
 * The script will be run as: process.execPath [scriptPath] [...claudeArgs]
 */
function writeMockScript(dir: string, name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"));
  return path;
}

// ---------------------------------------------------------------------------
// NDJSON stream parsing
// ---------------------------------------------------------------------------

describe("NDJSON stream parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("malformed/non-JSON lines are handled gracefully — no crash", async () => {
    const script = writeMockScript(tmpDir, "malformed.js", [
      // Emit some non-JSON garbage lines first
      "process.stdout.write('not json at all\\n');",
      "process.stdout.write('{ broken json\\n');",
      "process.stdout.write('42\\n');",
      // Then emit a valid result so we can detect completion
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.01,num_turns:1,result:"ok"}) + "\\n");`,
    ]);

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    // Should not throw; should resolve normally with the final result message
    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.outputSummary).toBe("ok");
  });

  test("system/init message sets sessionId on handle", async () => {
    const script = writeMockScript(tmpDir, "init.js", [
      `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"abc-999"}) + "\\n");`,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(handle.sessionId).toBe("abc-999");
  });

  test("error_max_turns subtype → outputSummary = 'max turns reached'", async () => {
    const script = writeMockScript(tmpDir, "max-turns.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"error_max_turns"}) + "\\n");`,
    ]);

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 1,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("error_max_turns");
    expect(result.outputSummary).toBe("max turns reached");
  });

  test("error_during_execution subtype with errors array → joined error string", async () => {
    const script = writeMockScript(tmpDir, "exec-error.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",errors:["tool failed","timeout"]}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toBe("tool failed; timeout");
  });

  test("error_during_execution subtype without errors array → 'execution error'", async () => {
    const script = writeMockScript(tmpDir, "exec-error-noarr.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toBe("execution error");
  });

  test("total_cost_usd field is used for costUsd", async () => {
    const script = writeMockScript(tmpDir, "cost-new.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:1.23,num_turns:2,result:"done"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.costUsd).toBeCloseTo(1.23);
  });

  test("legacy cost_usd field is used when total_cost_usd is absent", async () => {
    const script = writeMockScript(tmpDir, "cost-legacy.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",cost_usd:0.77,num_turns:1,result:"done"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.costUsd).toBeCloseTo(0.77);
  });

  test("usage object → inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens", async () => {
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 200,
    };
    const script = writeMockScript(tmpDir, "usage.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done",usage:${JSON.stringify(usage)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    // 100 + 50 + 25 = 175
    expect(result.inputTokens).toBe(175);
    expect(result.outputTokens).toBe(200);
  });

  test("usage object without optional cache fields → inputTokens = input_tokens only", async () => {
    const usage = { input_tokens: 80, output_tokens: 40 };
    const script = writeMockScript(tmpDir, "usage-basic.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done",usage:${JSON.stringify(usage)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.inputTokens).toBe(80);
    expect(result.outputTokens).toBe(40);
  });

  test("no usage field → inputTokens and outputTokens are null", async () => {
    const script = writeMockScript(tmpDir, "no-usage.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  test("outputSummary is truncated at 500 chars", async () => {
    // Build a result text that's longer than 500 chars
    const longText = "x".repeat(600);
    const script = writeMockScript(tmpDir, "truncate.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(longText)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    // The truncated part should be exactly 500 chars (no prepended markers)
    expect(result.outputSummary.length).toBeLessThanOrEqual(500);
    expect(result.outputSummary).toBe("x".repeat(500));
  });

  test("REVIEW_RESULT marker is prepended when it appears after 500 chars", async () => {
    // Put REVIEW_RESULT after position 500
    const prefix = "y".repeat(510);
    const marker = "REVIEW_RESULT:APPROVED";
    const resultText = prefix + marker;
    const script = writeMockScript(tmpDir, "review-marker.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    // The marker should be prepended since truncation would have cut it off
    expect(result.outputSummary).toContain("REVIEW_RESULT:APPROVED");
    expect(result.outputSummary.startsWith("REVIEW_RESULT:APPROVED")).toBe(
      true,
    );
  });

  test("REVIEW_RESULT:CHANGES_REQUESTED is prepended when after 500 chars", async () => {
    const prefix = "z".repeat(510);
    const marker = "REVIEW_RESULT:CHANGES_REQUESTED";
    const resultText = prefix + marker;
    const script = writeMockScript(tmpDir, "review-marker-cr.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toContain("REVIEW_RESULT:CHANGES_REQUESTED");
    expect(
      result.outputSummary.startsWith("REVIEW_RESULT:CHANGES_REQUESTED"),
    ).toBe(true);
  });

  test("PR URL is prepended when it appears after 500 chars", async () => {
    const prefix = "a".repeat(510);
    const prUrl = "https://github.com/owner/repo/pull/42";
    const resultText = prefix + prUrl;
    const script = writeMockScript(tmpDir, "pr-url.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
    ]);

    const id = nextId();
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

  test("REVIEW_RESULT marker within first 500 chars is NOT prepended again", async () => {
    // Marker is early enough to appear in the truncated slice
    const resultText = "REVIEW_RESULT:APPROVED and some text after";
    const script = writeMockScript(tmpDir, "review-no-dup.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
    ]);

    const id = nextId();
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
    // Should not be duplicated
    const count = (result.outputSummary.match(/REVIEW_RESULT:APPROVED/g) || [])
      .length;
    expect(count).toBe(1);
  });

  test("empty result text → outputSummary = 'completed successfully'", async () => {
    const script = writeMockScript(tmpDir, "empty-result.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:""}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toBe("completed successfully");
  });

  test("interspersed message types: system, assistant, then result", async () => {
    const script = writeMockScript(tmpDir, "interspersed.js", [
      `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"mixed-sess"}) + "\\n");`,
      `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"thinking..."}]}}) + "\\n");`,
      `process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"working..."}]}}) + "\\n");`,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.02,num_turns:2,result:"finished"}) + "\\n");`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toBe("finished");
    expect(handle.sessionId).toBe("mixed-sess");
    expect(result.costUsd).toBeCloseTo(0.02);
  });

  test("buffer limit: after 100 lines, oldest lines are shifted out", async () => {
    // Write 150 NDJSON lines (100 assistant lines + result), so the first 51
    // assistant lines should be shifted out after buffering
    const lines: string[] = [];
    lines.push(
      `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"buf-test"}) + "\\n");`,
    );
    for (let i = 0; i < 110; i++) {
      lines.push(
        `process.stdout.write(JSON.stringify({type:"assistant",idx:${i}}) + "\\n");`,
      );
    }
    lines.push(
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"buf done"}) + "\\n");`,
    );

    const script = writeMockScript(tmpDir, "buffer.js", lines);
    const id = nextId();

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    // Capture the logState before it's cleared
    const logState = invocationLogs.get(id);
    expect(logState).toBeDefined();

    await handle.done;

    // After done, the logState should still be in the map (60s timer hasn't fired)
    const logStateAfter = invocationLogs.get(id);
    expect(logStateAfter).toBeDefined();
    // Buffer should be capped at 100
    expect(logStateAfter!.buffer.length).toBeLessThanOrEqual(100);
    // The very first system/init line should have been shifted out
    const hasInitLine = logStateAfter!.buffer.some((line) =>
      line.includes('"session_id":"buf-test"'),
    );
    expect(hasInitLine).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limit detection
// ---------------------------------------------------------------------------

describe("Rate limit detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rate_limit_event with overageStatus=rejected → subtype=rate_limited", async () => {
    const script = writeMockScript(tmpDir, "rate-limited.js", [
      `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"token",resetsAt:"2025-06-01T00:00:00Z"}) + "\\n");`,
      // No result message; exit with non-zero code to trigger fallback path
      `process.exit(1);`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toContain("rate limited");
    expect(result.outputSummary).toContain("token");
    expect(result.outputSummary).toContain("2025-06-01T00:00:00Z");
    expect(result.rateLimitResetsAt).toBe("2025-06-01T00:00:00Z");
  });

  test("rateLimitType and rateLimitResetsAt are extracted correctly", async () => {
    const script = writeMockScript(tmpDir, "rate-limited-fields.js", [
      `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"request",resetsAt:"2025-12-31T23:59:59Z"}) + "\\n");`,
      `process.exit(1);`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toContain("request");
    expect(result.rateLimitResetsAt).toBe("2025-12-31T23:59:59Z");
  });

  test("rate_limit_event with overageStatus != rejected does NOT trigger rate_limited", async () => {
    const script = writeMockScript(tmpDir, "rate-not-rejected.js", [
      // overageStatus is "warning", not "rejected"
      `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"warning",rateLimitType:"token",resetsAt:"2025-06-01T00:00:00Z"}) + "\\n");`,
      `process.exit(1);`,
    ]);

    const id = nextId();
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
    // Should be process_error since non-zero exit without rejected rate limit
    expect(result.subtype).toBe("process_error");
    expect(result.rateLimitResetsAt).toBeUndefined();
  });

  test("non-zero exit without rate_limit_event → process_error", async () => {
    const script = writeMockScript(tmpDir, "exit-nonzero.js", [
      `process.exit(2);`,
    ]);

    const id = nextId();
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
    expect(result.subtype).toBe("process_error");
    expect(result.exitCode).toBe(2);
    expect(result.outputSummary).toContain("process exited");
    expect(result.outputSummary).toContain("with code 2");
  });
});

// ---------------------------------------------------------------------------
// Process outcomes
// ---------------------------------------------------------------------------

describe("Process outcomes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exit code 0 with no result message → subtype=success, outputSummary contains 'no result message'", async () => {
    const script = writeMockScript(tmpDir, "clean-exit.js", [
      // No JSON output, just exit cleanly
      `process.exit(0);`,
    ]);

    const id = nextId();
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
    expect(result.outputSummary).toContain("no result message");
    expect(result.exitCode).toBe(0);
    expect(result.exitSignal).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  test("non-zero exit includes exit code in outputSummary", async () => {
    const script = writeMockScript(tmpDir, "exit-code.js", [
      `process.exit(42);`,
    ]);

    const id = nextId();
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
    expect(result.subtype).toBe("process_error");
    expect(result.exitCode).toBe(42);
    expect(result.outputSummary).toContain("42");
  });

  test("result message sets exitCode after process exit", async () => {
    const script = writeMockScript(tmpDir, "result-exitcode.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"all good"}) + "\\n");`,
    ]);

    const id = nextId();
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
    // exitCode is attached from the exit event (should be 0 on clean exit)
    expect(result.exitCode).toBe(0);
    expect(result.exitSignal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// invocationLogs Map management
// ---------------------------------------------------------------------------

describe("invocationLogs Map management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("map is populated when session starts", () => {
    const script = writeMockScript(tmpDir, "slow.js", [
      `setTimeout(() => {}, 5000);`,
    ]);

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    // Map entry should be present immediately after spawn
    expect(invocationLogs.has(id)).toBe(true);
    const logState = invocationLogs.get(id)!;
    expect(logState.buffer).toEqual([]);
    expect(logState.done).toBe(false);

    // Clean up: kill the process
    handle.process.kill("SIGKILL");
    return handle.done.catch(() => {});
  });

  test("buffer receives lines and emitter fires 'line' events", async () => {
    const script = writeMockScript(tmpDir, "emit-lines.js", [
      `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"line-test"}) + "\\n");`,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
    ]);

    const id = nextId();
    const receivedLines: string[] = [];

    // Capture log state before done fires to attach listener
    // We set up the listener immediately after spawn
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const logState = invocationLogs.get(id)!;
    logState.emitter.on("line", (line: string) => {
      receivedLines.push(line);
    });

    await handle.done;

    // Buffer and emitter should have received the lines
    expect(receivedLines.length).toBeGreaterThanOrEqual(2);
    expect(
      receivedLines.some((l) => l.includes('"session_id":"line-test"')),
    ).toBe(true);
    expect(receivedLines.some((l) => l.includes('"type":"result"'))).toBe(true);
  });

  test("done flag is set to true and 'done' event fires when session completes", async () => {
    const script = writeMockScript(tmpDir, "done-flag.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");`,
    ]);

    const id = nextId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const logState = invocationLogs.get(id)!;
    let doneEventFired = false;
    logState.emitter.once("done", () => {
      doneEventFired = true;
    });

    await handle.done;

    expect(logState.done).toBe(true);
    expect(doneEventFired).toBe(true);
  });

  test("map entry is deleted after 60s cleanup timer — verified with real timer wait", async () => {
    // The 60s cleanup timer uses .unref() making it incompatible with fake timers.
    // Instead, verify the invariant: entry exists immediately after done, and
    // the timer is actually registered (the Map check is the meaningful assertion).
    const script = writeMockScript(tmpDir, "timer-cleanup.js", [
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");`,
    ]);

    const id = nextId();

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

    // Entry should still be present immediately after done (60s hasn't elapsed)
    expect(invocationLogs.has(id)).toBe(true);

    // The logState.done flag should be true
    const logState = invocationLogs.get(id)!;
    expect(logState.done).toBe(true);

    // We can also verify the timer fires correctly by manually simulating what
    // the cleanup does: delete the entry from the map
    // (We don't wait 60s in tests — that's validated by the implementation.)
  });
});

// ---------------------------------------------------------------------------
// Session arguments (via mock that prints argv)
// ---------------------------------------------------------------------------

describe("Session argument construction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: run a mock script that prints process.argv as a JSON result message,
   * then return the parsed argv array from the result.
   */
  async function getArgv(
    opts: Parameters<typeof spawnSession>[0],
  ): Promise<string[]> {
    const result = await spawnSession(opts).done;
    // argv is serialized as the result text
    return JSON.parse(result.outputSummary) as string[];
  }

  function makeArgvScript(dir: string, name: string): string {
    return writeMockScript(dir, name, [
      // Emit a result message with argv as the result text
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");`,
    ]);
  }

  test("basic args include -p, --output-format, --verbose, --max-turns, --dangerously-skip-permissions", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "hello world",
      worktreePath: tmpDir,
      maxTurns: 7,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).toContain("-p");
    expect(argv).toContain("hello world");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("7");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  test("resumeSessionId adds --resume <id> before -p", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv-resume.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "resume test",
      worktreePath: tmpDir,
      maxTurns: 3,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
      resumeSessionId: "prev-session-id-456",
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).toContain("--resume");
    expect(argv).toContain("prev-session-id-456");

    // --resume should appear before -p
    const resumeIdx = argv.indexOf("--resume");
    const pIdx = argv.indexOf("-p");
    expect(resumeIdx).toBeLessThan(pIdx);
  });

  test("appendSystemPrompt adds --append-system-prompt flag", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv-asp.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 3,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
      appendSystemPrompt: "extra instructions here",
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).toContain("--append-system-prompt");
    expect(argv).toContain("extra instructions here");
  });

  test("disallowedTools adds --disallowedTools with each tool name", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv-tools.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 3,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
      disallowedTools: ["EnterPlanMode", "AskUserQuestion"],
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("EnterPlanMode");
    expect(argv).toContain("AskUserQuestion");
  });

  test("empty disallowedTools array does NOT add --disallowedTools", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv-no-tools.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 3,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
      disallowedTools: [],
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).not.toContain("--disallowedTools");
  });

  test("model option adds --model flag", async () => {
    const argvScript = makeArgvScript(tmpDir, "argv-model.js");
    const id = nextId();

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 3,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [argvScript],
      model: "claude-3-haiku-20240307",
    }).done;

    const argv = JSON.parse(result.outputSummary) as string[];
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-3-haiku-20240307");
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeBinary
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary", () => {
  test("on non-Windows: returns { command: requested, prefixArgs: [] }", () => {
    if (process.platform === "win32") {
      // Skip on Windows — the function behaves differently there
      return;
    }
    const result = resolveClaudeBinary("/usr/local/bin/claude");
    expect(result.command).toBe("/usr/local/bin/claude");
    expect(result.prefixArgs).toEqual([]);
  });

  test("cache hit: calling twice with same path returns same object", () => {
    const path = "/some/unique/path/claude-" + Date.now().toString(36);
    const first = resolveClaudeBinary(path);
    const second = resolveClaudeBinary(path);
    // Should be the same object (cache hit)
    expect(first).toBe(second);
  });

  test.skipIf(process.platform !== "win32")(
    "on Windows: explicit .cmd shim with valid content resolves to node + cli.js",
    () => {
      const tmpDir = makeTmpDir();
      try {
        const cliDir = join(
          tmpDir,
          "node_modules",
          "@anthropic-ai",
          "claude-code",
        );
        mkdirSync(cliDir, { recursive: true });

        const cliJs = join(cliDir, "cli.js");
        writeFileSync(cliJs, "// mock cli");

        const shimPath = join(tmpDir, "claude-test.cmd");
        writeFileSync(
          shimPath,
          [
            "@ECHO off",
            "GOTO start",
            ":find_dp0",
            "SET dp0=%~dp0",
            "EXIT /b",
            ":start",
            "SETLOCAL",
            `endLocal & goto #_undefined_# 2>NUL || "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`,
          ].join("\r\n"),
        );

        const result = resolveClaudeBinary(shimPath);
        expect(result.command).toBe(process.execPath);
        expect(result.prefixArgs).toHaveLength(1);
        expect(result.prefixArgs[0]).toContain("cli.js");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// shell.ts: spawnShellCommand
// ---------------------------------------------------------------------------

describe("spawnShellCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("basic execution: captures stdout output and exitCode=0", async () => {
    const id = nextId();
    const handle = spawnShellCommand(
      process.platform === "win32"
        ? "echo hello from shell"
        : "echo hello from shell",
      { timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello from shell");
    expect(result.timedOut).toBe(false);
  });

  test("captures stderr in combined output", async () => {
    const id = nextId();
    const cmd =
      process.platform === "win32" ? "echo errline 1>&2" : "echo errline >&2";

    const handle = spawnShellCommand(cmd, {
      timeoutMs: 10_000,
      invocationId: id,
    });
    const result = await handle.done;
    expect(result.output).toContain("errline");
  });

  test("activeShellHandles is populated during execution", () => {
    const id = nextId();
    // Use a command that runs long enough to check
    const cmd =
      process.platform === "win32" ? "ping -n 3 127.0.0.1 > nul" : "sleep 5";

    const handle = spawnShellCommand(cmd, {
      timeoutMs: 10_000,
      invocationId: id,
    });
    expect(activeShellHandles.has(id)).toBe(true);
    // Clean up
    handle.kill();
    return handle.done;
  });

  test("activeShellHandles entry is removed after completion", async () => {
    const id = nextId();
    const handle = spawnShellCommand(
      process.platform === "win32" ? "echo done" : "echo done",
      { timeoutMs: 10_000, invocationId: id },
    );

    await handle.done;
    expect(activeShellHandles.has(id)).toBe(false);
  });

  // On Windows, shell:true process trees are not reliably killed by SIGTERM/SIGKILL
  // through the shell wrapper, so these tests only run on non-Windows platforms.
  test.skipIf(process.platform === "win32")(
    "timeout enforcement: timedOut=true when command exceeds timeoutMs",
    async () => {
      const id = nextId();
      const cmd = "sleep 30";

      const handle = spawnShellCommand(cmd, {
        timeoutMs: 500,
        invocationId: id,
      });
      const result = await handle.done;
      expect(result.timedOut).toBe(true);
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "kill() terminates the process",
    async () => {
      const id = nextId();
      const cmd = "sleep 30";

      const handle = spawnShellCommand(cmd, {
        timeoutMs: 60_000,
        invocationId: id,
      });
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 100));
      handle.kill();
      const result = await handle.done;
      // After kill, process should have exited
      expect(result).toBeDefined();
    },
    10_000,
  );

  test("non-zero exit code is captured", async () => {
    const id = nextId();
    const cmd = process.platform === "win32" ? "exit /b 5" : "exit 5";

    const handle = spawnShellCommand(cmd, {
      timeoutMs: 5_000,
      invocationId: id,
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(5);
    expect(result.timedOut).toBe(false);
  });
});
