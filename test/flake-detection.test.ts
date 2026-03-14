// ---------------------------------------------------------------------------
// Unit tests for CI flake detection functions in src/github/index.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/git.js", () => ({
  git: vi.fn(),
  isTransientGitError: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
  getFailingChecksForPr,
  getFailingChecksOnMain,
  retriggerPrChecks,
} from "../src/github/index.js";

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// getFailingChecksForPr
// ---------------------------------------------------------------------------

describe("getFailingChecksForPr", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns names of failing checks (bucket === fail)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "FAILURE", bucket: "fail" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
          { name: "build", state: "FAILURE", bucket: "fail" },
        ]),
        stderr: "",
      });
    });

    const result = await getFailingChecksForPr(42, "/tmp/repo");
    expect(result).toEqual(["test", "build"]);
  });

  test("returns empty array when no checks are failing", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, {
        stdout: JSON.stringify([
          { name: "test", state: "SUCCESS", bucket: "pass" },
          { name: "lint", state: "SUCCESS", bucket: "pass" },
        ]),
        stderr: "",
      });
    });

    const result = await getFailingChecksForPr(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when checks list is empty", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    const result = await getFailingChecksForPr(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array on gh CLI error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh: network error");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "network error";
      callback(err, null);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getFailingChecksForPr(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("logs warning on error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("connection refused");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "connection refused";
      callback(err, null);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await getFailingChecksForPr(7, "/tmp/repo");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("getFailingChecksForPr(#7)"),
    );
  });

  test("calls gh pr checks with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getFailingChecksForPr(99, "/tmp/repo");

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "checks", "99", "--json", "name,state,bucket"]);
    expect(opts.cwd).toBe("/tmp/repo");
  });
});

// ---------------------------------------------------------------------------
// getFailingChecksOnMain
// ---------------------------------------------------------------------------

describe("getFailingChecksOnMain", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns failing job names from most recent main failure", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        // gh run list response
        callback(null, {
          stdout: JSON.stringify([
            { databaseId: 1001, name: "CI" },
            { databaseId: 1000, name: "CI" },
          ]),
          stderr: "",
        });
      } else {
        // gh run view response
        callback(null, {
          stdout: JSON.stringify({
            jobs: [
              { name: "test", conclusion: "failure" },
              { name: "lint", conclusion: "success" },
              { name: "build", conclusion: "failure" },
            ],
          }),
          stderr: "",
        });
      }
    });

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual(["test", "build"]);
  });

  test("uses only the most recent (first) failed run", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        callback(null, {
          stdout: JSON.stringify([
            { databaseId: 9999, name: "CI" },
            { databaseId: 8888, name: "CI" },
          ]),
          stderr: "",
        });
      } else {
        // Should be called with the first run (9999), not the second
        const [, args] = execFileMock.mock.calls[1]!;
        expect(args).toContain("9999");
        callback(null, {
          stdout: JSON.stringify({
            jobs: [{ name: "e2e", conclusion: "failure" }],
          }),
          stderr: "",
        });
      }
    });

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual(["e2e"]);
    // Only 2 gh calls: run list + run view for most recent
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test("returns empty array when no failed runs on main", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when run has no failing jobs", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        callback(null, {
          stdout: JSON.stringify([{ databaseId: 5555, name: "CI" }]),
          stderr: "",
        });
      } else {
        callback(null, {
          stdout: JSON.stringify({
            jobs: [
              { name: "test", conclusion: "success" },
              { name: "lint", conclusion: "skipped" },
            ],
          }),
          stderr: "",
        });
      }
    });

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array on gh run list error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh: unauthorized");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "unauthorized";
      callback(err, null);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array on gh run view error", async () => {
    let callCount = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        callback(null, {
          stdout: JSON.stringify([{ databaseId: 1234, name: "CI" }]),
          stderr: "",
        });
      } else {
        const err = new Error("gh: run not found");
        (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
          "run not found";
        callback(err, null);
      }
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getFailingChecksOnMain("/tmp/repo");
    expect(result).toEqual([]);
  });

  test("logs warning on error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("timeout");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "timeout";
      callback(err, null);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await getFailingChecksOnMain("/tmp/repo");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("getFailingChecksOnMain"),
    );
  });

  test("calls gh run list with correct args", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: JSON.stringify([]), stderr: "" });
    });

    await getFailingChecksOnMain("/tmp/repo");

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "run",
      "list",
      "--branch",
      "main",
      "--status",
      "failure",
      "--json",
      "databaseId,name",
      "--limit",
      "5",
    ]);
    expect(opts.cwd).toBe("/tmp/repo");
  });
});

// ---------------------------------------------------------------------------
// retriggerPrChecks
// ---------------------------------------------------------------------------

describe("retriggerPrChecks", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns true on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    const result = await retriggerPrChecks(42, "/tmp/repo");
    expect(result).toBe(true);
  });

  test("returns false on gh CLI error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("gh: forbidden");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr = "forbidden";
      callback(err, null);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await retriggerPrChecks(42, "/tmp/repo");
    expect(result).toBe(false);
  });

  test("logs warning on error", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("not allowed");
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr =
        "not allowed";
      callback(err, null);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await retriggerPrChecks(7, "/tmp/repo");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("retriggerPrChecks(#7)"),
    );
  });

  test("calls gh pr checks with --rerun-failed flag and correct PR number", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    await retriggerPrChecks(55, "/tmp/repo");

    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "checks", "55", "--rerun-failed"]);
    expect(opts.cwd).toBe("/tmp/repo");
  });
});
