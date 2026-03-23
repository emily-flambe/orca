// ---------------------------------------------------------------------------
// Adversarial tests for createLogger in src/logger.ts
// ---------------------------------------------------------------------------
//
// These tests attack the structured JSON logging added in EMI-338.
// Target bugs:
//   1. Error object as last arg swallowed as fields (extractFields bug)
//   2. Object-only call: log.info(someObject) — treated as fields, message=""
//   3. child() should not mutate parent's baseFields
//   4. Human-readable mode silently drops the fields object
//   5. LOG_FORMAT=json produces valid JSON with all required keys
//   6. log.warn/error use console.warn/console.error (not console.log)
//   7. LOG_LEVEL filtering works correctly
//   8. Multiple extra args serialized in message
//   9. null/undefined in args don't throw
//  10. child() merges baseFields into every entry, not just the first call

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withJsonMode(fn: () => void): void {
  const orig = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  try {
    fn();
  } finally {
    if (orig === undefined) {
      delete process.env.LOG_FORMAT;
    } else {
      process.env.LOG_FORMAT = orig;
    }
  }
}

function withHumanMode(fn: () => void): void {
  const orig = process.env.LOG_FORMAT;
  delete process.env.LOG_FORMAT;
  try {
    fn();
  } finally {
    if (orig !== undefined) process.env.LOG_FORMAT = orig;
  }
}

// ---------------------------------------------------------------------------
// 1. Error as last arg: should NOT be swallowed as fields
// ---------------------------------------------------------------------------

describe("Error object handling", () => {
  test("Error as last arg appears in message, not silently dropped", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      const err = new Error("boom");
      log.info("something broke", err);

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      // The error should appear in message or as a field — NOT silently swallowed
      const messageHasError =
        String(entry.message).includes("boom") ||
        String(entry.message).includes("Error");
      expect(messageHasError).toBe(true);
    });
  });

  test("Error as ONLY arg: message should not be empty string", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      const err = new Error("standalone error");
      log.info(err);

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      // An Error as only arg should produce a non-empty message
      expect(entry.message).not.toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Object-only call: log.info(someObject) → object becomes fields, message=""
//    This is a design ambiguity — document the actual behavior as a bug if
//    message="" because the caller likely wanted the object as the message.
// ---------------------------------------------------------------------------

describe("Object-only call", () => {
  test("log.info(plainObject) produces empty message string (design flaw)", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info({ taskId: "abc", status: "running" });

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      // BUG: message is "" because the object was consumed as fields
      // A caller doing log.info(someObject) expects to see the object in output
      // but instead gets message="" with the object merged as top-level fields
      expect(entry.message).toBe(""); // documents the current (broken) behavior
      // Also verify the fields were actually extracted
      expect(entry.taskId).toBe("abc");
    });
  });

  test("human mode: log.info(plainObject) includes the object in output", () => {
    withHumanMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info({ taskId: "abc", status: "running" });

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const output = captured[0]!;
      // Human mode serializes plain objects via JSON.stringify so they appear in output.
      expect(output).toContain("abc");
      expect(output).toContain("running");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. child() must not mutate parent's baseFields
// ---------------------------------------------------------------------------

describe("child() immutability", () => {
  test("child() does not mutate parent logger baseFields", () => {
    withJsonMode(() => {
      const parentCaptured: string[] = [];
      const childCaptured: string[] = [];

      const log = createLogger("test");
      const child = log.child({ childField: "child-value" });

      // Capture parent output AFTER creating child
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        parentCaptured.push(args[0] as string);
      });

      log.info("parent message");
      spy.mockRestore();

      const spy2 = vi.spyOn(console, "log").mockImplementation((...args) => {
        childCaptured.push(args[0] as string);
      });
      child.info("child message");
      spy2.mockRestore();

      const parentEntry = JSON.parse(parentCaptured[0]!) as Record<
        string,
        unknown
      >;
      const childEntry = JSON.parse(childCaptured[0]!) as Record<
        string,
        unknown
      >;

      // Parent should NOT have childField
      expect(parentEntry.childField).toBeUndefined();
      // Child MUST have childField
      expect(childEntry.childField).toBe("child-value");
    });
  });

  test("multiple child() calls do not cross-contaminate each other", () => {
    withJsonMode(() => {
      const log = createLogger("test");
      const child1 = log.child({ requestId: "req-1" });
      const child2 = log.child({ requestId: "req-2" });

      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      child1.info("from child1");
      child2.info("from child2");

      spy.mockRestore();

      const entry1 = JSON.parse(captured[0]!) as Record<string, unknown>;
      const entry2 = JSON.parse(captured[1]!) as Record<string, unknown>;

      expect(entry1.requestId).toBe("req-1");
      expect(entry2.requestId).toBe("req-2");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. JSON mode: all required keys present
// ---------------------------------------------------------------------------

describe("JSON mode output structure", () => {
  test("LOG_FORMAT=json produces timestamp, level, module, message fields", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("mymod");
      log.info("hello world");

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;

      expect(typeof entry.timestamp).toBe("string");
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(entry.level).toBe("info");
      expect(entry.module).toBe("orca/mymod");
      expect(entry.message).toBe("hello world");
    });
  });

  test("LOG_FORMAT=json: each line is valid JSON (not pretty-printed)", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("single line");

      spy.mockRestore();

      // Must not contain newlines within the single entry
      expect(captured[0]).not.toContain("\n");
      // Must be valid JSON
      expect(() => JSON.parse(captured[0]!)).not.toThrow();
    });
  });

  test("inline fields appear in JSON output", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("task dispatched", { taskId: "task-123", phase: "implement" });

      spy.mockRestore();

      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.taskId).toBe("task-123");
      expect(entry.phase).toBe("implement");
      expect(entry.message).toBe("task dispatched");
    });
  });

  test("child baseFields merged into every entry", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      const child = log.child({ taskId: "t-1", workflowId: "wf-1" });

      child.info("first message");
      child.info("second message");

      spy.mockRestore();

      expect(captured.length).toBe(2);
      for (const line of captured) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(entry.taskId).toBe("t-1");
        expect(entry.workflowId).toBe("wf-1");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 5. warn/error use console.warn/console.error, not console.log
// ---------------------------------------------------------------------------

describe("log level routing to correct console method", () => {
  test("log.warn uses console.warn in JSON mode", () => {
    withJsonMode(() => {
      const warnCaptured: string[] = [];
      const logCaptured: string[] = [];

      const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
        warnCaptured.push(args[0] as string);
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logCaptured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.warn("watch out");

      warnSpy.mockRestore();
      logSpy.mockRestore();

      expect(warnCaptured.length).toBe(1);
      expect(logCaptured.length).toBe(0);
    });
  });

  test("log.error uses console.error in JSON mode", () => {
    withJsonMode(() => {
      const errorCaptured: string[] = [];
      const logCaptured: string[] = [];

      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation((...args) => {
          errorCaptured.push(args[0] as string);
        });
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logCaptured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.error("something failed");

      errorSpy.mockRestore();
      logSpy.mockRestore();

      expect(errorCaptured.length).toBe(1);
      expect(logCaptured.length).toBe(0);
    });
  });

  test("log.info uses console.log (not console.error or console.warn)", () => {
    withJsonMode(() => {
      const logCaptured: string[] = [];
      const warnCaptured: string[] = [];
      const errorCaptured: string[] = [];

      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        logCaptured.push(args[0] as string);
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
        warnCaptured.push(args[0] as string);
      });
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation((...args) => {
          errorCaptured.push(args[0] as string);
        });

      const log = createLogger("test");
      log.info("info message");

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();

      expect(logCaptured.length).toBe(1);
      expect(warnCaptured.length).toBe(0);
      expect(errorCaptured.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Human-readable format: no JSON when LOG_FORMAT is not set
// ---------------------------------------------------------------------------

describe("human-readable format", () => {
  test("human mode output is NOT valid JSON", () => {
    withHumanMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("hello human");

      spy.mockRestore();

      expect(captured.length).toBe(1);
      let parsedOk = false;
      try {
        JSON.parse(captured[0]!);
        parsedOk = true;
      } catch {
        parsedOk = false;
      }
      expect(parsedOk).toBe(false);
    });
  });

  test("human mode output contains module tag", () => {
    withHumanMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("mymodule");
      log.info("test msg");

      spy.mockRestore();

      expect(captured[0]).toContain("[orca/mymodule]");
      expect(captured[0]).toContain("test msg");
    });
  });

  test("human mode output contains INFO level label", () => {
    withHumanMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("level check");

      spy.mockRestore();

      expect(captured[0]).toContain("[INFO]");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. LOG_LEVEL filtering
// ---------------------------------------------------------------------------

describe("LOG_LEVEL filtering", () => {
  test("debug messages suppressed when LOG_LEVEL=info (default)", () => {
    withJsonMode(() => {
      const origLevel = process.env.LOG_LEVEL;
      delete process.env.LOG_LEVEL;

      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.debug("secret debug");

      spy.mockRestore();
      if (origLevel !== undefined) process.env.LOG_LEVEL = origLevel;

      expect(captured.length).toBe(0);
    });
  });

  test("debug messages emitted when LOG_LEVEL=debug", () => {
    withJsonMode(() => {
      const origLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "debug";

      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.debug("debug visible");

      spy.mockRestore();
      if (origLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = origLevel;
      }

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.level).toBe("debug");
    });
  });

  test("unknown LOG_LEVEL falls back to info", () => {
    withJsonMode(() => {
      const origLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "BOGUS_LEVEL";

      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.debug("should be filtered");
      log.info("should appear");

      spy.mockRestore();
      if (origLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = origLevel;
      }

      expect(captured.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Edge: null and undefined args do not throw
// ---------------------------------------------------------------------------

describe("null/undefined argument handling", () => {
  test("log.info(null) does not throw", () => {
    withJsonMode(() => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const log = createLogger("test");
      expect(() => log.info(null)).not.toThrow();
      spy.mockRestore();
    });
  });

  test("log.info(undefined) does not throw", () => {
    withJsonMode(() => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const log = createLogger("test");
      expect(() => log.info(undefined)).not.toThrow();
      spy.mockRestore();
    });
  });

  test("log.info() with no args does not throw", () => {
    withJsonMode(() => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      const log = createLogger("test");
      expect(() => log.info()).not.toThrow();
      spy.mockRestore();
    });
  });

  test("log.info() with no args produces empty message", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info();

      spy.mockRestore();

      expect(captured.length).toBe(1);
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.message).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Multiple non-object args serialized in message
// ---------------------------------------------------------------------------

describe("multiple args in message", () => {
  test("multiple string args joined with space", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("part1", "part2", "part3");

      spy.mockRestore();

      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.message).toBe("part1 part2 part3");
    });
  });

  test("number/boolean args serialized in message", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("count:", 42, "active:", true);

      spy.mockRestore();

      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.message).toBe("count: 42 active: true");
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Array as last arg: should NOT be treated as fields
// ---------------------------------------------------------------------------

describe("Array as last arg", () => {
  test("array as last arg appears in message, not consumed as fields", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      const arr = ["a", "b", "c"];
      log.info("items:", arr);

      spy.mockRestore();

      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      // Arrays are NOT fields, they should appear in message
      expect(entry.message).toContain("a");
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Inline fields do not override reserved keys (timestamp, level, module)
// ---------------------------------------------------------------------------

describe("reserved key protection", () => {
  test("inline fields cannot override 'level' key", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      // Attempt to override level via inline fields
      log.info("spoofed", { level: "error" });

      spy.mockRestore();

      // Reserved keys (timestamp, level, module, message) are placed after all spreads
      // in the object literal, so caller fields cannot override them.
      // This test verifies this protection is working correctly.
      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      expect(entry.level).toBe("info");
    });
  });

  test("inline fields cannot override 'timestamp' key", () => {
    withJsonMode(() => {
      const captured: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args[0] as string);
      });

      const log = createLogger("test");
      log.info("test", { timestamp: "fake-time" });

      spy.mockRestore();

      const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
      // Reserved keys (timestamp, level, module, message) are placed after all spreads,
      // so caller fields cannot override them. Timestamp should be a real ISO string.
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
