import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  spawnSession,
  resolveClaudeBinary,
  invocationLogs,
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

// ---------------------------------------------------------------------------
// 1. NDJSON stream parsing edge cases
// ---------------------------------------------------------------------------

describe("NDJSON stream parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("malformed JSON line is ignored — no crash, warning written to stderr", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-malformed.js");
    writeFileSync(
      script,
      [
        // Emit an unparseable line followed by a valid result
        `process.stdout.write("this is not json\\n");`,
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");`,
      ].join("\n"),
    );

    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error overriding for spy
    process.stderr.write = (chunk: string | Buffer) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return origWrite(chunk);
    };

    let result;
    try {
      const handle = spawnSession({
        agentPrompt: "test",
        worktreePath: tmpDir,
        maxTurns: 10,
        invocationId: id,
        projectRoot: tmpDir,
        claudePath: process.execPath,
        claudeArgs: [script],
      });
      result = await handle.done;
    } finally {
      // @ts-expect-error restore
      process.stderr.write = origWrite;
    }

    // Should not crash; result should be the valid message
    expect(result.subtype).toBe("success");
    // Warning about non-JSON line should appear in stderr
    const hasWarning = stderrLines.some((l) => l.includes("non-JSON line"));
    expect(hasWarning).toBe(true);
  });

  test("rate_limit_event with overageStatus 'rejected' sets rate_limited subtype on non-zero exit", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-ratelimit.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"rejected",rateLimitType:"token",resetsAt:"2099-01-01T00:00:00Z"}) + "\\n");`,
        // Exit non-zero so the rate_limit branch is taken (no result message)
        `process.exit(1);`,
      ].join("\n"),
    );

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
    expect(result.subtype).toBe("rate_limited");
    expect(result.rateLimitResetsAt).toBe("2099-01-01T00:00:00Z");
    expect(result.outputSummary).toContain("rate limited");
  });

  test("rate_limit_event with overageStatus !== 'rejected' does NOT set rate_limited", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-ratelimit-allowed.js");
    writeFileSync(
      script,
      [
        // overageStatus is "allowed" — should not trigger rate_limited subtype
        `process.stdout.write(JSON.stringify({type:"rate_limit_event",overageStatus:"allowed",rateLimitType:"token",resetsAt:"2099-01-01T00:00:00Z"}) + "\\n");`,
        `process.exit(1);`,
      ].join("\n"),
    );

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
    expect(result.subtype).toBe("process_error");
    expect(result.subtype).not.toBe("rate_limited");
  });

  test("result message with error_max_turns subtype produces 'max turns reached' summary", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-maxturn.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"error_max_turns",total_cost_usd:0.01,num_turns:10}) + "\\n");`,
      ].join("\n"),
    );

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

  test("result message with error_during_execution extracts errors array into outputSummary", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-execerr.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",errors:["tool failed","timeout"]}) + "\\n");`,
      ].join("\n"),
    );

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
    expect(result.subtype).toBe("error_during_execution");
    expect(result.outputSummary).toBe("tool failed; timeout");
  });

  test("total_cost_usd is preferred over cost_usd fallback", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-cost-prefer.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0.99,cost_usd:0.01,num_turns:1,result:"done"}) + "\\n");`,
      ].join("\n"),
    );

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
    expect(result.costUsd).toBe(0.99);
  });

  test("cost_usd fallback works when total_cost_usd is absent", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-cost-fallback.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",cost_usd:0.42,num_turns:1,result:"done"}) + "\\n");`,
      ].join("\n"),
    );

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
    expect(result.costUsd).toBe(0.42);
  });

  test("usage tokens parsed correctly: input + cache_creation + cache_read + output", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-tokens.js");
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 200,
    };
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done",usage:${JSON.stringify(usage)}}) + "\\n");`,
      ].join("\n"),
    );

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
    // inputTokens = 100 + 50 + 25 = 175
    expect(result.inputTokens).toBe(175);
    expect(result.outputTokens).toBe(200);
  });

  test("REVIEW_RESULT:APPROVED marker prepended to outputSummary when result text truncates it", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-review-marker.js");
    // Put marker after character 500 so it would be lost in truncation
    const prefix = "x".repeat(510);
    const resultText = prefix + "REVIEW_RESULT:APPROVED";
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
      ].join("\n"),
    );

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
    // The truncated summary (500 chars) won't contain the marker, so it should be prepended
    expect(result.outputSummary.startsWith("REVIEW_RESULT:APPROVED")).toBe(
      true,
    );
  });

  test("PR URL prepended to outputSummary when truncated", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-prurl.js");
    // Put PR URL after character 500
    const prefix = "y".repeat(510);
    const prUrl = "https://github.com/owner/repo/pull/123";
    const resultText = prefix + prUrl;
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:${JSON.stringify(resultText)}}) + "\\n");`,
      ].join("\n"),
    );

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
    expect(result.outputSummary).toContain(prUrl);
    expect(result.outputSummary.startsWith(prUrl)).toBe(true);
  });

  test("process exits with code 0 but no result message → subtype 'success' with clean exit summary", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-zero-noresult.js");
    // Emit nothing to stdout, just exit 0
    writeFileSync(script, `process.exit(0);`);

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
    expect(result.outputSummary).toContain("process exited cleanly");
    expect(result.exitCode).toBe(0);
  });

  test("process exits with non-zero code, no result message → subtype 'process_error' with exit code in summary", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-nonzero.js");
    writeFileSync(script, `process.exit(42);`);

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
    expect(result.subtype).toBe("process_error");
    expect(result.outputSummary).toContain("42");
    expect(result.exitCode).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 2. invocationLogs Map management
// ---------------------------------------------------------------------------

describe("invocationLogs Map management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("invocationLogs has an entry while session is running", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-running.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"run-check"}) + "\\n");`,
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
      ].join("\n"),
    );

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    // The Map entry should exist immediately after spawn
    expect(invocationLogs.has(id)).toBe(true);

    await handle.done;
    // Still present right after done (deletion is scheduled 60s later)
    expect(invocationLogs.has(id)).toBe(true);
  });

  test("logState.done becomes true and emits 'done' event when session completes", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-done-event.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");`,
      ].join("\n"),
    );

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const logState = invocationLogs.get(id)!;
    expect(logState).toBeDefined();

    let doneEmitted = false;
    logState.emitter.once("done", () => {
      doneEmitted = true;
    });

    await handle.done;

    expect(logState.done).toBe(true);
    expect(doneEmitted).toBe(true);
  });

  test("buffer is capped at 100 lines", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-buffer-cap.js");

    // Emit 105 JSON lines then a result
    const lines: string[] = [];
    for (let i = 0; i < 105; i++) {
      lines.push(
        `process.stdout.write(JSON.stringify({type:"assistant",message:"line${i}"}) + "\\n");`,
      );
    }
    lines.push(
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
    );
    writeFileSync(script, lines.join("\n"));

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    await handle.done;

    const logState = invocationLogs.get(id);
    // logState may still be present (deletion scheduled 60s later)
    // If present, buffer must be at most 100
    if (logState) {
      expect(logState.buffer.length).toBeLessThanOrEqual(100);
    }
    // Either way, the session completed without error
  });

  test("logState.emitter emits 'line' events for each line received", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-line-events.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"assistant",message:"hello"}) + "\\n");`,
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"done"}) + "\\n");`,
      ].join("\n"),
    );

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    });

    const logState = invocationLogs.get(id)!;
    const emittedLines: string[] = [];
    logState.emitter.on("line", (line: string) => {
      emittedLines.push(line);
    });

    await handle.done;

    // At minimum we should have the assistant line and the result line
    expect(emittedLines.length).toBeGreaterThanOrEqual(2);
    const hasAssistant = emittedLines.some((l) => l.includes('"assistant"'));
    const hasResult = emittedLines.some((l) => l.includes('"result"'));
    expect(hasAssistant).toBe(true);
    expect(hasResult).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Session resume argument construction
// ---------------------------------------------------------------------------

describe("Session resume argument construction", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("spawnSession with resumeSessionId passes --resume <id> in args before -p", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-args-resume.js");
    // Print argv as JSON then emit a valid result
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"stderr",argv:process.argv}) + "\\n");`,
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"args ok"}) + "\\n");`,
      ].join("\n"),
    );

    const capturedLines: string[] = [];
    const logState_before = invocationLogs.get(id);
    void logState_before;

    const handle = spawnSession({
      agentPrompt: "my prompt",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      resumeSessionId: "prev-session-abc",
    });

    // Collect lines from emitter before done
    const logState = invocationLogs.get(id)!;
    logState.emitter.on("line", (line: string) => {
      capturedLines.push(line);
    });

    await handle.done;

    // Find the argv line
    const argvLine = capturedLines.find((l) => l.includes('"argv"'));
    expect(argvLine).toBeDefined();
    const parsed = JSON.parse(argvLine!) as { argv: string[] };
    const argv = parsed.argv;

    const resumeIdx = argv.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIdx + 1]).toBe("prev-session-abc");

    const pIdx = argv.indexOf("-p");
    expect(pIdx).toBeGreaterThan(resumeIdx);
  });

  test("spawnSession without resumeSessionId does NOT include --resume in args", async () => {
    const id = nextId();
    const script = join(tmpDir, "mock-args-noresume.js");
    writeFileSync(
      script,
      [
        `process.stdout.write(JSON.stringify({type:"stderr",argv:process.argv}) + "\\n");`,
        `process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"args ok"}) + "\\n");`,
      ].join("\n"),
    );

    const capturedLines: string[] = [];
    const handle = spawnSession({
      agentPrompt: "my prompt",
      worktreePath: tmpDir,
      maxTurns: 10,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // no resumeSessionId
    });

    const logState = invocationLogs.get(id)!;
    logState.emitter.on("line", (line: string) => {
      capturedLines.push(line);
    });

    await handle.done;

    const argvLine = capturedLines.find((l) => l.includes('"argv"'));
    expect(argvLine).toBeDefined();
    const parsed = JSON.parse(argvLine!) as { argv: string[] };
    const argv = parsed.argv;

    expect(argv.includes("--resume")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. resolveClaudeBinary
// ---------------------------------------------------------------------------

describe("resolveClaudeBinary", () => {
  test("on non-Windows: returns {command: requested, prefixArgs: []}", () => {
    if (platform() === "win32") return;

    const result = resolveClaudeBinary("/usr/local/bin/claude");
    expect(result.command).toBe("/usr/local/bin/claude");
    expect(result.prefixArgs).toEqual([]);
  });

  test("on non-Windows: result is cached (same object reference on second call)", () => {
    if (platform() === "win32") return;

    const uniquePath = `/tmp/some-unique-binary-${Date.now()}`;
    const first = resolveClaudeBinary(uniquePath);
    const second = resolveClaudeBinary(uniquePath);
    expect(first).toBe(second);
  });

  test("on non-Windows: different paths return independent results", () => {
    if (platform() === "win32") return;

    const a = resolveClaudeBinary("/bin/claude-a");
    const b = resolveClaudeBinary("/bin/claude-b");
    expect(a.command).toBe("/bin/claude-a");
    expect(b.command).toBe("/bin/claude-b");
    // Different objects since different keys
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 5. shell.ts coverage
// ---------------------------------------------------------------------------

describe("spawnShellCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    // On Windows, shell:true spawns cmd.exe which may leave grandchild node
    // processes briefly alive after the shell exits, causing EPERM on rmSync.
    // Retry a few times with a short delay before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test("runs a simple command and captures output", async () => {
    const id = nextId();
    // Use node for cross-platform output
    const cmd =
      process.platform === "win32"
        ? `node -e "process.stdout.write('hello')"`
        : `node -e "process.stdout.write('hello')"`;

    const handle = spawnShellCommand(cmd, {
      cwd: tmpDir,
      timeoutMs: 5000,
      invocationId: id,
    });

    const result = await handle.done;
    expect(result.output).toContain("hello");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  // On Windows, shell:true spawns cmd.exe as an intermediary. Killing cmd.exe
  // does not kill grandchild processes (e.g. node), which keep stdio open and
  // prevent the 'close' event from firing. Skip this test on Windows where
  // spawnShellCommand's process-tree handling behaves differently.
  test.skipIf(process.platform === "win32")(
    "enforces timeout: slow command is killed with timedOut: true",
    async () => {
      const id = nextId();
      // Sleep for 60 seconds — far longer than our 200ms timeout.
      const cmd = `node -e "setTimeout(() => {}, 60000)"`;

      const handle = spawnShellCommand(cmd, {
        cwd: tmpDir,
        timeoutMs: 200,
        invocationId: id,
      });

      const result = await handle.done;
      expect(result.timedOut).toBe(true);
    },
    15_000,
  );

  test("activeShellHandles has entry during execution, deleted after done", async () => {
    const id = nextId();
    const cmd = `node -e "process.stdout.write('done')"`;

    const handle = spawnShellCommand(cmd, {
      cwd: tmpDir,
      timeoutMs: 5000,
      invocationId: id,
    });

    // Entry exists while running
    expect(activeShellHandles.has(id)).toBe(true);

    await handle.done;

    // Entry deleted after done
    expect(activeShellHandles.has(id)).toBe(false);
  });

  // On Windows, shell:true spawns cmd.exe as an intermediary. Killing cmd.exe
  // does not kill grandchild node processes, which keep stdio open and prevent
  // 'close' from firing. Skip on Windows.
  test.skipIf(process.platform === "win32")(
    "kill() method terminates the process",
    async () => {
      const id = nextId();
      const cmd = `node -e "setTimeout(() => {}, 60000)"`;

      const handle = spawnShellCommand(cmd, {
        cwd: tmpDir,
        timeoutMs: 60000,
        invocationId: id,
      });

      // Give the process a moment to start
      await new Promise((r) => setTimeout(r, 300));

      handle.kill();

      const result = await handle.done;
      // Process was killed: timedOut should be false (we called kill, not timeout)
      expect(result.timedOut).toBe(false);
      // exitCode may be null or non-zero depending on platform signal handling
      const terminated = result.exitCode === null || result.exitCode !== 0;
      expect(terminated).toBe(true);
    },
    15_000,
  );
});
