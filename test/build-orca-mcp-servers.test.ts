// ---------------------------------------------------------------------------
// Tests for buildOrcaMcpServers()
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importBuildOrcaMcpServers() {
  vi.resetModules();
  const mod = await import(
    "../src/inngest/workflows/task-lifecycle.js"
  );
  return mod.buildOrcaMcpServers;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    dbPath: "./orca.db",
    githubMcpPat: undefined as string | undefined,
    ...overrides,
  } as Parameters<typeof buildOrcaMcpServers>[0];
}

// Placeholder — replaced per-test after import
let buildOrcaMcpServers: Awaited<
  ReturnType<typeof importBuildOrcaMcpServers>
>;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let savedGithubToken: string | undefined;

beforeEach(async () => {
  savedGithubToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  mockExistsSync.mockReturnValue(false);
  buildOrcaMcpServers = await importBuildOrcaMcpServers();
});

afterEach(() => {
  if (savedGithubToken !== undefined) {
    process.env.GITHUB_TOKEN = savedGithubToken;
  } else {
    delete process.env.GITHUB_TOKEN;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildOrcaMcpServers", () => {
  describe("orca MCP server", () => {
    test("included when dist/mcp-server.js exists and dbPath is set", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === join(process.cwd(), "dist", "mcp-server.js"),
      );
      const result = buildOrcaMcpServers(baseConfig({ dbPath: "./orca.db" }));
      expect(result).toBeDefined();
      expect(result).toHaveProperty("orca");
      const orca = result!.orca;
      expect(orca).toMatchObject({
        command: process.execPath,
        args: [join(process.cwd(), "dist", "mcp-server.js")],
        env: { ORCA_DB_PATH: resolve("./orca.db") },
      });
    });

    test("excluded when dist/mcp-server.js does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      const result = buildOrcaMcpServers(baseConfig({ dbPath: "./orca.db" }));
      expect(result).toBeUndefined();
    });

    test("excluded when dbPath is not set", () => {
      mockExistsSync.mockReturnValue(true);
      const result = buildOrcaMcpServers(baseConfig({ dbPath: undefined }));
      expect(result).toBeUndefined();
    });
  });

  describe("github MCP server", () => {
    test("included when GITHUB_MCP_PAT is set", () => {
      mockExistsSync.mockReturnValue(false);
      const result = buildOrcaMcpServers(
        baseConfig({ githubMcpPat: "ghp_testtoken" }),
      );
      expect(result).toBeDefined();
      expect(result).toHaveProperty("github");
      const github = result!.github;
      expect(github).toMatchObject({
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_testtoken" },
      });
    });

    test("excluded when GITHUB_MCP_PAT is not set and GITHUB_TOKEN is not set", () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;
      const result = buildOrcaMcpServers(
        baseConfig({ githubMcpPat: undefined }),
      );
      expect(result).toBeUndefined();
    });

    test("uses GITHUB_TOKEN as fallback when GITHUB_MCP_PAT is not set", () => {
      mockExistsSync.mockReturnValue(false);
      process.env.GITHUB_TOKEN = "ghp_fallback_token";
      try {
        const result = buildOrcaMcpServers(
          baseConfig({ githubMcpPat: undefined }),
        );
        expect(result).toBeDefined();
        expect(result).toHaveProperty("github");
        expect(result!.github).toMatchObject({
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer ghp_fallback_token" },
        });
      } finally {
        delete process.env.GITHUB_TOKEN;
      }
    });

    test("GITHUB_MCP_PAT takes precedence over GITHUB_TOKEN", () => {
      mockExistsSync.mockReturnValue(false);
      process.env.GITHUB_TOKEN = "ghp_env_token";
      try {
        const result = buildOrcaMcpServers(
          baseConfig({ githubMcpPat: "ghp_pat_token" }),
        );
        expect(result).toBeDefined();
        expect(result!.github).toMatchObject({
          headers: { Authorization: "Bearer ghp_pat_token" },
        });
      } finally {
        delete process.env.GITHUB_TOKEN;
      }
    });

    test("Bearer token header formatted correctly", () => {
      mockExistsSync.mockReturnValue(false);
      const pat = "ghp_abc123xyz";
      const result = buildOrcaMcpServers(baseConfig({ githubMcpPat: pat }));
      expect(result!.github).toMatchObject({
        headers: { Authorization: `Bearer ${pat}` },
      });
    });
  });

  describe("orca and github servers coexist", () => {
    test("both servers present when both conditions are met", () => {
      mockExistsSync.mockImplementation((p: string) =>
        p === join(process.cwd(), "dist", "mcp-server.js"),
      );
      const result = buildOrcaMcpServers(
        baseConfig({ dbPath: "./orca.db", githubMcpPat: "ghp_tok" }),
      );
      expect(result).toBeDefined();
      expect(result).toHaveProperty("orca");
      expect(result).toHaveProperty("github");
      expect(Object.keys(result!)).toHaveLength(2);
    });
  });

  describe("returns undefined when no servers configured", () => {
    test("no mcp-server.js, no PAT → undefined", () => {
      mockExistsSync.mockReturnValue(false);
      const result = buildOrcaMcpServers(
        baseConfig({ githubMcpPat: undefined }),
      );
      expect(result).toBeUndefined();
    });
  });
});
