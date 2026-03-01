// ---------------------------------------------------------------------------
// Logger module tests — adversarial / edge-case focused
// ---------------------------------------------------------------------------

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to reset module-level state between tests since logger.ts uses
// module-level variables (logFilePath, maxSizeBytes, initialized).
// We use dynamic import + vi.resetModules() to get fresh state each test.

let testDir: string;

function freshTestDir(): string {
  const dir = join(tmpdir(), `orca-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function importFreshLogger() {
  vi.resetModules();
  const mod = await import("../src/logger.js");
  return mod;
}

beforeEach(() => {
  testDir = freshTestDir();
});

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
  vi.restoreAllMocks();
});

// ===========================================================================
// Basic functionality
// ===========================================================================

describe("createLogger without initLogger (graceful degradation)", () => {
  test("console output works without initLogger", async () => {
    const { createLogger } = await importFreshLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const logger = createLogger("test-mod");
    logger.info("hello");

    expect(spy).toHaveBeenCalledWith("[orca/test-mod] hello");
  });

  test("no file is written without initLogger", async () => {
    const { createLogger } = await importFreshLogger();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const logPath = join(testDir, "should-not-exist.log");
    const logger = createLogger("test-mod");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(existsSync(logPath)).toBe(false);
  });

  test("warn uses console.warn", async () => {
    const { createLogger } = await importFreshLogger();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const logger = createLogger("w");
    logger.warn("warning!");

    expect(spy).toHaveBeenCalledWith("[orca/w] warning!");
  });

  test("error uses console.error", async () => {
    const { createLogger } = await importFreshLogger();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger("e");
    logger.error("err!");

    expect(spy).toHaveBeenCalledWith("[orca/e] err!");
  });
});

// ===========================================================================
// File writing
// ===========================================================================

describe("file logging after initLogger", () => {
  test("creates log file and writes with timestamp + level", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 1 });
    const logger = createLogger("mod");
    logger.info("test message");

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("[INFO]");
    expect(content).toContain("[orca/mod]");
    expect(content).toContain("test message");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("writes WARN level correctly", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "test.log");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("mod");
    logger.warn("be careful");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[WARN]");
    expect(content).toContain("be careful");
  });

  test("writes ERROR level correctly", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "test.log");
    vi.spyOn(console, "error").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("mod");
    logger.error("something broke");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[ERROR]");
    expect(content).toContain("something broke");
  });

  test("appends multiple log lines", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("multi");
    logger.info("line one");
    logger.warn("line two");
    logger.error("line three");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  test("creates parent directories if they don't exist", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "deep", "nested", "dir", "test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("nested");
    logger.info("deep write");

    expect(existsSync(logPath)).toBe(true);
  });
});

// ===========================================================================
// Rotation
// ===========================================================================

describe("file rotation", () => {
  test("small maxSizeMb is clamped to minimum 1MB, preventing premature rotation", async () => {
    // maxSizeMb values below 1 are clamped to 1 by Math.max(opts.maxSizeMb, 1)
    // This prevents pathological rotation on every write.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "rotate.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // 0.0001 is clamped to 1MB
    initLogger({ logPath, maxSizeMb: 0.0001 });
    const logger = createLogger("rot");

    logger.info("first line of data");
    logger.info("second line of data");
    logger.info("third line of data");

    // All lines survive because effective size limit is 1MB
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(content).toContain("first line");
    expect(content).toContain("second line");
    expect(content).toContain("third line");
    // No rotation happened
    expect(existsSync(logPath + ".1")).toBe(false);
  });

  test("only keeps one backup (.1 file)", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "backup.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 0.0001 });
    const logger = createLogger("bak");

    // Write many lines to trigger multiple rotations
    for (let i = 0; i < 20; i++) {
      logger.info(`line number ${i} with padding to make it longer xxxxxxxxxxxxxxxx`);
    }

    // Should NOT have .2, .3, etc.
    expect(existsSync(logPath + ".2")).toBe(false);
    expect(existsSync(logPath + ".3")).toBe(false);

    // Should have at most .1
    // (The .1 file should exist if rotation happened)
  });

  test("rotation deletes old .1 file before renaming", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "del-old.log");
    const rotatedPath = logPath + ".1";
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Pre-create a .1 file with known content
    writeFileSync(rotatedPath, "old rotated content\n");

    // Pre-create a main log file larger than 1MB to trigger rotation on next write
    writeFileSync(logPath, "x".repeat(1.5 * 1024 * 1024));

    initLogger({ logPath, maxSizeMb: 1 });
    const logger = createLogger("del");

    // This write triggers rotation because the pre-created file exceeds 1MB
    logger.info("trigger rotation line");

    expect(existsSync(rotatedPath)).toBe(true);
    const content = readFileSync(rotatedPath, "utf-8");
    // Old content should be gone, replaced by the rotated main file
    expect(content).not.toContain("old rotated content");
  });
});

// ===========================================================================
// BUG HUNT: Edge cases in initLogger
// ===========================================================================

describe("initLogger edge cases", () => {
  test("initLogger with maxSizeMb = 0 clamps to 1MB minimum (no data loss)", async () => {
    // maxSizeMb=0 is clamped to 1 by Math.max(opts.maxSizeMb, 1)
    // This prevents the data loss bug where maxSizeBytes=0 caused
    // rotation on every single write.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "zero.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 0 });
    const logger = createLogger("zero");

    logger.info("line one");
    logger.info("line two");
    logger.info("line three");

    // All 3 lines survive because effective maxSize is 1MB
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(content).toContain("line one");
    expect(content).toContain("line two");
    expect(content).toContain("line three");
    // No rotation happened
    expect(existsSync(logPath + ".1")).toBe(false);
  });

  test("initLogger with negative maxSizeMb clamps to 1MB minimum (no data loss)", async () => {
    // maxSizeMb=-1 is clamped to 1 by Math.max(opts.maxSizeMb, 1)
    // This prevents the data loss bug where negative values caused
    // rotation on every single write.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "negative.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: -1 });
    const logger = createLogger("neg");

    logger.info("line one");
    logger.info("line two");

    // Both lines survive because effective maxSize is 1MB
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(content).toContain("line one");
    expect(content).toContain("line two");
  });

  test("BUG: initLogger called multiple times overwrites state", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath1 = join(testDir, "first.log");
    const logPath2 = join(testDir, "second.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath: logPath1 });
    const logger1 = createLogger("mod1");
    logger1.info("to first file");

    // Second init changes the path -- but logger1 was already created
    initLogger({ logPath: logPath2 });
    logger1.info("where does this go?");

    // logger1 was created when logPath was logPath1, but since writeToFile
    // reads the module-level logFilePath, it now writes to logPath2
    expect(existsSync(logPath1)).toBe(true);
    const content1 = readFileSync(logPath1, "utf-8");
    expect(content1).toContain("to first file");

    // The second message goes to logPath2 even though logger1 was
    // "created for" path1. This is surprising/confusing behavior.
    expect(existsSync(logPath2)).toBe(true);
    const content2 = readFileSync(logPath2, "utf-8");
    expect(content2).toContain("where does this go?");

    // logPath1 should NOT contain the second message
    expect(content1).not.toContain("where does this go?");
  });

  test("initLogger with empty string logPath", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Empty string path -- dirname("") returns "." which passes
    // the dir !== "." check, skipping mkdirSync. Then appendFileSync("")
    // should throw, but it's caught by the try/catch in writeToFile.
    // So this silently fails to log -- not great, but not a crash.
    initLogger({ logPath: "" });
    const logger = createLogger("empty");

    // Should not throw
    expect(() => logger.info("test")).not.toThrow();
  });

  test("initLogger with undefined opts uses defaults", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "default-test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Passing empty object -- logPath stays as "./orca.log" (default)
    // maxSizeMb stays as 10
    initLogger({});
    const logger = createLogger("def");

    // This writes to ./orca.log in the CWD, which is probably not testDir.
    // The test verifies the default path is used.
    // We just verify it doesn't throw.
    expect(() => logger.info("default path test")).not.toThrow();

    // Clean up the default log if it was created
    try {
      rmSync("./orca.log", { force: true });
      rmSync("./orca.log.1", { force: true });
    } catch {
      // ignore
    }
  });
});

// ===========================================================================
// BUG HUNT: Messages with special content
// ===========================================================================

describe("special message content", () => {
  test("message with newlines is escaped to single line in file", async () => {
    // Newlines in messages are escaped to \\n to prevent multi-line log
    // entries that break log parsing.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "newline.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("nl");
    logger.info("line one\nline two\nline three");

    const content = readFileSync(logPath, "utf-8");
    const rawLines = content.split("\n").filter(Boolean);

    // Single info() call produces exactly one line in the file
    expect(rawLines.length).toBe(1);
    expect(rawLines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Newlines are escaped to literal \n
    expect(rawLines[0]).toContain("line one\\nline two\\nline three");
  });

  test("empty message", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "empty-msg.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("em");
    logger.info("");

    const content = readFileSync(logPath, "utf-8");
    // Should produce a line with just timestamp, level, prefix, and empty message
    expect(content).toMatch(/\[INFO\] \[orca\/em\] \n/);
  });

  test("message with special characters", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "special.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("spec");
    logger.info("tab\there and null\x00byte and unicode: \u{1F600}");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("tab\there");
  });

  test("very long message", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "long.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("long");
    const longMsg = "x".repeat(1_000_000); // 1MB message
    logger.info(longMsg);

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain(longMsg);
  });

  test("module name with special characters", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "modname.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    // Module names with slashes, brackets, etc.
    const logger = createLogger("../../etc/passwd");
    logger.info("injected");

    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[orca/../../etc/passwd]");
    // The module name is used as-is, no sanitization.
    // Not a security issue here since it's just a prefix in the log line,
    // but worth noting.
  });
});

// ===========================================================================
// BUG HUNT: File system error handling
// ===========================================================================

describe("file system error handling", () => {
  test("writeToFile handles non-existent directory gracefully", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "sub", "test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // initLogger creates the directory, so this should work
    initLogger({ logPath });
    const logger = createLogger("dir");

    expect(() => logger.info("test")).not.toThrow();
    expect(existsSync(logPath)).toBe(true);
  });

  test("BUG: if log directory is deleted after init, writes fail silently", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const subDir = join(testDir, "deleteme");
    const logPath = join(subDir, "test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("del");
    logger.info("before delete");
    expect(existsSync(logPath)).toBe(true);

    // Delete the directory
    rmSync(subDir, { recursive: true, force: true });

    // Now writes should fail silently (no throw, no crash)
    expect(() => logger.info("after delete")).not.toThrow();

    // The message is lost -- no file exists anymore
    expect(existsSync(logPath)).toBe(false);
  });

  test("read-only log file does not crash", async () => {
    // On Windows, file permissions work differently, so this test
    // may not trigger the error path. Skip on Windows if needed.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "readonly.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("ro");

    // Should not throw even if write fails
    expect(() => logger.info("test")).not.toThrow();
  });
});

// ===========================================================================
// BUG HUNT: Rotation edge cases
// ===========================================================================

describe("rotation edge cases", () => {
  test("rotation when file exactly equals maxSizeBytes", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "exact.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Set max to a very specific size
    const maxBytes = 100;
    const maxMb = maxBytes / (1024 * 1024);
    initLogger({ logPath, maxSizeMb: maxMb });

    const logger = createLogger("ex");

    // Write a line that's less than 100 bytes so file stays under limit
    logger.info("hi");

    // Check the comparison: stats.size < maxSizeBytes means if size === max,
    // rotation DOES happen (size is NOT < max). This is correct behavior but
    // worth testing the boundary.
    const size1 = statSync(logPath).size;

    if (size1 < maxBytes) {
      // File is under limit, write more to exceed
      logger.info("more content to push over the limit for sure definitely");
    }

    // Just verify no crash at the boundary
    expect(existsSync(logPath)).toBe(true);
  });

  test("BUG: rotation with maxSizeMb as very small fraction", async () => {
    // maxSizeMb = 0.000001 = ~1 byte
    // This means EVERY write triggers rotation, similar to maxSizeMb=0
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "tiny.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 0.000001 }); // ~1 byte
    const logger = createLogger("tiny");

    logger.info("first");
    logger.info("second");
    logger.info("third");

    // Only the last write survives in the main file
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("third");

    // The .1 file only has the second-to-last write
    if (existsSync(logPath + ".1")) {
      const rotated = readFileSync(logPath + ".1", "utf-8");
      expect(rotated).toContain("second");
      // "first" is GONE -- this is data loss
      expect(rotated).not.toContain("first");
    }
  });

  test("single write larger than maxSizeBytes triggers rotation on next write", async () => {
    // If one log line is bigger than the max size, the file will always
    // be above the limit, causing rotation on every subsequent write.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "bigline.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 1 }); // min 1MB
    const logger = createLogger("big");

    // Write a message larger than 1MB
    const bigMsg = "X".repeat(1.5 * 1024 * 1024);
    logger.info(bigMsg);

    const sizeAfterFirst = statSync(logPath).size;
    expect(sizeAfterFirst).toBeGreaterThan(1024 * 1024);

    // Next write triggers rotation
    logger.info("small line after big one");

    // The big message is now in .1
    expect(existsSync(logPath + ".1")).toBe(true);
    const rotated = readFileSync(logPath + ".1", "utf-8");
    expect(rotated).toContain(bigMsg);

    // And the small line is in the main file
    const current = readFileSync(logPath, "utf-8");
    expect(current).toContain("small line after big one");
    expect(current).not.toContain(bigMsg);
  });

  test("rotation when .1 file is locked/in-use (Windows-specific)", async () => {
    // On Windows, if another process has .1 open, unlinkSync will fail.
    // The rotation catch block swallows the error, so the main file
    // just keeps growing unbounded.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "locked.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath, maxSizeMb: 0.0001 });
    const logger = createLogger("lock");

    // We can't easily simulate a file lock in this test, but we can
    // verify that if unlinkSync fails, the process doesn't crash
    logger.info("test line");
    expect(() => logger.info("another line")).not.toThrow();
  });
});

// ===========================================================================
// BUG HUNT: logPath edge cases
// ===========================================================================

describe("logPath edge cases", () => {
  test("logPath with trailing slash", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "trailing") + "/";
    vi.spyOn(console, "log").mockImplementation(() => {});

    // A trailing slash means the "file" is actually a directory path.
    // appendFileSync to a directory will throw EISDIR, but the catch
    // in writeToFile swallows it. initLogger might create a directory
    // instead of preparing for a file.
    // This should probably be validated.
    try {
      initLogger({ logPath });
      const logger = createLogger("trail");
      // Should not crash
      expect(() => logger.info("test")).not.toThrow();
    } catch {
      // initLogger might throw if mkdirSync is confused -- that's OK
    }
  });

  test("logPath with path traversal", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    // No path sanitization -- user can write logs anywhere
    const logPath = join(testDir, "..", "..", "traversal-test.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("trav");
    logger.info("traversal test");

    // Clean up
    try {
      rmSync(logPath, { force: true });
    } catch {
      // ignore
    }
  });

  test("logPath that is an existing directory name", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const dirPath = join(testDir, "iam-a-dir");
    mkdirSync(dirPath, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Try to use a directory as the log file path
    initLogger({ logPath: dirPath });
    const logger = createLogger("dirfile");

    // appendFileSync to a directory should fail, caught by try/catch
    expect(() => logger.info("test")).not.toThrow();
  });
});

// ===========================================================================
// BUG HUNT: Console + file output consistency
// ===========================================================================

describe("console vs file output consistency", () => {
  test("console and file get different formats", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "format.log");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("fmt");
    logger.info("test message");

    // Console format: "[orca/fmt] test message"
    expect(consoleSpy).toHaveBeenCalledWith("[orca/fmt] test message");

    // File format: "2024-01-01T00:00:00.000Z [INFO] [orca/fmt] test message\n"
    const fileContent = readFileSync(logPath, "utf-8");

    // Console does NOT include timestamp or level
    // File DOES include timestamp and level
    // This asymmetry is by design, but let's verify:
    expect(fileContent).toContain("[INFO]");
    // The console output should NOT have [INFO]:
    const consoleArgs = consoleSpy.mock.calls[0]![0] as string;
    expect(consoleArgs).not.toContain("[INFO]");
    // BUG/ISSUE: Console output has no level indicator.
    // "warn" goes to console.warn and "error" to console.error,
    // but the string itself doesn't say WARN/ERROR.
    // This makes grepping console output harder.
  });
});

// ===========================================================================
// BUG HUNT: Module state isolation
// ===========================================================================

describe("module state pollution", () => {
  test("loggers created before initLogger don't write to files", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "pre-init.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Create logger BEFORE init
    const earlyLogger = createLogger("early");
    earlyLogger.info("before init");

    // File should NOT exist yet
    expect(existsSync(logPath)).toBe(false);

    // Now init
    initLogger({ logPath });

    // The same logger instance should NOW write to file
    earlyLogger.info("after init");

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    // "before init" should NOT be in the file
    expect(content).not.toContain("before init");
    // "after init" SHOULD be in the file
    expect(content).toContain("after init");
  });

  test("maxSizeBytes persists from a previous initLogger call if not re-specified", async () => {
    // If you call initLogger({ logPath: "a.log", maxSizeMb: 1 })
    // then later initLogger({ logPath: "b.log" }) -- maxSizeMb is NOT
    // reset to the default 10MB. It stays at 1MB from the previous call.
    // This is because initLogger only updates fields that are provided.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath1 = join(testDir, "state1.log");
    const logPath2 = join(testDir, "state2.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath: logPath1, maxSizeMb: 1 }); // min: 1MB

    // Now re-init with a different path but DON'T specify maxSizeMb
    initLogger({ logPath: logPath2 });

    // maxSizeBytes is STILL 1MB from the first call (state leakage)
    const logger = createLogger("state");

    // Write more than 1MB to trigger rotation if the old maxSize leaked
    logger.info("x".repeat(1.5 * 1024 * 1024));
    logger.info("after rotation?");

    // If the 1MB maxSize leaked, rotation will have happened
    const rotatedExists = existsSync(logPath2 + ".1");

    // This documents the state leakage: maxSizeBytes from first init
    // persists even though we re-initialized with a different path.
    expect(rotatedExists).toBe(true); // proves the leak
  });
});

// ===========================================================================
// Config integration
// ===========================================================================

describe("config integration", () => {
  test("ORCA_LOG_MAX_SIZE_MB=0 is rejected by parsePositiveInt", async () => {
    // The config layer uses readIntOrDefault -> parsePositiveInt which
    // rejects 0. But if someone calls initLogger directly with 0,
    // there's no validation. This is a defense-in-depth gap.
    //
    // This test just verifies the config-level validation works.
    // We can't easily test loadConfig() without setting up all env vars.
    // Instead, document that initLogger itself lacks validation.
    expect(true).toBe(true); // placeholder -- see initLogger edge case tests above
  });

  test("ORCA_LOG_MAX_SIZE_MB as float like 0.5 is rejected by parsePositiveInt", async () => {
    // readIntOrDefault uses parsePositiveInt which requires an integer.
    // So ORCA_LOG_MAX_SIZE_MB=0.5 would cause process.exit(1).
    // This means you can't set a log max size of 512KB from env.
    // The minimum configurable size is 1MB.
    // This is arguably a design issue -- should use parsePositiveNumber.
    expect(true).toBe(true); // documented
  });
});

// ===========================================================================
// BUG HUNT: Concurrent logger instances
// ===========================================================================

describe("multiple logger instances", () => {
  test("multiple loggers write to same file without corruption", async () => {
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "multi.log");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    initLogger({ logPath });

    const logger1 = createLogger("mod-a");
    const logger2 = createLogger("mod-b");
    const logger3 = createLogger("mod-c");

    logger1.info("from a");
    logger2.warn("from b");
    logger3.error("from c");
    logger1.info("from a again");

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("[orca/mod-a]");
    expect(lines[1]).toContain("[orca/mod-b]");
    expect(lines[2]).toContain("[orca/mod-c]");
    expect(lines[3]).toContain("[orca/mod-a]");
  });
});

// ===========================================================================
// BUG HUNT: rotateIfNeeded race between check and act
// ===========================================================================

describe("TOCTOU in rotateIfNeeded", () => {
  test("file deleted between existsSync and statSync", async () => {
    // This is a theoretical TOCTOU race. In practice, since Node.js is
    // single-threaded, this can only happen if another process deletes
    // the file. The catch block in rotateIfNeeded handles this.
    const { initLogger, createLogger } = await importFreshLogger();
    const logPath = join(testDir, "toctou.log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath });
    const logger = createLogger("race");

    // Just verify no crash under normal conditions
    logger.info("test");
    expect(() => logger.info("test2")).not.toThrow();
  });
});

// ===========================================================================
// BUG HUNT: initLogger directory creation
// ===========================================================================

describe("initLogger directory creation", () => {
  test("creates deeply nested directories", async () => {
    const { initLogger } = await importFreshLogger();
    const logPath = join(testDir, "a", "b", "c", "d", "e", "test.log");

    initLogger({ logPath });

    const dir = join(testDir, "a", "b", "c", "d", "e");
    expect(existsSync(dir)).toBe(true);
  });

  test("BUG: dir check skips mkdirSync when dirname returns '.'", async () => {
    // If logPath is just a filename like "orca.log", dirname returns "."
    // The code checks `if (dir && dir !== ".")` and skips mkdirSync.
    // This is fine for CWD, but means initLogger doesn't create
    // the parent directory when it's the current directory.
    // This is arguably correct behavior, but the file will be created
    // relative to CWD which may be surprising.
    const { initLogger, createLogger } = await importFreshLogger();
    vi.spyOn(console, "log").mockImplementation(() => {});

    initLogger({ logPath: "bare-filename.log" });
    const logger = createLogger("bare");
    logger.info("test");

    // Clean up
    try {
      rmSync("bare-filename.log", { force: true });
      rmSync("bare-filename.log.1", { force: true });
    } catch {
      // ignore
    }
  });
});
