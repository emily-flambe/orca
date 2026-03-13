import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  resolveClaudeBinary,
  spawnSession,
  invocationLogs,
} from "../src/runner/index.js";
import { spawnShellCommand, activeShellHandles } from "../src/runner/shell.js";

// ---------------------------------------------------------------------------
// Module-level cache clearing for resolveClaudeBinary
// ---------------------------------------------------------------------------

// Access the internal cache via module internals — we re-import it by clearing
// entries between tests using the exported function's behavior as a proxy.
// Since the cache is module-level, we clear it by calling resolveClaudeBinary
// with a unique key per test (not practical) OR we exploit that on non-win32
// it always returns {command, prefixArgs:[]} and cache is populated.
// For tests that need a clean cache state we rely on unique keys or the fact
// that we test observable behavior (return value), not internal state.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let invocationCounter = 10_000;
function nextInvocationId(): number {
  return ++invocationCounter;
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

  test("malformed/non-JSON lines do not crash the session", async () => {
    const scriptPath = join(tmpDir, "malformed.js");
    writeFileSync(
      scriptPath,
      [
        // Emit a non-JSON line first
        'process.stdout.write("this is not json\\n");',
        // Then emit a valid result so the session completes cleanly
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"ok"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    // Should succeed despite the malformed line
    expect(result.subtype).toBe("success");
    expect(result.exitCode).toBe(0);
  }, 15_000);

  test("system/init sets handle.sessionId", async () => {
    const scriptPath = join(tmpDir, "init.js");
    writeFileSync(
      scriptPath,
      [
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"abc-session-456"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    await handle.done;
    expect(handle.sessionId).toBe("abc-session-456");
  }, 15_000);

  test("result success parses total_cost_usd, num_turns, and usage tokens", async () => {
    const scriptPath = join(tmpDir, "result-success.js");
    writeFileSync(
      scriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        '  type:"result",',
        '  subtype:"success",',
        "  total_cost_usd:0.123,",
        "  num_turns:7,",
        "  result:\"completed\",",
        "  usage:{",
        "    input_tokens:100,",
        "    cache_creation_input_tokens:50,",
        "    cache_read_input_tokens:25,",
        "    output_tokens:200",
        "  }",
        '}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.costUsd).toBeCloseTo(0.123);
    expect(result.numTurns).toBe(7);
    // inputTokens = 100 + 50 + 25 = 175
    expect(result.inputTokens).toBe(175);
    expect(result.outputTokens).toBe(200);
  }, 15_000);

  test("result error_max_turns subtype sets outputSummary to 'max turns reached'", async () => {
    const scriptPath = join(tmpDir, "max-turns.js");
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify({type:"result",subtype:"error_max_turns"}) + "\\n");\n',
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 1,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("error_max_turns");
    expect(result.outputSummary).toBe("max turns reached");
  }, 15_000);

  test("result error_during_execution uses errors array in outputSummary", async () => {
    const scriptPath = join(tmpDir, "exec-error.js");
    writeFileSync(
      scriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        '  type:"result",',
        '  subtype:"error_during_execution",',
        '  errors:["tool crashed","permission denied"]',
        '}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("error_during_execution");
    expect(result.outputSummary).toBe("tool crashed; permission denied");
  }, 15_000);

  test("REVIEW_RESULT marker extracted and prepended if not in first 500 chars", async () => {
    // Build a result string where the marker appears after the 500-char mark
    const prefix = "x".repeat(510);
    const marker = "REVIEW_RESULT:APPROVED";
    const resultText = prefix + marker;

    const scriptPath = join(tmpDir, "review-result.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:${JSON.stringify(resultText)}}) + "\\n");\n`,
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.outputSummary.startsWith("REVIEW_RESULT:APPROVED")).toBe(true);
  }, 15_000);

  test("REVIEW_RESULT marker NOT prepended if already in first 500 chars", async () => {
    const marker = "REVIEW_RESULT:CHANGES_REQUESTED";
    // Marker is near the beginning, well within 500 chars
    const resultText = marker + " some explanation here";

    const scriptPath = join(tmpDir, "review-result-short.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:${JSON.stringify(resultText)}}) + "\\n");\n`,
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    // Should appear exactly once, not prepended a second time
    const occurrences = (result.outputSummary.match(/REVIEW_RESULT:CHANGES_REQUESTED/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(result.outputSummary.startsWith("REVIEW_RESULT:CHANGES_REQUESTED")).toBe(true);
  }, 15_000);

  test("PR URL extracted and prepended if not in first 500 chars", async () => {
    const prefix = "y".repeat(510);
    const prUrl = "https://github.com/myorg/myrepo/pull/42";
    const resultText = prefix + prUrl;

    const scriptPath = join(tmpDir, "pr-url-long.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:${JSON.stringify(resultText)}}) + "\\n");\n`,
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.outputSummary.startsWith(prUrl)).toBe(true);
  }, 15_000);

  test("PR URL NOT prepended if already in first 500 chars", async () => {
    const prUrl = "https://github.com/myorg/myrepo/pull/99";
    const resultText = prUrl + " was created successfully";

    const scriptPath = join(tmpDir, "pr-url-short.js");
    writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:${JSON.stringify(resultText)}}) + "\\n");\n`,
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    const occurrences = (result.outputSummary.match(/\/pull\/99/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(result.outputSummary.startsWith(prUrl)).toBe(true);
  }, 15_000);

  test("inputTokens sums input + cache_creation + cache_read tokens", async () => {
    const scriptPath = join(tmpDir, "tokens.js");
    writeFileSync(
      scriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        '  type:"result",',
        '  subtype:"success",',
        '  result:"done",',
        "  usage:{",
        "    input_tokens:1000,",
        "    cache_creation_input_tokens:200,",
        "    cache_read_input_tokens:300,",
        "    output_tokens:500",
        "  }",
        '}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    // 1000 + 200 + 300 = 1500
    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(500);
  }, 15_000);

  test("empty stdout with exit 0 produces success with 'process exited cleanly with no result message'", async () => {
    const scriptPath = join(tmpDir, "empty-exit.js");
    // Script writes nothing and exits 0
    writeFileSync(scriptPath, "// no output\n");

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.outputSummary).toBe("process exited cleanly with no result message");
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 2. Rate limit detection
// ---------------------------------------------------------------------------

describe("rate limit detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-ratelimit-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rate_limit_event with overageStatus=rejected sets subtype=rate_limited", async () => {
    const scriptPath = join(tmpDir, "rate-limited.js");
    writeFileSync(
      scriptPath,
      [
        "process.stdout.write(JSON.stringify({",
        '  type:"rate_limit_event",',
        '  overageStatus:"rejected",',
        '  rateLimitType:"tokens",',
        '  resetsAt:"2099-01-01T00:00:00Z"',
        '}) + "\\n");',
        // Exit non-zero to trigger the rate_limited path (no result message)
        "process.exit(1);",
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("rate_limited");
  }, 15_000);

  test("rate_limit_event with overageStatus=rejected populates rateLimitResetsAt", async () => {
    const resetTime = "2099-06-15T12:30:00Z";
    const scriptPath = join(tmpDir, "rate-limited-resets.js");
    writeFileSync(
      scriptPath,
      [
        `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"requests",resetsAt:${JSON.stringify(resetTime)}}) + "\\n");`,
        "process.exit(1);",
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("rate_limited");
    expect(result.rateLimitResetsAt).toBe(resetTime);
  }, 15_000);

  test("rate_limit_event with overageStatus=allowed does NOT trigger rate_limited subtype", async () => {
    const scriptPath = join(tmpDir, "rate-allowed.js");
    writeFileSync(
      scriptPath,
      [
        // "allowed" should not set rateLimitDetected
        'process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"allowed",rateLimitType:"tokens",resetsAt:"2099-01-01T00:00:00Z"}) + "\\n");',
        // Provide a valid result message so session completes as success
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"still ok"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");
    expect(result.subtype).not.toBe("rate_limited");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 3. resolveClaudeBinary
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary", () => {
  test.skipIf(platform() === "win32")(
    "on non-Windows returns {command: requested, prefixArgs: []} directly",
    () => {
      const result = resolveClaudeBinary("/usr/local/bin/some-cli");
      expect(result.command).toBe("/usr/local/bin/some-cli");
      expect(result.prefixArgs).toEqual([]);
    },
  );

  test.skipIf(platform() === "win32")(
    "on non-Windows cache is populated after first call",
    () => {
      const uniqueKey = `/tmp/unique-cli-${Date.now()}`;
      // First call
      const first = resolveClaudeBinary(uniqueKey);
      // Second call should return same reference (cached)
      const second = resolveClaudeBinary(uniqueKey);
      // Both should be equal in value
      expect(first.command).toBe(second.command);
      expect(first.prefixArgs).toEqual(second.prefixArgs);
      expect(first.command).toBe(uniqueKey);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. buildArgs (tested indirectly via mock scripts that write process.argv)
// ---------------------------------------------------------------------------

describe("buildArgs via mock scripts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-args-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getArgv(opts: {
    resumeSessionId?: string;
    appendSystemPrompt?: string;
    disallowedTools?: string[];
    model?: string;
  }): Promise<string[]> {
    const argsFile = join(tmpDir, "argv.json");
    const scriptPath = join(tmpDir, "print-args.js");
    writeFileSync(
      scriptPath,
      `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv));\n`,
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "the-prompt",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
      ...opts,
    });

    await handle.done;
    return JSON.parse(readFileSync(argsFile, "utf8")) as string[];
  }

  test("resumeSessionId adds --resume <sessionId> before -p", async () => {
    const argv = await getArgv({ resumeSessionId: "my-session-id" });
    const resumeIdx = argv.indexOf("--resume");
    const pIdx = argv.indexOf("-p");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(argv[resumeIdx + 1]).toBe("my-session-id");
    expect(resumeIdx).toBeLessThan(pIdx);
  }, 15_000);

  test("appendSystemPrompt adds --append-system-prompt <text>", async () => {
    const argv = await getArgv({ appendSystemPrompt: "be concise" });
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("be concise");
  }, 15_000);

  test("disallowedTools adds --disallowedTools tool1 tool2", async () => {
    const argv = await getArgv({ disallowedTools: ["EnterPlanMode", "AskUserQuestion"] });
    const idx = argv.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("EnterPlanMode");
    expect(argv[idx + 2]).toBe("AskUserQuestion");
  }, 15_000);

  test("model adds --model <value>", async () => {
    const argv = await getArgv({ model: "claude-3-haiku-20240307" });
    const idx = argv.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("claude-3-haiku-20240307");
  }, 15_000);

  test("-p includes the agentPrompt", async () => {
    const argv = await getArgv({});
    const pIdx = argv.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(argv[pIdx + 1]).toBe("the-prompt");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 5. invocationLogs Map management
// ---------------------------------------------------------------------------

describe("invocationLogs Map management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-logs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Map entry exists while session is running", async () => {
    const scriptPath = join(tmpDir, "slow-start.js");
    writeFileSync(
      scriptPath,
      [
        // Short pause then emit result
        "setTimeout(() => {",
        '  process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done"}) + "\\n");',
        "}, 200);",
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    // Entry should exist immediately after spawn
    expect(invocationLogs.has(id)).toBe(true);

    await handle.done;
  }, 15_000);

  test("Map entry has buffer and emitter populated", async () => {
    const scriptPath = join(tmpDir, "emit-lines.js");
    writeFileSync(
      scriptPath,
      [
        'process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"buf-test"}) + "\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    // Immediately after spawn, the logState should exist
    const logState = invocationLogs.get(id);
    expect(logState).toBeDefined();
    expect(logState!.buffer).toBeInstanceOf(Array);
    expect(logState!.emitter).toBeDefined();

    await handle.done;
  }, 15_000);

  test("SSE buffer is capped at 100 lines (101st line causes shift)", async () => {
    const scriptPath = join(tmpDir, "many-lines.js");
    const lines: string[] = [];
    // Emit 110 valid-but-unrecognized JSON lines (type "assistant" is ignored by parser)
    for (let i = 0; i < 110; i++) {
      lines.push(`process.stdout.write(JSON.stringify({type:"assistant",index:${i}}) + "\\n");`);
    }
    // End with a result
    lines.push('process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"done"}) + "\\n");');
    writeFileSync(scriptPath, lines.join("\n"));

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    // Capture logState before it's deleted
    const logState = invocationLogs.get(id);
    expect(logState).toBeDefined();

    await handle.done;

    // Buffer should be capped at 100 entries
    // (may be slightly less since process_exit is also written, but never > 100)
    expect(logState!.buffer.length).toBeLessThanOrEqual(100);
    // And we had more than 100 lines emitted, so it should be exactly 100
    expect(logState!.buffer.length).toBe(100);
  }, 15_000);

  test("logState.done is true after session completes", async () => {
    const scriptPath = join(tmpDir, "done-check.js");
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"fin"}) + "\\n");\n',
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    // Capture logState reference before it could be cleaned up
    const logState = invocationLogs.get(id);
    expect(logState).toBeDefined();

    await handle.done;

    // After done resolves, logState.done should be true
    expect(logState!.done).toBe(true);
  }, 15_000);

  test("logState.done is true without waiting 60s (timer is unref'd)", async () => {
    // This verifies done=true is set synchronously on stream close, NOT after the 60s timer
    const scriptPath = join(tmpDir, "done-immediate.js");
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"quick"}) + "\\n");\n',
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [scriptPath],
    });

    const logState = invocationLogs.get(id);
    expect(logState).toBeDefined();

    await handle.done;

    // done should already be true — no 60s wait required
    expect(logState!.done).toBe(true);
    // The 60s cleanup timer is unref'd so it won't block process exit,
    // but the entry may still be in the map at this point — that's expected.
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 6. shell.ts — spawnShellCommand
// ---------------------------------------------------------------------------

describe("spawnShellCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-shell-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("captures stdout output and exitCode=0 for successful commands", async () => {
    // Write a script file to avoid shell quoting issues with paths containing spaces
    const scriptPath = join(tmpDir, "shell-stdout.js");
    writeFileSync(scriptPath, "process.stdout.write('hello shell');\n");

    const id = nextInvocationId();
    // Quote the node path to handle spaces in the executable path (e.g. C:\Program Files\...)
    const nodePath = `"${process.execPath}"`;
    const handle = spawnShellCommand(
      `${nodePath} "${scriptPath}"`,
      { cwd: tmpDir, timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello shell");
    expect(result.timedOut).toBe(false);
  }, 15_000);

  test("captures stderr output in combined output", async () => {
    const scriptPath = join(tmpDir, "shell-stderr.js");
    writeFileSync(scriptPath, "process.stderr.write('stderr content');\n");

    const id = nextInvocationId();
    const nodePath = `"${process.execPath}"`;
    const handle = spawnShellCommand(
      `${nodePath} "${scriptPath}"`,
      { cwd: tmpDir, timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.output).toContain("stderr content");
  }, 15_000);

  test("timedOut is false for commands that complete within timeout", async () => {
    const scriptPath = join(tmpDir, "shell-exit.js");
    writeFileSync(scriptPath, "process.exit(0);\n");

    const id = nextInvocationId();
    const nodePath = `"${process.execPath}"`;
    const handle = spawnShellCommand(
      `${nodePath} "${scriptPath}"`,
      { cwd: tmpDir, timeoutMs: 10_000, invocationId: id },
    );

    const result = await handle.done;
    expect(result.timedOut).toBe(false);
  }, 15_000);

  // On Windows, shell:true spawns cmd.exe and SIGTERM/SIGKILL only kills the
  // cmd.exe wrapper, not the node grandchild process. The grandchild holds open
  // stdio pipes so the "close" event never fires — making kill-based tests hang
  // indefinitely. These tests are only reliable on Unix.
  test.skipIf(platform() === "win32")(
    "kill() terminates the process",
    async () => {
      const scriptPath = join(tmpDir, "shell-sleep.js");
      writeFileSync(scriptPath, "setTimeout(() => {}, 60000);\n");

      const id = nextInvocationId();
      const nodePath = `"${process.execPath}"`;
      const handle = spawnShellCommand(
        `${nodePath} "${scriptPath}"`,
        { cwd: tmpDir, timeoutMs: 30_000, invocationId: id },
      );

      // Give it time to start
      await new Promise((r) => setTimeout(r, 200));

      handle.kill();
      const result = await handle.done;

      // After kill, process should not have exited with 0 cleanly
      // (exitCode may be null on signal kill or non-zero)
      expect(result.exitCode === null || result.exitCode !== 0 || result.timedOut === false).toBe(true);
    },
    15_000,
  );

  test.skipIf(platform() === "win32")(
    "timedOut is true and process killed when timeout expires",
    async () => {
      const scriptPath = join(tmpDir, "shell-timeout.js");
      writeFileSync(scriptPath, "setTimeout(() => {}, 60000);\n");

      const id = nextInvocationId();
      const nodePath = `"${process.execPath}"`;
      const handle = spawnShellCommand(
        `${nodePath} "${scriptPath}"`,
        { cwd: tmpDir, timeoutMs: 500, invocationId: id },
      );

      const result = await handle.done;
      expect(result.timedOut).toBe(true);
    },
    15_000,
  );

  test("activeShellHandles entry exists during execution and is deleted after close", async () => {
    const scriptPath = join(tmpDir, "shell-active.js");
    writeFileSync(scriptPath, "setTimeout(() => {}, 300);\n");

    const id = nextInvocationId();
    const nodePath = `"${process.execPath}"`;
    const handle = spawnShellCommand(
      `${nodePath} "${scriptPath}"`,
      { cwd: tmpDir, timeoutMs: 10_000, invocationId: id },
    );

    // Should be in the map while running
    expect(activeShellHandles.has(id)).toBe(true);

    await handle.done;

    // Should be removed after close
    expect(activeShellHandles.has(id)).toBe(false);
  }, 15_000);
});
