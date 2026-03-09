// ---------------------------------------------------------------------------
// ORCA_STATE_MAP env var parsing tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { loadConfig, VALID_ORCA_STATUSES, getStateMapOverrides } from "../src/config/index.js";

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Clear relevant env vars before each test
  delete process.env.ORCA_STATE_MAP;
  // Set required env vars so loadConfig() doesn't exit for other reasons
  process.env.ORCA_LINEAR_API_KEY = "test-key";
  process.env.ORCA_LINEAR_WEBHOOK_SECRET = "test-secret";
  process.env.ORCA_LINEAR_PROJECT_IDS = '["proj-1"]';
  process.env.ORCA_TUNNEL_HOSTNAME = "test.example.com";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ORCA_STATE_MAP;
  delete process.env.ORCA_LINEAR_API_KEY;
  delete process.env.ORCA_LINEAR_WEBHOOK_SECRET;
  delete process.env.ORCA_LINEAR_PROJECT_IDS;
  delete process.env.ORCA_TUNNEL_HOSTNAME;
});

describe("ORCA_STATE_MAP parsing", () => {
  test("unset env var → stateMapOverrides is undefined", () => {
    const config = loadConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.stateMapOverrides).toBeUndefined();
  });

  test("valid JSON with valid status values → stateMapOverrides is set correctly", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({
      Done: "done",
      "QA Review": "in_review",
      Backlog: "backlog",
    });
    const config = loadConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.stateMapOverrides).toEqual({
      Done: "done",
      "QA Review": "in_review",
      Backlog: "backlog",
    });
  });

  test("all valid orca statuses are accepted", () => {
    const map: Record<string, string> = {};
    for (const status of VALID_ORCA_STATUSES) {
      map[`State-${status}`] = status;
    }
    process.env.ORCA_STATE_MAP = JSON.stringify(map);
    const config = loadConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.stateMapOverrides).toEqual(map);
  });

  test("invalid JSON → process.exit(1) called with error message", () => {
    process.env.ORCA_STATE_MAP = "not valid json {";
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_STATE_MAP must be valid JSON"),
    );
  });

  test("invalid status value → process.exit(1) with bad value in message", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({ Done: "donee" });
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"donee"'),
    );
  });

  test("invalid status value error message includes the key", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({ "My State": "invalid" });
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"My State"'),
    );
  });

  test("non-object JSON (array) → process.exit(1)", () => {
    process.env.ORCA_STATE_MAP = '["done", "backlog"]';
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_STATE_MAP must be a JSON object"),
    );
  });

  test("null JSON value → process.exit(1)", () => {
    process.env.ORCA_STATE_MAP = "null";
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_STATE_MAP must be a JSON object"),
    );
  });

  test("getStateMapOverrides returns stateMapOverrides from config", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({ Done: "done" });
    const config = loadConfig();
    expect(getStateMapOverrides(config)).toEqual({ Done: "done" });
  });

  test("getStateMapOverrides returns undefined when not set", () => {
    const config = loadConfig();
    expect(getStateMapOverrides(config)).toBeUndefined();
  });

  test("empty object '{}' → stateMapOverrides is undefined (no effect)", () => {
    process.env.ORCA_STATE_MAP = "{}";
    const config = loadConfig();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.stateMapOverrides).toBeUndefined();
  });

  test("empty string key → process.exit(1) with error message", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({ "": "done" });
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("empty string key"),
    );
  });

  test("multiple invalid values → single exit with all errors listed", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({
      State1: "bad1",
      State2: "bad2",
    });
    loadConfig();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    const msg = (errorSpy.mock.calls[0] as string[])[0];
    expect(msg).toContain('"bad1"');
    expect(msg).toContain('"bad2"');
  });

  test("empty string env var → process.exit(1) with JSON parse error", () => {
    process.env.ORCA_STATE_MAP = "";
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ORCA_STATE_MAP must be valid JSON"),
    );
  });

  test("non-string value in object → process.exit(1) with type error message", () => {
    process.env.ORCA_STATE_MAP = JSON.stringify({ Done: 1, InProgress: null });
    loadConfig();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = (errorSpy.mock.calls[0] as string[])[0];
    expect(msg).toContain('"Done"');
    expect(msg).toContain("must be a string");
  });
});
