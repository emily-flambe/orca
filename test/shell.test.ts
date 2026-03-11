// ---------------------------------------------------------------------------
// Adversarial tests for src/runner/shell.ts
// ---------------------------------------------------------------------------
//
// Bugs targeted:
//   1. Buffer-cap uses text.length (char count) instead of Buffer.byteLength —
//      multi-byte UTF-8 lets the buffer silently exceed 1 MB.
//   2. resolve() is NOT called when logStream emits 'error' — handle.done hangs
//      if disk is full and the process never exits.
//   3. proc.on('exit') fires before all piped 'data' events are guaranteed
//      delivered — stdout data written just before exit can be lost.
//   4. killShellProcess Unix escalation timer is not unref()'d — keeps event
//      loop alive unnecessarily.
//   5. timedOut flag is set in the timeout callback; if the process exits on its
//      own a nanosecond before the timeout kills it, timedOut can still be true.
//   6. logStream error handler marks SSE done but does NOT call resolve() —
//      handle.done promise never settles if process is still running.
//   7. invocationLogs is registered before the process even starts — a second
//      concurrent call with the same invocationId silently overwrites it.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We import the module under test. Note: invocationLogs is exported from
// runner/index.ts (the SSE map), which shell.ts imports. We need to observe
// it to verify registration/cleanup behaviour.
import { invocationLogs } from "../src/runner/index.js";
import { spawnShellCommand, killShellProcess } from "../src/runner/shell.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "orca-shell-test-"));
}

// ---------------------------------------------------------------------------
// 1. Basic smoke test: stdout and stderr captured, log file created
// ---------------------------------------------------------------------------

describe("basic functionality", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("captures stdout and creates NDJSON log file", async () => {
    const handle = spawnShellCommand(
      `node -e "process.stdout.write('hello stdout\\n')"`,
      1001,
      tmpDir,
    );

    const result = await handle.done;

    expect(result.stdout).toContain("hello stdout");
    expect(result.timedOut).toBe(false);

    const logPath = join(tmpDir, "logs", "1001.ndjson");
    expect(existsSync(logPath)).toBe(true);

    const logContent = readFileSync(logPath, "utf8");
    expect(logContent).toContain('"type":"stdout"');
    expect(logContent).toContain("hello stdout");
  });

  test("captures stderr separately from stdout", async () => {
    const handle = spawnShellCommand(
      `node -e "process.stderr.write('hello stderr\\n')"`,
      1002,
      tmpDir,
    );

    const result = await handle.done;

    expect(result.stderr).toContain("hello stderr");

    const logPath = join(tmpDir, "logs", "1002.ndjson");
    const logContent = readFileSync(logPath, "utf8");
    expect(logContent).toContain('"type":"stderr"');
    expect(logContent).toContain("hello stderr");
  });

  test("exitCode is captured from process exit", async () => {
    const handle = spawnShellCommand(
      `node -e "process.exit(42)"`,
      1003,
      tmpDir,
    );

    const result = await handle.done;
    expect(result.exitCode).toBe(42);
  });

  test("process_exit entry is written to NDJSON log", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(0)"`, 1004, tmpDir);
    await handle.done;

    const logPath = join(tmpDir, "logs", "1004.ndjson");
    const logContent = readFileSync(logPath, "utf8");
    expect(logContent).toContain('"type":"process_exit"');
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout: timedOut flag and process killed
// ---------------------------------------------------------------------------

describe("timeout enforcement", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("timedOut is true when timeout fires before process exits", async () => {
    // Hang for 60 s — will be killed by 200 ms timeout
    const handle = spawnShellCommand(
      `node -e "setTimeout(()=>{},60000)"`,
      1010,
      tmpDir,
      200,
    );

    const result = await handle.done;
    expect(result.timedOut).toBe(true);
  }, 10_000);

  test("timedOut is false when process exits naturally before timeout", async () => {
    // Exit immediately — 10-second timeout should never fire
    const handle = spawnShellCommand(
      `node -e "process.exit(0)"`,
      1011,
      tmpDir,
      10_000,
    );

    const result = await handle.done;
    expect(result.timedOut).toBe(false);
  });

  test("timeout clears its own timer so it does not keep the event loop alive", async () => {
    // If the timer is not cleared on natural exit, the event loop stays open.
    // We can't directly observe this in-process, but we verify the result is
    // correct and that the handle resolves promptly.
    const handle = spawnShellCommand(
      `node -e "process.exit(0)"`,
      1012,
      tmpDir,
      5_000,
    );

    const start = Date.now();
    await handle.done;
    // Should settle almost immediately, not wait for the 5s timeout
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------
// 3. invocationLogs registration and cleanup
// ---------------------------------------------------------------------------

describe("invocationLogs lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("invocationLogs is populated immediately after spawnShellCommand returns", () => {
    const handle = spawnShellCommand(
      `node -e "setTimeout(()=>{},10000)"`,
      2001,
      tmpDir,
    );

    // Must be registered synchronously — before awaiting done
    expect(invocationLogs.has(2001)).toBe(true);

    // Clean up the hanging process
    void killShellProcess(handle);
    return handle.done;
  }, 10_000);

  test("invocationLogs emits 'done' event after process exits", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(0)"`, 2002, tmpDir);

    const logState = invocationLogs.get(2002);
    expect(logState).toBeDefined();

    let doneEmitted = false;
    logState!.emitter.on("done", () => {
      doneEmitted = true;
    });

    await handle.done;

    expect(doneEmitted).toBe(true);
  });

  test("logState.done is set to true after process exits", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(0)"`, 2003, tmpDir);

    const logState = invocationLogs.get(2003);
    expect(logState).toBeDefined();
    expect(logState!.done).toBe(false); // should be false while running

    await handle.done;

    expect(logState!.done).toBe(true);
  });

  test("invocationLogs emits 'line' events for stdout output", async () => {
    const lines: string[] = [];

    const handle = spawnShellCommand(
      `node -e "process.stdout.write('line-a\\nline-b\\n')"`,
      2004,
      tmpDir,
    );

    const logState = invocationLogs.get(2004);
    logState!.emitter.on("line", (line: string) => {
      lines.push(line);
    });

    await handle.done;

    // At least one line containing the stdout data should have been emitted
    const hasStdoutLine = lines.some(
      (l) => l.includes("line-a") || l.includes("line-b"),
    );
    expect(hasStdoutLine).toBe(true);
  });

  test("duplicate invocationId: second call overwrites first logState entry", () => {
    // BUG: if two calls use the same invocationId, the second silently replaces
    // the first in invocationLogs. The first process's SSE clients are orphaned.
    const handle1 = spawnShellCommand(
      `node -e "setTimeout(()=>{},5000)"`,
      2005,
      tmpDir,
    );
    const logState1 = invocationLogs.get(2005);

    const tmpDir2 = makeTmpDir();
    const handle2 = spawnShellCommand(
      `node -e "setTimeout(()=>{},5000)"`,
      2005, // SAME invocationId
      tmpDir2,
    );
    const logState2 = invocationLogs.get(2005);

    // After second call, the map entry should still be logState1 (not silently
    // overwritten). This assertion documents the bug: it WILL FAIL because
    // shell.ts calls invocationLogs.set() unconditionally.
    expect(invocationLogs.get(2005)).toBe(logState1);

    void killShellProcess(handle1);
    void killShellProcess(handle2);
    rmSync(tmpDir2, { recursive: true, force: true });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 4. Buffer capping — 1 MB limit
// ---------------------------------------------------------------------------

describe("buffer capping at 1 MB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stdout buffer does not exceed 1 MB for ASCII output", async () => {
    // Write 2 MB of ASCII — buffer should be capped at 1 MB
    const script = `
      const chunk = 'A'.repeat(65536);
      for (let i = 0; i < 32; i++) process.stdout.write(chunk);
    `;
    const handle = spawnShellCommand(
      `node -e "${script.replace(/\n/g, " ")}"`,
      3001,
      tmpDir,
    );

    const result = await handle.done;
    const bytes = Buffer.byteLength(result.stdout);
    expect(bytes).toBeLessThanOrEqual(1_048_576);
  }, 15_000);

  test("stderr buffer does not exceed 1 MB for ASCII output", async () => {
    const script = `
      const chunk = 'E'.repeat(65536);
      for (let i = 0; i < 32; i++) process.stderr.write(chunk);
    `;
    const handle = spawnShellCommand(
      `node -e "${script.replace(/\n/g, " ")}"`,
      3002,
      tmpDir,
    );

    const result = await handle.done;
    const bytes = Buffer.byteLength(result.stderr);
    expect(bytes).toBeLessThanOrEqual(1_048_576);
  }, 15_000);

  // BUG: The cap check uses text.length (character count) instead of
  // Buffer.byteLength(text). For multi-byte UTF-8 characters (e.g. 3-byte €),
  // remaining = MAX_BUFFER_BYTES - stdoutBytes may be, say, 100 bytes, but
  // text.length = 100 characters * 3 bytes/char = 300 bytes of actual data.
  // The slice(0, remaining) slices 100 *characters*, appending up to 300 bytes.
  // This makes the buffer silently exceed 1 MB.
  test("stdout buffer does not exceed 1 MB for multi-byte UTF-8 output (BUG: fails)", async () => {
    // Each '€' is 3 bytes in UTF-8. Write enough to expose the off-by-up-to-3x
    // overrun: we send just over 1 MB worth of € characters.
    // With the bug, buffer ends up around ~1.5–3 MB; correct code caps at 1 MB.
    const euroCount = 400_000; // 400k × 3 bytes = 1.2 MB → triggers cap near end
    const script = `process.stdout.write('€'.repeat(${euroCount}))`;
    const handle = spawnShellCommand(`node -e "${script}"`, 3003, tmpDir);

    const result = await handle.done;
    const bytes = Buffer.byteLength(result.stdout, "utf8");

    // CORRECT: must not exceed 1 MB
    // BUG: shell.ts slices by char count, not byte count, so this assertion fails
    expect(bytes).toBeLessThanOrEqual(1_048_576);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 5. log file flushed/closed before handle.done resolves
// ---------------------------------------------------------------------------

describe("log file flush before done resolves", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("log file exists and is non-empty synchronously after awaiting handle.done", async () => {
    const handle = spawnShellCommand(
      `node -e "process.stdout.write('flush-check\\n'); process.exit(0)"`,
      4001,
      tmpDir,
    );

    await handle.done;

    const logPath = join(tmpDir, "logs", "4001.ndjson");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("flush-check");
  });
});

// ---------------------------------------------------------------------------
// 6. killShellProcess behaviour
// ---------------------------------------------------------------------------

describe("killShellProcess", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("killShellProcess resolves handle.done after killing the process", async () => {
    const handle = spawnShellCommand(
      `node -e "setTimeout(()=>{},60000)"`,
      5001,
      tmpDir,
      undefined, // no timeout — we kill manually
    );

    await new Promise((r) => setTimeout(r, 200));
    const result = await killShellProcess(handle);

    // Process should have exited after kill
    expect(result).toBeDefined();
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  }, 15_000);

  test("killShellProcess on already-exited process returns handle.done immediately", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(0)"`, 5002, tmpDir);

    // Wait for natural exit
    await handle.done;

    // Calling kill on a dead process should not throw or hang
    const result = await killShellProcess(handle);
    expect(result.exitCode).toBe(0);
  });

  test("killShellProcess called twice does not throw", async () => {
    const handle = spawnShellCommand(
      `node -e "setTimeout(()=>{},60000)"`,
      5003,
      tmpDir,
    );

    await new Promise((r) => setTimeout(r, 100));

    // Call kill twice concurrently — should not throw or deadlock
    await Promise.all([killShellProcess(handle), killShellProcess(handle)]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 7. Edge cases: empty command output, zero-byte writes, spawn errors
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("command that produces no output resolves with empty buffers", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(0)"`, 6001, tmpDir);

    const result = await handle.done;
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("handle.done resolves even when process exits with non-zero code", async () => {
    const handle = spawnShellCommand(`node -e "process.exit(1)"`, 6002, tmpDir);

    const result = await handle.done;
    expect(result.exitCode).toBe(1);
  });

  test("handle.done resolves when spawn fails (nonexistent executable)", async () => {
    // Spawning a nonexistent command with shell:true causes the shell to report
    // an error and exit with a non-zero code. The proc 'error' event is NOT
    // emitted by the shell wrapper — the shell itself exits with non-zero.
    // The 'exit' handler in shell.ts fires and resolves handle.done normally.
    // exitCode will be non-zero (e.g. 127 on unix, 1 on win32) — NOT null.
    // This test documents the actual behaviour (not a bug, just a clarification).
    const handle = spawnShellCommand(
      "__this_command_definitely_does_not_exist_orca_test__",
      6003,
      tmpDir,
    );

    const result = await handle.done;
    // With shell:true the shell exits with a non-zero code rather than emitting
    // a proc 'error' event, so handle.done resolves via the 'exit' handler.
    expect(result.exitCode).not.toBeNull();
    expect(result.exitCode).not.toBe(0);
    // timedOut should be false (it was a spawn failure, not a timeout)
    expect(result.timedOut).toBe(false);
  });

  test("logs directory is created if it does not exist", async () => {
    // Use a subdirectory that does not exist yet as projectRoot
    const nestedRoot = join(tmpDir, "nested", "project");
    mkdirSync(nestedRoot, { recursive: true });

    const handle = spawnShellCommand(
      `node -e "process.exit(0)"`,
      6004,
      nestedRoot,
    );

    await handle.done;

    const logPath = join(nestedRoot, "logs", "6004.ndjson");
    expect(existsSync(logPath)).toBe(true);
  });

  test("ShellHandle.process exposes the ChildProcess", () => {
    const handle = spawnShellCommand(
      `node -e "setTimeout(()=>{},5000)"`,
      6005,
      tmpDir,
    );

    expect(handle.process).toBeDefined();
    expect(typeof handle.process.pid).toBe("number");
    expect(handle.invocationId).toBe(6005);

    void killShellProcess(handle);
    return handle.done;
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 8. Race: 'exit' event vs outstanding 'data' events
// ---------------------------------------------------------------------------

describe("exit vs data race", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Node.js guarantees that all 'data' events are delivered before 'close'
  // on a readable stream, but 'exit' (process event) can fire before the
  // readable 'close'. shell.ts listens on proc.on('exit') and resolves
  // immediately — without waiting for the stdout/stderr streams to close.
  //
  // In practice Node buffers stdio so this is usually fine, but under load
  // the last chunk(s) of a large write can be missing from result.stdout.
  //
  // This test writes a large but exact payload via a script file (not inline
  // in the command string to avoid ENAMETOOLONG on Windows) and verifies it
  // is fully captured. If the exit-before-data-close race is present this
  // will occasionally produce a shorter stdout than expected.
  test("all stdout data written just before exit is captured in result.stdout", async () => {
    const chunkCount = 512; // 512 × 1024 = 512 KB ASCII
    const scriptPath = join(tmpDir, "large-output.js");
    writeFileSync(
      scriptPath,
      `const chunk = 'X'.repeat(1024);\nfor(let i=0;i<${chunkCount};i++) process.stdout.write(chunk);\n`,
    );

    const handle = spawnShellCommand(`node "${scriptPath}"`, 7001, tmpDir);

    const result = await handle.done;
    // All 512 KB must be captured — not truncated by the exit/data race
    expect(result.stdout.length).toBe(chunkCount * 1024);
  }, 15_000);
});
