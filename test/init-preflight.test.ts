// ---------------------------------------------------------------------------
// Preflight checker tests
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(() => "linux") };
});

// Mock resolveClaudeBinary since it has its own Windows-specific logic
vi.mock("../src/runner/index.js", () => ({
  resolveClaudeBinary: vi.fn(() => ({
    command: "claude",
    prefixArgs: [],
  })),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedPlatform = vi.mocked(platform);

// Must import after mocks are set up
const { runPreflightChecks } = await import("../src/cli/preflight.js");

describe("runPreflightChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPlatform.mockReturnValue("linux");
  });

  test("all tools present returns all ok", () => {
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        const firstArg = args?.[0];
        if (command === "git" && firstArg === "--version")
          return "git version 2.44.0\n";
        if (command === "claude" && firstArg === "--version")
          return "claude v2.1.71\n";
        if (command === "gh" && firstArg === "--version")
          return "gh version 2.45.0\n";
        if (command === "gh" && firstArg === "auth")
          return "Logged in to github.com as emily-flambe\n";
        if (command === "cloudflared" && firstArg === "--version")
          return "cloudflared version 2024.1.0\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(results[0].name).toBe("Node.js");
    expect(results[1].name).toBe("git");
    expect(results[2].name).toBe("claude CLI");
    expect(results[3].name).toBe("gh CLI");
    expect(results[4].name).toBe("cloudflared");
  });

  test("missing git returns missing with install hint", () => {
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        if (command === "git") throw new Error("not found");
        if (command === "claude") return "claude v2.1.71\n";
        if (command === "gh" && args?.[0] === "--version")
          return "gh version 2.45.0\n";
        if (command === "gh") return "Logged in to github.com as test\n";
        if (command === "cloudflared") return "cloudflared version 2024.1.0\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    const git = results.find((r) => r.name === "git")!;
    expect(git.status).toBe("missing");
    expect(git.message).toContain("brew install git");
  });

  test("Windows: missing git suggests winget", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        if (command === "git") throw new Error("not found");
        if (command === "claude") return "claude v2.1.71\n";
        if (command === "gh" && args?.[0] === "--version")
          return "gh version 2.45.0\n";
        if (command === "gh") return "Logged in to github.com as test\n";
        if (command === "cloudflared") return "cloudflared version 2024.1.0\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    const git = results.find((r) => r.name === "git")!;
    expect(git.status).toBe("missing");
    expect(git.message).toContain("winget");
  });

  test("Windows: warns if core.longpaths not enabled", () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        if (command === "git" && args?.[0] === "--version")
          return "git version 2.44.0\n";
        if (command === "git" && args?.[0] === "config") return "false\n";
        if (command === "claude") return "claude v2.1.71\n";
        if (command === "gh" && args?.[0] === "--version")
          return "gh version 2.45.0\n";
        if (command === "gh") return "Logged in to github.com as test\n";
        if (command === "cloudflared") return "cloudflared version 2024.1.0\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    const git = results.find((r) => r.name === "git")!;
    expect(git.status).toBe("warn");
    expect(git.message).toContain("core.longpaths");
  });

  test("gh not authenticated returns warn", () => {
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        if (command === "git") return "git version 2.44.0\n";
        if (command === "claude") return "claude v2.1.71\n";
        if (command === "gh" && args?.[0] === "--version")
          return "gh version 2.45.0\n";
        if (command === "gh" && args?.[0] === "auth")
          throw new Error("not logged in");
        if (command === "cloudflared") return "cloudflared version 2024.1.0\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    const gh = results.find((r) => r.name === "gh CLI")!;
    expect(gh.status).toBe("warn");
    expect(gh.message).toContain("gh auth login");
  });

  test("version parsing extracts semver", () => {
    mockedExecFileSync.mockImplementation(
      (cmd: string, args?: readonly string[]) => {
        const command = String(cmd);
        if (command === "git") return "git version 2.44.0.windows.1\n";
        if (command === "claude") return "claude v2.1.71\n";
        if (command === "gh" && args?.[0] === "--version")
          return "gh version 2.45.0 (2024-01-15)\n";
        if (command === "gh") return "Logged in to github.com as test\n";
        if (command === "cloudflared")
          return "cloudflared version 2024.1.0 (built 2024-01-15)\n";
        return "";
      },
    );

    const results = runPreflightChecks();
    expect(results[1].version).toBe("2.44.0");
    expect(results[2].version).toBe("2.1.71");
    expect(results[4].version).toBe("2024.1.0");
  });
});
