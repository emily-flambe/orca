import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: actual.execFileSync,
  };
});

import { execFile } from "node:child_process";
import { isCiFlakeOnMain, getFailingCheckNames } from "../src/github/index.js";

function mockExecFile(stdout: string): void {
  const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
  mockFn.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string }) => void,
    ) => {
      callback(null, { stdout });
    },
  );
}

function mockExecFileError(message: string): void {
  const mockFn = execFile as unknown as ReturnType<typeof vi.fn>;
  mockFn.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error) => void,
    ) => {
      callback(new Error(message));
    },
  );
}

describe("isCiFlakeOnMain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns false when failingCheckNames is empty", async () => {
    const result = await isCiFlakeOnMain([], "/tmp/repo");
    expect(result).toBe(false);
  });

  test("returns false when no recent main failures", async () => {
    mockExecFile(
      JSON.stringify([
        { name: "CI", conclusion: "success" },
        { name: "CI", conclusion: "success" },
      ]),
    );
    const result = await isCiFlakeOnMain(["CI / test"], "/tmp/repo");
    expect(result).toBe(false);
  });

  test("returns true when workflow name matches failing main workflow", async () => {
    mockExecFile(
      JSON.stringify([
        { name: "CI", conclusion: "failure" },
        { name: "Deploy", conclusion: "success" },
      ]),
    );
    const result = await isCiFlakeOnMain(["CI / test"], "/tmp/repo");
    expect(result).toBe(true);
  });

  test("returns true when check name exactly matches failing main workflow", async () => {
    mockExecFile(JSON.stringify([{ name: "test", conclusion: "failure" }]));
    const result = await isCiFlakeOnMain(["test"], "/tmp/repo");
    expect(result).toBe(true);
  });

  test("returns false when different workflow names", async () => {
    mockExecFile(
      JSON.stringify([{ name: "Deploy", conclusion: "failure" }]),
    );
    const result = await isCiFlakeOnMain(["CI / test", "CI / lint"], "/tmp/repo");
    expect(result).toBe(false);
  });

  test("returns false on gh CLI error (conservative)", async () => {
    mockExecFileError("command not found: gh");
    const result = await isCiFlakeOnMain(["CI / test"], "/tmp/repo");
    expect(result).toBe(false);
  });

  test("returns true when multiple failing checks, one matches main", async () => {
    mockExecFile(JSON.stringify([{ name: "CI", conclusion: "failure" }]));
    const result = await isCiFlakeOnMain(
      ["Frontend / build", "CI / test"],
      "/tmp/repo",
    );
    expect(result).toBe(true);
  });

  test("returns false when main has failures but different workflow", async () => {
    mockExecFile(JSON.stringify([{ name: "Nightly", conclusion: "failure" }]));
    const result = await isCiFlakeOnMain(["CI / test"], "/tmp/repo");
    expect(result).toBe(false);
  });
});

describe("getFailingCheckNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns names of failing checks", async () => {
    mockExecFile(
      JSON.stringify([
        { name: "test", state: "FAILURE", bucket: "fail" },
        { name: "lint", state: "SUCCESS", bucket: "pass" },
        { name: "build", state: "FAILURE", bucket: "fail" },
      ]),
    );
    const result = await getFailingCheckNames(42, "/tmp/repo");
    expect(result).toEqual(["test", "build"]);
  });

  test("returns empty array when no checks fail", async () => {
    mockExecFile(
      JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
    );
    const result = await getFailingCheckNames(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array on error", async () => {
    mockExecFileError("gh: command not found");
    const result = await getFailingCheckNames(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when checks is empty", async () => {
    mockExecFile(JSON.stringify([]));
    const result = await getFailingCheckNames(42, "/tmp/repo");
    expect(result).toEqual([]);
  });
});
