// ---------------------------------------------------------------------------
// CI rerun function tests — exercises the REAL getFailingWorkflowRunIds
// and rerunFailedWorkflowJobs implementations via execFile mocking.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: actual.execFileSync,
  };
});

import { execFile } from "node:child_process";

import {
  getFailingWorkflowRunIds,
  rerunFailedWorkflowJobs,
} from "../src/github/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecFileMock = ReturnType<typeof vi.fn>;

function mockGhSequence(responses: Array<string | Error>): void {
  const mock = execFile as unknown as ExecFileMock;
  let idx = 0;
  mock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error | null, result?: { stdout: string }) => void,
    ) => {
      const response = responses[idx++] ?? responses[responses.length - 1]!;
      if (response instanceof Error) {
        callback(response);
      } else {
        callback(null, { stdout: response });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// getFailingWorkflowRunIds
// ---------------------------------------------------------------------------

describe("getFailingWorkflowRunIds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("returns run IDs where conclusion is failure", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "abc123" }),
      JSON.stringify([
        { databaseId: 101, conclusion: "failure", status: "completed" },
        { databaseId: 102, conclusion: "success", status: "completed" },
      ]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([101]);
  });

  test("returns run IDs where conclusion is cancelled", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "abc123" }),
      JSON.stringify([
        { databaseId: 201, conclusion: "cancelled", status: "completed" },
        { databaseId: 202, conclusion: "success", status: "completed" },
      ]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([201]);
  });

  test("returns run IDs where conclusion is timed_out", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "abc123" }),
      JSON.stringify([
        { databaseId: 301, conclusion: "timed_out", status: "completed" },
        { databaseId: 302, conclusion: "success", status: "completed" },
      ]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([301]);
  });

  test("handles multiple mixed conclusions: failure+cancelled+timed_out+success — only failed ones returned", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "deadbeef" }),
      JSON.stringify([
        { databaseId: 101, conclusion: "failure", status: "completed" },
        { databaseId: 102, conclusion: "cancelled", status: "completed" },
        { databaseId: 103, conclusion: "timed_out", status: "completed" },
        { databaseId: 104, conclusion: "success", status: "completed" },
      ]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([101, 102, 103]);
    expect(result).not.toContain(104);
  });

  test("excludes runs with success conclusion", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "abc123" }),
      JSON.stringify([
        { databaseId: 501, conclusion: "success", status: "completed" },
        { databaseId: 502, conclusion: "success", status: "completed" },
      ]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when no matching runs", async () => {
    mockGhSequence([
      JSON.stringify({ headRefOid: "abc123" }),
      JSON.stringify([]),
    ]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when gh pr view fails", async () => {
    mockGhSequence([new Error("gh: command failed")]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array when headRefOid is missing from response", async () => {
    mockGhSequence([JSON.stringify({})]);

    const result = await getFailingWorkflowRunIds(42, "/tmp/repo");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rerunFailedWorkflowJobs
// ---------------------------------------------------------------------------

describe("rerunFailedWorkflowJobs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("returns true when gh run rerun succeeds", async () => {
    mockGhSequence([""]);

    const result = await rerunFailedWorkflowJobs(101, "/tmp/repo");
    expect(result).toBe(true);
  });

  test("returns false when gh run rerun throws an error", async () => {
    mockGhSequence([new Error("gh: HTTP 422 Unprocessable Entity")]);

    const result = await rerunFailedWorkflowJobs(101, "/tmp/repo");
    expect(result).toBe(false);
  });

  test("calls gh with correct args: run rerun <runId> --failed", async () => {
    const mock = execFile as unknown as ExecFileMock;
    mock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (err: Error | null, result?: { stdout: string }) => void,
      ) => {
        callback(null, { stdout: "" });
      },
    );

    await rerunFailedWorkflowJobs(101, "/tmp/repo");

    expect(mock).toHaveBeenCalledOnce();
    const [cmd, args] = mock.mock.calls[0] as [
      string,
      string[],
      unknown,
      unknown,
    ];
    expect(cmd).toBe("gh");
    expect(args).toEqual(["run", "rerun", "101", "--failed"]);
  });
});
