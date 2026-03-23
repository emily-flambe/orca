// ---------------------------------------------------------------------------
// Adversarial tests for src/logger.ts
// ---------------------------------------------------------------------------
//
// Strategy:
//   1. Rotation: verify .1 file created, current file reset after overflow
//   2. Timestamp prefix per-line within a single write() call
//   3. Missing log directory — appendFileSync throws, confirm non-fatal (silent)
//   4. Callback forwarding — write(str, encoding, cb) must invoke cb
//   5. Double-init guard — calling initFileLogger twice does NOT double-write
//   6. Binary (Uint8Array) data — must not corrupt the file
//   7. Empty write — zero-byte write must not crash
//   8. Rotation: .1 backup replaced when it already exists
//   9. initFileLogger does NOT patch stdout before it is called
//  10. Config: logPath/logMaxSizeMb present in OrcaConfig interface

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initFileLogger, createLogger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "orca-logger-test-"));
}

/** Restore stdout/stderr write to original after each test. */
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

// ---------------------------------------------------------------------------
// 1. Rotation: file over maxSizeBytes gets renamed to .1
// ---------------------------------------------------------------------------

describe("rotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rotation creates .1 file and resets current log when size exceeded", () => {
    const logPath = join(tmpDir, "orca.log");
    const maxSizeBytes = 100;

    initFileLogger({ logPath, maxSizeBytes });

    // Write enough to exceed the limit on the first write (pre-fill then trigger)
    // Pre-fill: write exactly maxSizeBytes to the log file directly so next write triggers rotation
    writeFileSync(logPath, "x".repeat(maxSizeBytes));

    // This write should trigger rotation
    process.stdout.write("trigger rotation\n");

    const backupPath = logPath + ".1";
    expect(existsSync(backupPath)).toBe(true);

    // The backup should contain the pre-filled content
    const backupContent = readFileSync(backupPath, "utf8");
    expect(backupContent).toBe("x".repeat(maxSizeBytes));

    // The current log should be smaller than the pre-fill size
    // (it should only contain the new write, not the old content)
    const currentSize = statSync(logPath).size;
    expect(currentSize).toBeLessThan(maxSizeBytes);
  });

  test("rotation removes old .1 file before creating new backup", () => {
    const logPath = join(tmpDir, "orca.log");
    const backupPath = logPath + ".1";
    const maxSizeBytes = 50;

    // Create an old .1 file
    writeFileSync(backupPath, "old backup content");

    initFileLogger({ logPath, maxSizeBytes });

    // Pre-fill log to trigger rotation
    writeFileSync(logPath, "a".repeat(maxSizeBytes));

    process.stdout.write("new write after pre-fill\n");

    // Old .1 content should be replaced
    const backupContent = readFileSync(backupPath, "utf8");
    expect(backupContent).toBe("a".repeat(maxSizeBytes));
    expect(backupContent).not.toContain("old backup content");
  });

  test("writing less than maxSizeBytes does NOT create .1 backup", () => {
    const logPath = join(tmpDir, "orca.log");
    const backupPath = logPath + ".1";
    const maxSizeBytes = 10_000;

    initFileLogger({ logPath, maxSizeBytes });

    process.stdout.write("small write\n");

    expect(existsSync(backupPath)).toBe(false);
  });

  test("multiple writes accumulate across the rotation threshold", () => {
    const logPath = join(tmpDir, "orca.log");
    const maxSizeBytes = 200;

    initFileLogger({ logPath, maxSizeBytes });

    // Write 10 bytes at a time — rotation should happen somewhere after 200 bytes
    for (let i = 0; i < 30; i++) {
      process.stdout.write("0123456789"); // 10 bytes each
    }

    // After 300 bytes total written, rotation must have happened at least once
    const backupPath = logPath + ".1";
    expect(existsSync(backupPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Timestamp prefix: multi-line write gets ONE timestamp, not one per line
//    This is a known design limitation — test documents the actual behavior.
// ---------------------------------------------------------------------------

describe("timestamp prefix behavior", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("multi-line write: each line gets its own timestamp prefix", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    // Write a string with multiple lines in a single write() call
    process.stdout.write("line one\nline two\nline three\n");

    const content = readFileSync(logPath, "utf8");

    // Count ISO timestamp prefixes (they look like 20XX-...)
    const timestampMatches = content.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g,
    );
    const timestampCount = timestampMatches?.length ?? 0;

    // Each non-empty line gets its own timestamp: 3 lines → 3 timestamps
    expect(timestampCount).toBe(3);

    // All three lines are present
    expect(content).toContain("line one");
    expect(content).toContain("line two");
    expect(content).toContain("line three");
  });

  test("separate write calls each get their own timestamp", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    process.stdout.write("first write\n");
    process.stdout.write("second write\n");

    const content = readFileSync(logPath, "utf8");
    const timestampMatches = content.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g,
    );
    const timestampCount = timestampMatches?.length ?? 0;

    // Two separate writes → two timestamps
    expect(timestampCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing log directory — non-fatal (swallowed), no output lost to stdout
// ---------------------------------------------------------------------------

describe("missing log directory", () => {
  test("initFileLogger with nonexistent directory does not throw", () => {
    const logPath = "/nonexistent/dir/that/does/not/exist/orca.log";

    // Should not throw during init
    expect(() => {
      initFileLogger({ logPath, maxSizeBytes: 1_000_000 });
    }).not.toThrow();
  });

  test("writes to stdout still succeed when log directory is missing", () => {
    const logPath = "/nonexistent/path/orca.log";

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    // stdout.write should still return truthy (write proceeds to actual stdout)
    // even though file write silently fails
    const result = process.stdout.write("output despite bad path\n");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Callback forwarding — write(str, encoding, cb) must invoke the callback
// ---------------------------------------------------------------------------

describe("callback forwarding", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stdout.write(str, cb) — callback is invoked", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    // Node.js stream overload: write(chunk, callback)
    return new Promise<void>((resolve) => {
      process.stdout.write("callback test\n", () => {
        resolve();
      });
    });
  });

  test("stdout.write(str, encoding, cb) — callback is invoked", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    // Node.js stream overload: write(chunk, encoding, callback)
    return new Promise<void>((resolve) => {
      process.stdout.write("encoding callback test\n", "utf8", () => {
        resolve();
      });
    });
  });

  test("stderr.write(str, cb) — callback is invoked", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    return new Promise<void>((resolve) => {
      process.stderr.write("stderr callback test\n", () => {
        resolve();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Double-init: calling initFileLogger twice causes double-writes to file
// ---------------------------------------------------------------------------

describe("double-init (monkey-patch layering)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calling initFileLogger twice writes each message only once (double-init guard)", () => {
    const logPath = join(tmpDir, "orca.log");

    // Call init twice with the same logPath
    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });
    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    process.stdout.write("UNIQUE_MARKER\n");

    const content = readFileSync(logPath, "utf8");

    // Count occurrences of the unique marker — guard prevents double-patch
    const occurrences = (content.match(/UNIQUE_MARKER/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Binary (Uint8Array) data — converted to UTF-8 string in log file
// ---------------------------------------------------------------------------

describe("Uint8Array data handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Uint8Array written to stdout is logged as UTF-8 string", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    const text = "binary data test\n";
    const bytes = new TextEncoder().encode(text);
    process.stdout.write(bytes);

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("binary data test");
  });
});

// ---------------------------------------------------------------------------
// 7. Empty write — zero-byte write must not crash
// ---------------------------------------------------------------------------

describe("empty write", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writing empty string does not throw", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    expect(() => {
      process.stdout.write("");
    }).not.toThrow();
  });

  test("writing empty Uint8Array does not throw", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    expect(() => {
      process.stdout.write(new Uint8Array(0));
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Both stdout and stderr are tee'd to the same log file
// ---------------------------------------------------------------------------

describe("both streams logged", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stdout and stderr both appear in the log file", () => {
    const logPath = join(tmpDir, "orca.log");

    initFileLogger({ logPath, maxSizeBytes: 1_000_000 });

    process.stdout.write("FROM_STDOUT\n");
    process.stderr.write("FROM_STDERR\n");

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("FROM_STDOUT");
    expect(content).toContain("FROM_STDERR");
  });
});

// ---------------------------------------------------------------------------
// 9. stdout.write is NOT monkey-patched before initFileLogger is called
// ---------------------------------------------------------------------------

describe("pre-init behavior", () => {
  test("stdout.write before initFileLogger is the original Node.js implementation", () => {
    // After beforeEach restores the original, confirm the identity
    // The original is bound in beforeEach — it should be a native function
    // We confirm it's not our wrapper by checking it doesn't write to a file
    const tmpDir = makeTmpDir();
    const logPath = join(tmpDir, "orca.log");

    try {
      // Do NOT call initFileLogger
      process.stdout.write("pre-init write\n");

      // The log file should not exist because initFileLogger was never called
      expect(existsSync(logPath)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Config: OrcaConfig includes logPath and logMaxSizeMb (type check via import)
// ---------------------------------------------------------------------------

describe("OrcaConfig interface includes log fields", () => {
  test("OrcaConfig type has logPath", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/config/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("logPath:");
    expect(source).toContain("ORCA_LOG_PATH");
  });
});

// ---------------------------------------------------------------------------
// 11. cli/index.ts: initFileLogger is called before first logger output
// ---------------------------------------------------------------------------

describe("initFileLogger call order in CLI", () => {
  test("initFileLogger called before first logger.info in start command", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/cli/index.ts", import.meta.url),
      "utf8",
    );

    const initPos = source.indexOf("initFileLogger(");
    const actionPos = source.indexOf(".action(async");
    const firstLogCall = source.indexOf("logger.", actionPos);

    expect(initPos).toBeGreaterThan(-1);
    expect(firstLogCall).toBeGreaterThan(-1);

    // initFileLogger must appear BEFORE the first logger call inside the start action
    expect(initPos).toBeLessThan(firstLogCall);
  });
});

// ---------------------------------------------------------------------------
// 12. .gitignore covers orca.log and orca.log.1
// ---------------------------------------------------------------------------

describe("gitignore coverage", () => {
  test("orca.log is listed in .gitignore", async () => {
    const { readFileSync } = await import("node:fs");
    const gitignore = readFileSync(
      new URL("../.gitignore", import.meta.url),
      "utf8",
    );

    expect(gitignore).toContain("orca.log");
  });

  test("orca.log.1 is listed in .gitignore", async () => {
    const { readFileSync } = await import("node:fs");
    const gitignore = readFileSync(
      new URL("../.gitignore", import.meta.url),
      "utf8",
    );

    expect(gitignore).toContain("orca.log.1");
  });
});

// ---------------------------------------------------------------------------
// 13. Rotation boundary: file at exactly maxSizeBytes triggers rotation
// ---------------------------------------------------------------------------

describe("rotation boundary conditions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("file at exactly maxSizeBytes triggers rotation (>= boundary)", () => {
    const logPath = join(tmpDir, "orca.log");
    const maxSizeBytes = 50;

    // Pre-fill to exactly maxSizeBytes
    writeFileSync(logPath, "x".repeat(maxSizeBytes));

    initFileLogger({ logPath, maxSizeBytes });

    process.stdout.write("boundary trigger\n");

    const backupPath = logPath + ".1";
    expect(existsSync(backupPath)).toBe(true);
  });

  test("file one byte under maxSizeBytes does NOT trigger rotation", () => {
    const logPath = join(tmpDir, "orca.log");
    const maxSizeBytes = 50;

    // Pre-fill to maxSizeBytes - 1
    writeFileSync(logPath, "x".repeat(maxSizeBytes - 1));

    initFileLogger({ logPath, maxSizeBytes });

    process.stdout.write("x"); // one byte: total now = maxSizeBytes (but check is BEFORE write)

    // The rotation check happens before the write, so 49 bytes < 50 → no rotation
    const backupPath = logPath + ".1";
    expect(existsSync(backupPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 14. testConfig in ci-gate.test.ts is missing logPath/logMaxSizeMb
//     This exposes that the test helper doesn't match the updated OrcaConfig.
// ---------------------------------------------------------------------------

describe("OrcaConfig completeness - testConfig helper", () => {
  test("ci-gate.test.ts testConfig includes logPath", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./ci-gate.test.ts", import.meta.url),
      "utf8",
    );

    const hasLogPath = source.includes("logPath:");
    expect(hasLogPath).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. createLogger — human-readable format (default)
// ---------------------------------------------------------------------------

describe("createLogger human-readable format", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.LOG_FORMAT;
    process.env.LOG_LEVEL = "debug";
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  });

  test("info emits [INFO] [orca/module] message format to console.log", () => {
    const log = createLogger("mymod");
    log.info("hello world");

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(output).toMatch(/^\[INFO\] \[orca\/mymod\] hello world$/);
  });

  test("warn emits to console.warn", () => {
    const log = createLogger("mymod");
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    log.warn("something failed");

    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    const output = consoleWarnSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[WARN]");
    expect(output).toContain("something failed");
  });

  test("error emits to console.error", () => {
    const log = createLogger("mymod");
    log.error("boom");

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[ERROR]");
  });

  test("structured fields appended as JSON after message", () => {
    const log = createLogger("mymod");
    log.info("operation done", { taskId: "abc", error: "timeout" });

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[INFO] [orca/mymod] operation done");
    expect(output).toContain('"taskId":"abc"');
    expect(output).toContain('"error":"timeout"');
  });

  test("non-plain-object last arg is treated as message part, not fields", () => {
    const log = createLogger("mymod");
    const err = new Error("oops");
    log.info("caught", err);

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    // Error is serialized as part of message, not merged into fields
    expect(output).toContain("[INFO] [orca/mymod] caught");
    // No trailing JSON fields object
    expect(output).not.toMatch(/\{.*"stack"/);
  });

  test("array last arg is treated as message part, not fields", () => {
    const log = createLogger("mymod");
    log.info("items", [1, 2, 3]);

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[1,2,3]");
  });
});

// ---------------------------------------------------------------------------
// 16. createLogger — JSON format (LOG_FORMAT=json)
// ---------------------------------------------------------------------------

describe("createLogger JSON format", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "debug";
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  });

  test("info emits valid JSON with required fields", () => {
    const log = createLogger("mymod");
    log.info("hello world");

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const raw = consoleLogSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;

    expect(entry.level).toBe("info");
    expect(entry.module).toBe("orca/mymod");
    expect(entry.message).toBe("hello world");
    expect(typeof entry.timestamp).toBe("string");
    // ISO 8601
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("warn emits to console.warn", () => {
    const log = createLogger("mymod");
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    log.warn("uh oh");

    expect(consoleWarnSpy).toHaveBeenCalledOnce();
    const raw = consoleWarnSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.level).toBe("warn");
  });

  test("error emits to console.error", () => {
    const log = createLogger("mymod");
    log.error("boom");

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const raw = consoleErrorSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.level).toBe("error");
  });

  test("structured fields merged into JSON entry", () => {
    const log = createLogger("mymod");
    log.info("op done", { taskId: "task-123", count: 42 });

    const raw = consoleLogSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.message).toBe("op done");
    expect(entry.taskId).toBe("task-123");
    expect(entry.count).toBe(42);
  });

  test("context fields included in every log entry", () => {
    const log = createLogger("mymod", { taskId: "t-1", invocationId: 99 });
    log.info("step done");

    const raw = consoleLogSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.taskId).toBe("t-1");
    expect(entry.invocationId).toBe(99);
    expect(entry.message).toBe("step done");
  });

  test("context fields appear in all log levels", () => {
    const log = createLogger("mymod", { taskId: "t-2" });
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    log.warn("whoops", { error: "timeout" });

    const raw = consoleWarnSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.taskId).toBe("t-2");
    expect(entry.error).toBe("timeout");
    expect(entry.level).toBe("warn");
  });

  test("no context fields when context is omitted", () => {
    const log = createLogger("mymod");
    log.info("plain");

    const raw = consoleLogSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect("taskId" in entry).toBe(false);
    expect("invocationId" in entry).toBe(false);
  });

  test("debug level respects LOG_LEVEL=debug", () => {
    const log = createLogger("mymod");
    log.debug("trace info");

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const raw = consoleLogSpy.mock.calls[0]![0] as string;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    expect(entry.level).toBe("debug");
  });

  test("output is newline-delimited JSON (single line per call)", () => {
    const log = createLogger("mymod");
    log.info("line one");
    log.info("line two");

    // Each call should produce exactly one JSON object
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    for (const call of consoleLogSpy.mock.calls) {
      const raw = call[0] as string;
      expect(raw.split("\n")).toHaveLength(1);
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 17. LOG_FORMAT env var controls mode
// ---------------------------------------------------------------------------

describe("LOG_FORMAT env var controls output mode", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  });

  test("LOG_FORMAT unset → human-readable output (not JSON)", () => {
    delete process.env.LOG_FORMAT;
    const log = createLogger("mod");
    log.info("test");

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(output).toMatch(/^\[INFO\]/);
    // Should NOT be valid JSON
    expect(() => JSON.parse(output)).toThrow();
  });

  test("LOG_FORMAT=other → human-readable output (not JSON)", () => {
    process.env.LOG_FORMAT = "text";
    const log = createLogger("mod");
    log.info("test");

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(output).toMatch(/^\[INFO\]/);
    expect(() => JSON.parse(output)).toThrow();
  });

  test("LOG_FORMAT=json → JSON output", () => {
    process.env.LOG_FORMAT = "json";
    const log = createLogger("mod");
    log.info("test");

    const output = consoleLogSpy.mock.calls[0]![0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
    const entry = JSON.parse(output) as Record<string, unknown>;
    expect(entry.level).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// 18. .env.example documents LOG_FORMAT
// ---------------------------------------------------------------------------

describe(".env.example documents LOG_FORMAT", () => {
  test("LOG_FORMAT is present in .env.example", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../.env.example", import.meta.url),
      "utf8",
    );
    expect(source).toContain("LOG_FORMAT");
  });
});
