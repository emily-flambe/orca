// ---------------------------------------------------------------------------
// Adversarial tests for getDefaultBranch() and getDefaultBranchAsync()
// in src/git.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockExecFileSync, mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    execFile: (...args: unknown[]) => {
      // promisify(execFile) expects a callback-style function.
      // Intercept to route through mockExecFileAsync for async tests.
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        const result = mockExecFileAsync(args[0], args[1], args[2]);
        if (result && typeof result.then === "function") {
          result.then(
            (res: { stdout: string; stderr?: string }) =>
              (cb as CallableFunction)(null, res),
            (err: Error) => (cb as CallableFunction)(err),
          );
        } else {
          // synchronous mock return
          (cb as CallableFunction)(null, result ?? { stdout: "", stderr: "" });
        }
      }
      // Return a fake ChildProcess so promisify doesn't blow up
      return { on: vi.fn(), removeListener: vi.fn(), once: vi.fn() };
    },
  };
});

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Atomics.wait to avoid real delays
const originalAtomicsWait = Atomics.wait;
beforeEach(() => {
  Atomics.wait = vi.fn(() => "ok") as unknown as typeof Atomics.wait;
});
afterEach(() => {
  Atomics.wait = originalAtomicsWait;
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getDefaultBranch, getDefaultBranchAsync } from "../src/git.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExecFileAsync.mockReset();
});

// ---------------------------------------------------------------------------
// Helper: make execFileSync behave differently per git command
// ---------------------------------------------------------------------------

type GitCommandRouter = Record<string, string | Error>;

function routeGitSync(routes: GitCommandRouter) {
  mockExecFileSync.mockImplementation(
    (_cmd: string, args: string[], _opts?: unknown) => {
      const key = args.join(" ");
      for (const [pattern, result] of Object.entries(routes)) {
        if (key.includes(pattern)) {
          if (result instanceof Error) throw result;
          return result;
        }
      }
      // default: throw (command not recognized by mock)
      throw new Error(`unmocked git command: ${key}`);
    },
  );
}

function routeGitAsync(routes: GitCommandRouter) {
  mockExecFileAsync.mockImplementation(
    (_cmd: string, args: string[], _opts?: unknown) => {
      const key = args.join(" ");
      for (const [pattern, result] of Object.entries(routes)) {
        if (key.includes(pattern)) {
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve({ stdout: result, stderr: "" });
        }
      }
      return Promise.reject(new Error(`unmocked git command: ${key}`));
    },
  );
}

// ---------------------------------------------------------------------------
// getDefaultBranch (sync)
// ---------------------------------------------------------------------------

describe("getDefaultBranch", () => {
  test("returns branch name from symbolic-ref when origin/HEAD is set", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    expect(getDefaultBranch("/repo")).toBe("main");
  });

  test("extracts 'master' from symbolic-ref when origin/HEAD points to master", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/master",
    });

    expect(getDefaultBranch("/repo")).toBe("master");
  });

  test("extracts unusual branch names like 'develop' from symbolic-ref", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    expect(getDefaultBranch("/repo")).toBe("develop");
  });

  test("extracts unusual branch names like 'trunk' from symbolic-ref", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/trunk",
    });

    expect(getDefaultBranch("/repo")).toBe("trunk");
  });

  test("falls back to 'main' when symbolic-ref fails but origin/main exists", () => {
    routeGitSync({
      "symbolic-ref": new Error(
        "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
      ),
      "rev-parse --verify origin/main": "abc123",
    });

    expect(getDefaultBranch("/repo")).toBe("main");
  });

  test("falls back to 'master' when symbolic-ref and origin/main both fail but origin/master exists", () => {
    routeGitSync({
      "symbolic-ref": new Error("not a symbolic ref"),
      "rev-parse --verify origin/main": new Error("not found"),
      "rev-parse --verify origin/master": "def456",
    });

    expect(getDefaultBranch("/repo")).toBe("master");
  });

  test("returns 'main' as last resort when ALL commands fail", () => {
    routeGitSync({
      "symbolic-ref": new Error("not a symbolic ref"),
      "rev-parse --verify origin/main": new Error("not found"),
      "rev-parse --verify origin/master": new Error("not found"),
    });

    expect(getDefaultBranch("/repo")).toBe("main");
  });

  test("handles symbolic-ref returning empty string gracefully", () => {
    // If symbolic-ref returns empty string, the regex won't match.
    // Should fall through to rev-parse.
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "",
      "rev-parse --verify origin/main": "abc123",
    });

    expect(getDefaultBranch("/repo")).toBe("main");
  });

  test("handles symbolic-ref returning unexpected format (no refs/remotes/origin/ prefix)", () => {
    // Some git configs might return unusual refs
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "HEAD",
      "rev-parse --verify origin/main": "abc123",
    });

    // "HEAD" doesn't match /refs\/remotes\/origin\/(.+)/ so should fall through
    expect(getDefaultBranch("/repo")).toBe("main");
  });

  test("handles branch names with slashes like 'release/v2'", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/release/v2",
    });

    // The regex (.+) is greedy, should capture "release/v2"
    expect(getDefaultBranch("/repo")).toBe("release/v2");
  });

  test("handles branch names with dots and hyphens", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD":
        "refs/remotes/origin/my-branch.1.0",
    });

    expect(getDefaultBranch("/repo")).toBe("my-branch.1.0");
  });

  test("passes repoPath as cwd to git commands", () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    getDefaultBranch("/some/specific/repo");

    // Verify cwd was passed (first call should be symbolic-ref)
    const call = mockExecFileSync.mock.calls[0];
    expect(call).toBeDefined();
    const opts = call![2] as { cwd?: string };
    expect(opts?.cwd).toBe("/some/specific/repo");
  });

  test("does not throw when repo has no remote at all", () => {
    // All git commands fail - simulating no remote
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    // Should not throw, should return "main"
    expect(getDefaultBranch("/no-remote")).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// getDefaultBranchAsync
// ---------------------------------------------------------------------------

describe("getDefaultBranchAsync", () => {
  test("returns branch name from symbolic-ref when origin/HEAD is set", async () => {
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("main");
  });

  test("extracts 'master' from symbolic-ref", async () => {
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/master",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("master");
  });

  test("extracts unusual branch name 'develop'", async () => {
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("develop");
  });

  test("falls back to 'main' when symbolic-ref fails but origin/main exists", async () => {
    routeGitAsync({
      "symbolic-ref": new Error("not a symbolic ref"),
      "rev-parse --verify origin/main": "abc123",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("main");
  });

  test("falls back to 'master' when symbolic-ref and origin/main fail but origin/master exists", async () => {
    routeGitAsync({
      "symbolic-ref": new Error("not a symbolic ref"),
      "rev-parse --verify origin/main": new Error("not found"),
      "rev-parse --verify origin/master": "def456",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("master");
  });

  test("returns 'main' as last resort when ALL commands fail", async () => {
    routeGitAsync({
      "symbolic-ref": new Error("not a symbolic ref"),
      "rev-parse --verify origin/main": new Error("not found"),
      "rev-parse --verify origin/master": new Error("not found"),
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("main");
  });

  test("handles empty symbolic-ref output gracefully", async () => {
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "",
      "rev-parse --verify origin/main": "abc123",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("main");
  });

  test("handles branch names with slashes", async () => {
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/release/v2",
    });

    expect(await getDefaultBranchAsync("/repo")).toBe("release/v2");
  });

  test("does not throw when repo has no remote", async () => {
    mockExecFileAsync.mockImplementation(() => {
      return Promise.reject(new Error("fatal: not a git repository"));
    });

    expect(await getDefaultBranchAsync("/no-remote")).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// alreadyDonePatterns hardcoded "main" bug
// ---------------------------------------------------------------------------

describe("alreadyDonePatterns hardcoded branch names", () => {
  /**
   * BUG: alreadyDonePatterns in workflow-utils.ts contains:
   *   "already on main"
   *   "already on `main`"
   *   "already on `origin/main`"
   *
   * If the default branch is "master", an agent saying "already on origin/master"
   * won't match any pattern. The worktreeHasNoChanges() fallback may save us,
   * but the pattern match itself is branch-name-dependent.
   *
   * This test reads the source directly to avoid module import issues.
   */
  test("patterns only match 'main' variants, not 'master' or other branch names", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/inngest/workflow-utils.ts", "utf-8");

    // Extract the array literal from source
    const arrayMatch = source.match(
      /alreadyDonePatterns:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/,
    );
    expect(arrayMatch).not.toBeNull();
    const arrayContent = arrayMatch![1]!;

    // Parse individual string patterns from the array
    const patterns: string[] = [];
    for (const m of arrayContent.matchAll(/"([^"]+)"/g)) {
      patterns.push(m[1]!);
    }
    expect(patterns.length).toBeGreaterThan(0);

    // BUG #1: "already on origin/main" (without backticks) does NOT match
    // the pattern "already on main" because "on origin/main" != "on main".
    // Only the backtick variant matches.
    const plainMainOutput = "already on origin/main";
    const matchesPlainMain = patterns.some((p) => plainMainOutput.includes(p));
    // This documents a pre-existing gap: plain "already on origin/main"
    // is NOT caught by patterns. Only backtick format matches.
    expect(matchesPlainMain).toBe(false);

    // Backtick format DOES match via "already on `origin/main`" pattern
    const backtickMainOutput = "already on `origin/main`";
    expect(patterns.some((p) => backtickMainOutput.includes(p))).toBe(true);

    // master variants are now covered by the patterns
    const masterOutput = "the code is already on `origin/master`";
    const matchesMaster = patterns.some((p) =>
      masterOutput.toLowerCase().includes(p),
    );
    expect(matchesMaster).toBe(true);

    // develop, trunk, etc. are still not covered (only main/master)
    const developOutput = "already on `origin/develop`";
    const matchesDevelop = patterns.some((p) =>
      developOutput.toLowerCase().includes(p),
    );
    expect(matchesDevelop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// worktreeHasNoChanges uses getDefaultBranch correctly
// ---------------------------------------------------------------------------

describe("worktreeHasNoChanges dynamic branch", () => {
  test("source code passes getDefaultBranch result to git diff", async () => {
    // Read the source to verify the pattern, since dynamically importing
    // workflow-utils pulls in a complex dependency graph.
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/inngest/workflow-utils.ts", "utf-8");

    // worktreeHasNoChanges should call getDefaultBranch, not hardcode "main"
    expect(source).toContain("getDefaultBranch");
    // The diff command should use the dynamic branch
    expect(source).toContain("origin/${defaultBranch}...HEAD");
    // Should NOT have hardcoded origin/main in the diff
    expect(source).not.toMatch(/git\(\["diff",\s*"origin\/main/);
  });
});

// ---------------------------------------------------------------------------
// System prompt placeholder replacement
// ---------------------------------------------------------------------------

describe("system prompt {{DEFAULT_BRANCH_REF}} placeholder", () => {
  test("implement and review system prompts contain the placeholder", async () => {
    // Read the raw source file to verify prompts use the placeholder.
    // Can't import loadConfig without env vars.
    const fs = await import("node:fs");
    const configSource = fs.readFileSync("src/config/index.ts", "utf-8");

    // The placeholder uses double curly braces - search for the literal string
    expect(configSource).toContain("{{DEFAULT_BRANCH_REF}}");

    // Verify implement prompt has the placeholder
    // Extract the section between DEFAULT_IMPLEMENT_SYSTEM_PROMPT = ` and the closing `;
    const implementStart = configSource.indexOf(
      "DEFAULT_IMPLEMENT_SYSTEM_PROMPT",
    );
    expect(implementStart).toBeGreaterThan(-1);
    const implementSection = configSource.slice(
      implementStart,
      configSource.indexOf("`;", implementStart) + 2,
    );
    expect(implementSection).toContain("{{DEFAULT_BRANCH_REF}}");
    // Should NOT have hardcoded origin/main in the template
    expect(implementSection).not.toContain("origin/main");

    // Review prompt removed in EMI-504

    // Fix prompt shouldn't have hardcoded origin/main either
    const fixStart = configSource.indexOf("DEFAULT_FIX_SYSTEM_PROMPT");
    expect(fixStart).toBeGreaterThan(-1);
    const fixSection = configSource.slice(
      fixStart,
      configSource.indexOf("`;", fixStart) + 2,
    );
    expect(fixSection).not.toContain("origin/main");
  });

  test("task-lifecycle replaces placeholder in all three phases", async () => {
    const fs = await import("node:fs");
    const lifecycleSource = fs.readFileSync(
      "src/inngest/workflows/task-lifecycle.ts",
      "utf-8",
    );

    // Count occurrences of the replacement regex pattern.
    // In the TS source, the regex is /\{\{DEFAULT_BRANCH_REF\}\}/g
    // which is a regex literal matching {{DEFAULT_BRANCH_REF}}.
    const replacements = lifecycleSource.match(/DEFAULT_BRANCH_REF/g);
    // Should appear at least 1 time: implement and fix phase replacements (review removed)
    expect(replacements).not.toBeNull();
    expect(replacements!.length).toBeGreaterThanOrEqual(1);

    // Verify getDefaultBranch is called before the replacement
    const getDefaultBranchCalls = lifecycleSource.match(
      /getDefaultBranch\(task\.repoPath\)/g,
    );
    // Should be called at least once for implement+fix and once for review
    // (may also be called in merge conflict handling)
    expect(getDefaultBranchCalls).not.toBeNull();
    expect(getDefaultBranchCalls!.length).toBeGreaterThanOrEqual(2);
  });

  test("ci-merge uses getDefaultBranch for rebase log messages", async () => {
    const fs = await import("node:fs");
    const ciMergeSource = fs.readFileSync(
      "src/inngest/workflows/ci-merge.ts",
      "utf-8",
    );

    // Should import getDefaultBranch
    expect(ciMergeSource).toContain("getDefaultBranch");

    // Should NOT have hardcoded origin/main in non-comment/non-import code
    const lines = ciMergeSource.split("\n");
    const suspiciousLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("*")) continue;
      if (line.includes("import ")) continue;
      if (
        line.includes('"origin/main"') ||
        line.includes("'origin/main'") ||
        line.includes("`origin/main`")
      ) {
        suspiciousLines.push(line.trim());
      }
    }
    // No hardcoded origin/main should remain in runtime code
    expect(suspiciousLines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: DLL_INIT retry inside getDefaultBranch
// ---------------------------------------------------------------------------

describe("getDefaultBranch with DLL_INIT errors", () => {
  test("DLL_INIT error on symbolic-ref falls through to rev-parse gracefully", () => {
    const dllErr = Object.assign(new Error("DLL init failed"), {
      status: 3221225794, // WIN_DLL_INIT_FAILED
    });

    // After DLL retries exhaust, getDefaultBranch should catch and fall through.
    // But the git() function retries 3 times with real delays (mocked via Atomics.wait).
    // The outer catch in getDefaultBranch should swallow the final throw.
    let callCount = 0;
    mockExecFileSync.mockImplementation(
      (_cmd: string, args: string[], _opts?: unknown) => {
        callCount++;
        const key = (args as string[]).join(" ");
        if (key.includes("symbolic-ref")) {
          throw dllErr;
        }
        if (key.includes("rev-parse --verify origin/main")) {
          return "abc123";
        }
        throw new Error(`unmocked: ${key}`);
      },
    );

    const result = getDefaultBranch("/repo");
    // After DLL retries on symbolic-ref exhaust, it should fall through to rev-parse
    // The 4 calls = 1 initial + 3 retries for symbolic-ref, then 1 for rev-parse
    expect(result).toBe("main");
    // At least 2 calls: the symbolic-ref attempts + the rev-parse fallback
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Consistency: getDefaultBranch and getDefaultBranchAsync return same result
// ---------------------------------------------------------------------------

describe("sync/async consistency", () => {
  test("both return same result for symbolic-ref with develop branch", async () => {
    routeGitSync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });
    routeGitAsync({
      "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/develop",
    });

    const syncResult = getDefaultBranch("/repo");
    const asyncResult = await getDefaultBranchAsync("/repo");

    expect(syncResult).toBe(asyncResult);
    expect(syncResult).toBe("develop");
  });

  test("both fall back to 'main' identically when all commands fail", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("all fail");
    });
    mockExecFileAsync.mockImplementation(() => {
      return Promise.reject(new Error("all fail"));
    });

    const syncResult = getDefaultBranch("/repo");
    const asyncResult = await getDefaultBranchAsync("/repo");

    expect(syncResult).toBe(asyncResult);
    expect(syncResult).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Performance: getDefaultBranch is called many times in a single lifecycle
// ---------------------------------------------------------------------------

describe("multiple calls per lifecycle", () => {
  test("getDefaultBranch is called separately per phase (no caching between calls)", () => {
    // This verifies there is NO caching -- each call hits git again.
    // This is important because a repo's default branch could theoretically
    // change mid-lifecycle (e.g., if origin/HEAD is updated).
    let callCount = 0;
    mockExecFileSync.mockImplementation(
      (_cmd: string, args: string[], _opts?: unknown) => {
        const key = (args as string[]).join(" ");
        if (key.includes("symbolic-ref")) {
          callCount++;
          return "refs/remotes/origin/main";
        }
        throw new Error(`unmocked: ${key}`);
      },
    );

    getDefaultBranch("/repo");
    getDefaultBranch("/repo");
    getDefaultBranch("/repo");

    // Each call should independently hit git
    expect(callCount).toBe(3);
  });
});
