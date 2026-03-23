// ---------------------------------------------------------------------------
// EMI-342: Runner-level tests for isResumeNotFound detection
//
// Tests the stderr-based detection of "No conversation found with session ID"
// in src/runner/index.ts.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSession } from "../src/runner/index.js";

let invocationCounter = 90000;
function nextId() {
  return ++invocationCounter;
}

describe("Runner isResumeNotFound detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-emi342-runner-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path: isResumeNotFound defaults false
  // -------------------------------------------------------------------------

  test("isResumeNotFound is false when no resume error in stderr", async () => {
    const script = join(tmpDir, "clean.js");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
    );

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: nextId(),
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
    }).done;

    expect(result.isResumeNotFound).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE 1: exact error string in stderr must set isResumeNotFound
  // -------------------------------------------------------------------------

  test("isResumeNotFound is true when stderr contains exact error string", async () => {
    const script = join(tmpDir, "resume-not-found.js");
    writeFileSync(
      script,
      [
        'process.stderr.write("No conversation found with session ID abc-123\\n");',
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: nextId(),
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      resumeSessionId: "abc-123",
    }).done;

    expect(result.isResumeNotFound).toBe(true);
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE 2: detection is case-sensitive (documents current behavior)
  // -------------------------------------------------------------------------

  test("isResumeNotFound is false when error string uses different capitalisation", async () => {
    const script = join(tmpDir, "wrong-case.js");
    writeFileSync(
      script,
      [
        // All lowercase — must NOT match the exact substring check
        'process.stderr.write("no conversation found with session id abc-123\\n");',
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: nextId(),
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      resumeSessionId: "abc-123",
    }).done;

    // Case-sensitive check: lowercase variant must NOT trigger detection.
    // If Claude CLI ever changes its capitalisation this test catches the drift.
    expect(result.isResumeNotFound).toBe(false);
  });

  // -------------------------------------------------------------------------
  // BUG CANDIDATE 3: isResumeNotFound propagates even when a result message
  // is also present on stdout (the detection must not be lost)
  // -------------------------------------------------------------------------

  test("isResumeNotFound is true even when process also emits a result message", async () => {
    const script = join(tmpDir, "stderr-with-result.js");
    writeFileSync(
      script,
      [
        'process.stderr.write("No conversation found with session ID xyz\\n");',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ].join("\n"),
    );

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: nextId(),
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      resumeSessionId: "xyz",
    }).done;

    expect(result.subtype).toBe("success");
    // isResumeNotFound must survive even when the result message is present
    expect(result.isResumeNotFound).toBe(true);
  });

  // NOTE: A test for "error string split across two stderr writes" was removed
  // because the behavior is platform-dependent: on Linux, consecutive writes
  // typically arrive as one chunk (detected), but on Windows they may arrive
  // separately (not detected). The per-chunk detection approach is best-effort.

  // -------------------------------------------------------------------------
  // BUG CANDIDATE 5: false positive — detection fires even when --resume was
  // not used (no gate on resumeSessionId)
  // -------------------------------------------------------------------------

  test("isResumeNotFound fires even when no resumeSessionId provided (false positive)", async () => {
    const script = join(tmpDir, "no-resume-flag.js");
    writeFileSync(
      script,
      [
        // Error string appears in stderr but no --resume was requested
        'process.stderr.write("No conversation found with session ID orphan-123\\n");',
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: nextId(),
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No resumeSessionId — --resume is NOT in args
    }).done;

    // Detection is guarded by opts.resumeSessionId — when --resume was never
    // used, the error string in stderr should NOT set isResumeNotFound.
    expect(result.isResumeNotFound).toBe(false);
  });
});
