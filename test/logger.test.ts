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

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
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
import { initFileLogger } from "../src/logger.js";

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
    const timestampMatches = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g);
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
    const timestampMatches = content.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g);
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
  test("OrcaConfig type has logPath and logMaxSizeMb", async () => {
    // Import OrcaConfig — if the fields are missing the TypeScript compile
    // would already fail (tsc --noEmit). This test simply verifies the
    // fields appear in the real loadConfig output shape by checking defaults.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/config/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("logPath:");
    expect(source).toContain("logMaxSizeMb:");
    expect(source).toContain("ORCA_LOG_PATH");
    expect(source).toContain("ORCA_LOG_MAX_SIZE_MB");
  });
});

// ---------------------------------------------------------------------------
// 11. cli/index.ts: initFileLogger is called before first console.log output
// ---------------------------------------------------------------------------

describe("initFileLogger call order in CLI", () => {
  test("initFileLogger called before first console.log in start command", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/cli/index.ts", import.meta.url),
      "utf8",
    );

    const initPos = source.indexOf("initFileLogger(");
    const firstConsoleLog = source.indexOf("console.log(", source.indexOf(".action(async"));

    expect(initPos).toBeGreaterThan(-1);
    expect(firstConsoleLog).toBeGreaterThan(-1);

    // initFileLogger must appear BEFORE the first console.log inside the start action
    expect(initPos).toBeLessThan(firstConsoleLog);
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
  test("ci-gate.test.ts testConfig is missing logPath and logMaxSizeMb fields", async () => {
    // Read the test file source to check if testConfig includes the new fields
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./ci-gate.test.ts", import.meta.url),
      "utf8",
    );

    // If these fields are absent from testConfig, TypeScript should have caught it —
    // but the tsconfig only covers src/, not test/ files.
    // This test documents the gap.
    const hasLogPath = source.includes("logPath:");
    const hasLogMaxSizeMb = source.includes("logMaxSizeMb:");

    // Currently FAILING: testConfig does not include logPath or logMaxSizeMb
    expect(hasLogPath).toBe(true);
    expect(hasLogMaxSizeMb).toBe(true);
  });
});
