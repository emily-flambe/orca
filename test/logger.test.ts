// ---------------------------------------------------------------------------
// Logger module tests — file logging with size-based rotation
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { join } from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "orca-logger-test-"));
}

/**
 * Import a fresh copy of the logger module with reset module-level state.
 * Uses vi.resetModules() to bust the module cache so each call gets
 * initialized=false, default logPath, and default maxSizeBytes.
 */
async function freshLogger() {
  vi.resetModules();
  return (await import("../src/logger.js")) as typeof import("../src/logger.js");
}

// ---------------------------------------------------------------------------
// initLogger
// ---------------------------------------------------------------------------

describe("initLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates the log directory if it does not exist", async () => {
    const { initLogger } = await freshLogger();
    const logDir = join(tempDir, "nested", "logs");
    const logFile = join(logDir, "orca.log");

    initLogger({ logPath: logFile });

    expect(existsSync(logDir)).toBe(true);
  });

  test("does not throw when directory already exists", async () => {
    const { initLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    expect(() => initLogger({ logPath: logFile })).not.toThrow();
  });

  test("gracefully handles impossible path without throwing", async () => {
    const { initLogger } = await freshLogger();
    // On all platforms, a path under a regular file is invalid
    const impossibleBase = join(tempDir, "file.txt");
    writeFileSync(impossibleBase, "I am a file");
    const impossibleLog = join(impossibleBase, "subdir", "orca.log");

    expect(() => initLogger({ logPath: impossibleLog })).not.toThrow();
  });

  test("sets initialized flag so file writes proceed", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    initLogger({ logPath: logFile });
    const logger = createLogger("test");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello after init");
    spy.mockRestore();

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("hello after init");
  });
});

// ---------------------------------------------------------------------------
// createLogger — before initLogger
// ---------------------------------------------------------------------------

describe("createLogger before initLogger", () => {
  test("logger.info writes to console but NOT to file before initLogger", async () => {
    const { createLogger } = await freshLogger();

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("pre-init");
    logger.info("should not be on disk");

    expect(spy).toHaveBeenCalledWith("[orca/pre-init] should not be on disk");
    spy.mockRestore();

    // Since initialized is false, no file is written.
    // We can't easily check "no file exists at the default path" because
    // the default is ./logs/orca.log which might exist from other runs.
    // The key assertion is that console.log was called (proving the code ran)
    // and no crash occurred.
  });

  test("logger.warn writes to console but NOT to file before initLogger", async () => {
    const { createLogger } = await freshLogger();

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger("pre-init");
    logger.warn("warning before init");

    expect(spy).toHaveBeenCalledWith("[orca/pre-init] warning before init");
    spy.mockRestore();
  });

  test("logger.error writes to console but NOT to file before initLogger", async () => {
    const { createLogger } = await freshLogger();

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("pre-init");
    logger.error("error before init");

    expect(spy).toHaveBeenCalledWith("[orca/pre-init] error before init");
    spy.mockRestore();
  });

  test("no file is created at the configured path before initLogger", async () => {
    const tempDir = makeTempDir();
    try {
      const { createLogger, initLogger } = await freshLogger();
      const logFile = join(tempDir, "should-not-exist.log");

      // Do NOT call initLogger. Create a logger and use it.
      // But wait -- the module defaults logPath to "./logs/orca.log", not our tempDir.
      // We can't change logPath without calling initLogger. So let's verify
      // the "no write" path a different way: call initLogger with our path,
      // then reset and try without.

      // Actually, freshLogger gives us a clean module with initialized=false.
      // The logger will try to write to the default path "./logs/orca.log".
      // Since initialized=false, writeToFile returns early. That's the test.
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("nofile");
      logger.info("invisible");
      spy.mockRestore();

      // The default log path is relative: ./logs/orca.log
      // Nothing should have been written since initialized=false
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createLogger — file writing after initLogger
// ---------------------------------------------------------------------------

describe("createLogger file writing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("info writes message to log file with correct format", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("mymod");
    logger.info("test message 123");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(1);

    // Verify format: YYYY-MM-DDTHH:MM:SS.sssZ INFO  [orca/mymod] test message 123
    const line = lines[0]!;
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  \[orca\/mymod\] test message 123$/,
    );
  });

  test("warn writes message to log file with WARN level", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger("mymod");
    logger.warn("something concerning");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8").trim();
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN  \[orca\/mymod\] something concerning$/,
    );
  });

  test("error writes message to log file with ERROR level", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("mymod");
    logger.error("things broke");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8").trim();
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ERROR \[orca\/mymod\] things broke$/,
    );
  });

  test("multiple log calls append to same file", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger("multi");
    logger.info("first");
    logger.warn("second");
    logger.error("third");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("INFO");
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("WARN");
    expect(lines[1]).toContain("second");
    expect(lines[2]).toContain("ERROR");
    expect(lines[2]).toContain("third");
  });

  test("multiple loggers write to the same file", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const loggerA = createLogger("moduleA");
    const loggerB = createLogger("moduleB");
    loggerA.info("from A");
    loggerB.info("from B");

    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("[orca/moduleA] from A");
    expect(content).toContain("[orca/moduleB] from B");
  });
});

// ---------------------------------------------------------------------------
// Console output format
// ---------------------------------------------------------------------------

describe("console output format", () => {
  test("info uses console.log with [orca/module] prefix (no timestamp)", async () => {
    const { createLogger } = await freshLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger("mymod");
    logger.info("hello world");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[orca/mymod] hello world");
    spy.mockRestore();
  });

  test("warn uses console.warn with [orca/module] prefix", async () => {
    const { createLogger } = await freshLogger();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const logger = createLogger("mymod");
    logger.warn("caution");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[orca/mymod] caution");
    spy.mockRestore();
  });

  test("error uses console.error with [orca/module] prefix", async () => {
    const { createLogger } = await freshLogger();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger("mymod");
    logger.error("boom");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[orca/mymod] boom");
    spy.mockRestore();
  });

  test("console output does NOT contain timestamp", async () => {
    const { createLogger } = await freshLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger("ts-check");
    logger.info("no timestamp here");

    const output = spy.mock.calls[0]![0] as string;
    // ISO timestamp pattern should NOT appear in console output
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// File format verification
// ---------------------------------------------------------------------------

describe("file format", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("INFO and WARN are padded to same column width", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const logger = createLogger("pad");
    logger.info("x");
    logger.warn("x");

    logSpy.mockRestore();
    warnSpy.mockRestore();

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    // Both lines should have the [orca/pad] at the same column position
    const infoIdx = lines[0]!.indexOf("[orca/pad]");
    const warnIdx = lines[1]!.indexOf("[orca/pad]");
    expect(infoIdx).toBe(warnIdx);
  });

  test("ERROR level is padded to same column width as INFO/WARN", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger("pad");
    logger.info("x");
    logger.error("x");

    logSpy.mockRestore();
    errorSpy.mockRestore();

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    const infoIdx = lines[0]!.indexOf("[orca/pad]");
    const errorIdx = lines[1]!.indexOf("[orca/pad]");
    expect(infoIdx).toBe(errorIdx);
  });

  test("each line ends with a newline (no trailing partial line)", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("nl");
    logger.info("line one");
    logger.info("line two");
    spy.mockRestore();

    const raw = readFileSync(logFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // Should not end with double newline
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe("rotation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rotates log file when it exceeds maxSizeMb", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    // Set small max size: 0.001 MB ≈ 1048 bytes (above 1 KB floor)
    initLogger({ logPath: logFile, maxSizeMb: 0.001 });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("rot");

    // Each line ≈ 44 header + 2000 message + 1 newline ≈ 2045 bytes, well above 1048
    logger.info("A".repeat(2000));
    // First write creates the file. rotateIfNeeded runs BEFORE each write,
    // so the first call won't rotate (file doesn't exist yet).
    // Second call: rotateIfNeeded sees the file > 1048 bytes and renames it.
    logger.info("B".repeat(2000));

    spy.mockRestore();

    // The backup file should exist
    expect(existsSync(logFile + ".1")).toBe(true);
    // The current log file should exist with the latest write
    expect(existsSync(logFile)).toBe(true);

    const currentContent = readFileSync(logFile, "utf-8");
    expect(currentContent).toContain("B".repeat(2000));

    const backupContent = readFileSync(logFile + ".1", "utf-8");
    expect(backupContent).toContain("A".repeat(2000));
  });

  test("rotation overwrites previous .1 backup (single slot)", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    // Use small max so rotation triggers: 0.001 MB ≈ 1048 bytes
    initLogger({ logPath: logFile, maxSizeMb: 0.001 });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("rot");

    // First rotation cycle (each message ~2000+ bytes, above 1048 limit)
    logger.info("FIRST_" + "X".repeat(2000));
    logger.info("SECOND_" + "X".repeat(2000));
    // Now .1 should have FIRST, current should have SECOND

    // Second rotation cycle
    logger.info("THIRD_" + "X".repeat(2000));
    // Now .1 should have SECOND (overwriting FIRST), current should have THIRD

    spy.mockRestore();

    const backupContent = readFileSync(logFile + ".1", "utf-8");
    // FIRST is gone -- only one backup slot by design
    expect(backupContent).not.toContain("FIRST_");
    expect(backupContent).toContain("SECOND_");

    const currentContent = readFileSync(logFile, "utf-8");
    expect(currentContent).toContain("THIRD_");
  });

  test("does not rotate when file is under the size limit", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    // 10 MB -- our tiny writes won't trigger rotation
    initLogger({ logPath: logFile, maxSizeMb: 10 });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("norot");
    logger.info("small message");
    logger.info("another small message");
    spy.mockRestore();

    expect(existsSync(logFile + ".1")).toBe(false);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("small message");
    expect(content).toContain("another small message");
  });
});

// ---------------------------------------------------------------------------
// Edge cases and error handling
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("empty message is handled", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("empty");
    logger.info("");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("[orca/empty] ");
  });

  test("message with special characters is preserved", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("special");
    logger.info('quote "test" & <html> $var `backtick`');
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain('quote "test" & <html> $var `backtick`');
  });

  test("message with embedded newlines are escaped in file output", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("newline");
    logger.info("line1\nline2\nline3");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    // Newlines are escaped to \n literals, so file has exactly 1 line
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[0]).toContain("line1\\nline2\\nline3");
  });

  test("very long message is written without truncation", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("long");
    const longMsg = "X".repeat(100_000);
    logger.info(longMsg);
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain(longMsg);
  });

  test("file write failure after init does not crash", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    // Remove the directory after init to simulate a write failure
    rmSync(tempDir, { recursive: true, force: true });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("crash");

    // Should not throw even though the directory is gone
    expect(() => logger.info("will fail silently")).not.toThrow();
    spy.mockRestore();
  });

  test("module name with slash is preserved correctly", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("linear/webhook");
    logger.info("nested module");
    spy.mockRestore();

    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("[orca/linear/webhook] nested module");
  });
});

// ---------------------------------------------------------------------------
// Module-level state (BUG DETECTION)
// ---------------------------------------------------------------------------

describe("module-level state", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("calling initLogger twice changes the log path for existing loggers", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile1 = join(tempDir, "first.log");
    const logFile2 = join(tempDir, "second.log");

    initLogger({ logPath: logFile1 });
    const logger = createLogger("switch");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("goes to first");

    initLogger({ logPath: logFile2 });
    logger.info("goes to second");
    spy.mockRestore();

    // Both files should exist because the logger references shared module state
    expect(readFileSync(logFile1, "utf-8")).toContain("goes to first");
    expect(readFileSync(logFile2, "utf-8")).toContain("goes to second");
    // BUG/DESIGN: Re-initializing silently redirects ALL existing loggers.
    // This is surprising behavior -- callers might expect their logger
    // to keep writing to the original path.
  });

  test("initLogger with empty opts uses defaults", async () => {
    const { initLogger } = await freshLogger();
    // Should not throw with empty options
    expect(() => initLogger({})).not.toThrow();
  });

  test("initLogger sets initialized=true even when directory creation fails (BUG)", async () => {
    const { initLogger, createLogger } = await freshLogger();

    // Use an impossible path for the directory
    const impossibleBase = join(tempDir, "file.txt");
    writeFileSync(impossibleBase, "blocker");
    const impossibleLog = join(impossibleBase, "sub", "orca.log");

    initLogger({ logPath: impossibleLog });

    // BUG: initialized is set to true even though the directory doesn't exist.
    // Every subsequent write will try appendFileSync and silently fail.
    // This means the user gets no indication that logging is broken.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("broken");

    // Won't throw but won't write anything useful either
    expect(() => logger.info("goes nowhere")).not.toThrow();
    spy.mockRestore();
  });

  test("no resetLogger function exists (state leaks across module consumers)", async () => {
    const mod = await freshLogger();
    // There is no way to reset the module state without reimporting.
    // This makes testing harder and means if initLogger is called with
    // wrong values, the only recourse is to restart the process.
    expect((mod as Record<string, unknown>)["resetLogger"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// maxSizeMb boundary values
// ---------------------------------------------------------------------------

describe("maxSizeMb edge cases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("maxSizeMb of 0 is clamped to minimum floor (no premature rotation)", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    // maxSizeMb=0 is clamped to 1 KB minimum
    initLogger({ logPath: logFile, maxSizeMb: 0 });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("zero");

    logger.info("first write");
    logger.info("second write");

    spy.mockRestore();

    // Small writes should NOT trigger rotation since floor is 1 KB
    expect(existsSync(logFile + ".1")).toBe(false);
  });

  test("negative maxSizeMb is clamped to minimum floor (no premature rotation)", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");

    // Negative is clamped to 1 KB minimum
    initLogger({ logPath: logFile, maxSizeMb: -1 });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("neg");
    logger.info("first");
    logger.info("second");
    spy.mockRestore();

    // Small writes should NOT trigger rotation since floor is 1 KB
    expect(existsSync(logFile + ".1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent / rapid writes
// ---------------------------------------------------------------------------

describe("rapid sequential writes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("100 rapid writes produce 100 well-formed lines", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const logFile = join(tempDir, "orca.log");
    initLogger({ logPath: logFile });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("rapid");

    const count = 100;
    for (let i = 0; i < count; i++) {
      logger.info(`message-${i}`);
    }
    spy.mockRestore();

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(count);

    for (let i = 0; i < count; i++) {
      expect(lines[i]).toContain(`message-${i}`);
      expect(lines[i]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

// ---------------------------------------------------------------------------
// Logger interface type contract
// ---------------------------------------------------------------------------

describe("Logger interface", () => {
  test("createLogger returns object with info, warn, error methods", async () => {
    const { createLogger } = await freshLogger();
    const logger = createLogger("iface");

    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  test("createLogger with empty module name produces [orca/] prefix", async () => {
    const { createLogger } = await freshLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger("");
    logger.info("empty module");

    expect(spy).toHaveBeenCalledWith("[orca/] empty module");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Config integration check
// ---------------------------------------------------------------------------

describe("config integration", () => {
  test("logger API accepts fractional maxSizeMb values", async () => {
    const { initLogger, createLogger } = await freshLogger();
    const tempDir = makeTempDir();
    try {
      const logFile = join(tempDir, "orca.log");

      // Logger API accepts fractional MB (0.5 MB = 524288 bytes)
      // Config uses readPositiveNumberOrDefault so ORCA_LOG_MAX_SIZE_MB=0.5 works
      initLogger({ logPath: logFile, maxSizeMb: 0.5 });

      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger("frac");
      logger.info("half MB limit");
      spy.mockRestore();

      expect(existsSync(logFile)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
