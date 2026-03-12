// ---------------------------------------------------------------------------
// Init wizard tests — src/cli/init.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// vi.mock factories are hoisted and run before module-level code, so we
// cannot reference outer `const` variables inside them. Instead, expose
// mocks via vi.mocked() after import.
// ---------------------------------------------------------------------------

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
  password: vi.fn(),
  checkbox: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../src/cli/preflight.js", () => ({
  runPreflightChecks: vi.fn(),
}));

vi.mock("../src/linear/client.js", () => {
  // Must be a real constructable function, not an arrow function
  const LinearClient = vi.fn(function LinearClientMock(this: Record<string, unknown>) {
    this.fetchViewer = vi.fn();
    this.fetchAllProjects = vi.fn();
    this.fetchProjectMetadata = vi.fn();
    this.createWebhook = vi.fn();
  });
  return { LinearClient };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  createDb: vi.fn(() => ({})),
}));

// Import modules after mocks are registered
import * as inquirer from "@inquirer/prompts";
import * as preflightMod from "../src/cli/preflight.js";
import { LinearClient } from "../src/linear/client.js";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";

// Import the function under test
const { runInit } = await import("../src/cli/init.js");

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const mockInput = vi.mocked(inquirer.input);
const mockPassword = vi.mocked(inquirer.password);
const mockCheckbox = vi.mocked(inquirer.checkbox);
const mockConfirm = vi.mocked(inquirer.confirm);
const mockRunPreflightChecks = vi.mocked(preflightMod.runPreflightChecks);
const MockLinearClient = vi.mocked(LinearClient) as unknown as ReturnType<typeof vi.fn>;
const mockExistsSync = vi.mocked(fs.existsSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);

// ---------------------------------------------------------------------------
// Helper: get the LinearClient instance created during a runInit() call
// ---------------------------------------------------------------------------
function getLastClientInstance() {
  const instances = MockLinearClient.mock.instances;
  return instances[instances.length - 1] as {
    fetchViewer: ReturnType<typeof vi.fn>;
    fetchAllProjects: ReturnType<typeof vi.fn>;
    fetchProjectMetadata: ReturnType<typeof vi.fn>;
    createWebhook: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Default happy-path setup
// ---------------------------------------------------------------------------

function setupHappyPath() {
  // Preflight: all ok
  mockRunPreflightChecks.mockReturnValue([
    { name: "Node.js", status: "ok", version: "22.0.0" },
    { name: "git", status: "ok", version: "2.44.0" },
    { name: "claude CLI", status: "ok", version: "2.1.71" },
    { name: "gh CLI", status: "ok", version: "2.45.0" },
    { name: "cloudflared", status: "ok", version: "2024.1.0" },
  ]);

  // No existing .env, no cert.pem, no config.yml
  mockExistsSync.mockReturnValue(false);

  // Inquirer prompts
  mockPassword.mockResolvedValue("lin_api_test123");
  mockCheckbox.mockResolvedValue(["proj-1"]);
  mockInput.mockImplementation(({ message }: { message: string }) => {
    if (message.includes("Tunnel name")) return Promise.resolve("orca");
    if (message.includes("Hostname")) return Promise.resolve("orca.example.com");
    if (message.includes("Default repo path")) return Promise.resolve("/tmp");
    if (message.includes("webhook secret")) return Promise.resolve("manual-secret");
    return Promise.resolve("");
  });
  mockConfirm.mockResolvedValue(true);

  // cloudflared: cert.pem doesn't exist (existsSync returns false),
  // so tunnel login will be called. Simulate tunnel list returning existing tunnel.
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
    const cmdStr = String(cmd);
    const firstArg = args[0];
    const secondArg = args[1];
    if (cmdStr === "cloudflared" && firstArg === "tunnel" && secondArg === "list") {
      return JSON.stringify([{ id: "existing-tunnel-uuid", name: "orca" }]);
    }
    // All other cloudflared calls (login, route, ingress): succeed silently
    return "";
  });
}

// ---------------------------------------------------------------------------
// Configure LinearClient mock instances per-test via beforeEach
// ---------------------------------------------------------------------------

function setupLinearClientMock({
  viewer = { organizationName: "TestCorp" },
  projects = [
    { id: "proj-1", name: "Alpha", description: "repo: /tmp/alpha" },
    { id: "proj-2", name: "Beta", description: "" },
  ],
  projectMeta = [{ id: "proj-1", teamIds: ["team-1"] }],
  webhookError = null as Error | null,
} = {}) {
  MockLinearClient.mockImplementation(function (this: Record<string, unknown>) {
    this.fetchViewer = vi.fn().mockResolvedValue(viewer);
    this.fetchAllProjects = vi.fn().mockResolvedValue(projects);
    this.fetchProjectMetadata = vi.fn().mockResolvedValue(projectMeta);
    if (webhookError) {
      this.createWebhook = vi.fn().mockRejectedValue(webhookError);
    } else {
      this.createWebhook = vi.fn().mockResolvedValue(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runInit", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string) => {
        throw new Error(`process.exit(${code})`);
      });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  test("exits with code 1 when preflight has missing tools", async () => {
    mockRunPreflightChecks.mockReturnValue([
      { name: "Node.js", status: "ok", version: "22.0.0" },
      {
        name: "git",
        status: "missing",
        message: "Install git: brew install git",
      },
    ]);

    await expect(runInit()).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  test("continues when preflight has only warnings (no missing)", async () => {
    setupHappyPath();
    setupLinearClientMock();
    mockRunPreflightChecks.mockReturnValue([
      {
        name: "git",
        status: "warn",
        version: "2.44.0",
        message: "core.longpaths not enabled",
      },
      { name: "Node.js", status: "ok", version: "22.0.0" },
      { name: "claude CLI", status: "ok", version: "2.1.71" },
      { name: "gh CLI", status: "ok", version: "2.45.0" },
      { name: "cloudflared", status: "ok", version: "2024.1.0" },
    ]);

    await runInit();

    expect(mockExit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Linear auth failure
  // -------------------------------------------------------------------------

  test("exits with code 1 when Linear authentication fails", async () => {
    setupHappyPath();
    MockLinearClient.mockImplementation(function (this: Record<string, unknown>) {
      this.fetchViewer = vi.fn().mockRejectedValue(new Error("Invalid API key"));
      this.fetchAllProjects = vi.fn();
      this.fetchProjectMetadata = vi.fn();
      this.createWebhook = vi.fn();
    });

    await expect(runInit()).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to authenticate"),
    );
  });

  // -------------------------------------------------------------------------
  // No projects selected
  // -------------------------------------------------------------------------

  test("exits with code 1 when checkbox returns empty (defensive check)", async () => {
    setupHappyPath();
    setupLinearClientMock();
    mockCheckbox.mockResolvedValue([]);

    await expect(runInit()).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("At least one project must be selected"),
    );
  });

  // -------------------------------------------------------------------------
  // Webhook secret fallback
  // -------------------------------------------------------------------------

  test("prompts for manual secret when all webhook creations fail", async () => {
    setupHappyPath();
    setupLinearClientMock({ webhookError: new Error("Forbidden") });
    mockInput.mockImplementation(({ message }: { message: string }) => {
      if (message.includes("Tunnel name")) return Promise.resolve("orca");
      if (message.includes("Hostname")) return Promise.resolve("orca.example.com");
      if (message.includes("webhook secret")) return Promise.resolve("my-manual-secret");
      return Promise.resolve("");
    });

    await runInit();

    const webhookSecretCall = mockInput.mock.calls.find(([opts]) =>
      (opts as { message: string }).message.includes("webhook secret"),
    );
    expect(webhookSecretCall).toBeDefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not auto-create webhook"),
    );
  });

  // -------------------------------------------------------------------------
  // .env content
  // -------------------------------------------------------------------------

  test("writes .env with correct keys on happy path", async () => {
    setupHappyPath();
    setupLinearClientMock();

    await runInit();

    expect(mockWriteFileSync).toHaveBeenCalled();

    const envWriteCall = mockWriteFileSync.mock.calls.find(
      ([path]) => typeof path === "string" && path.endsWith(".env"),
    );
    expect(envWriteCall).toBeDefined();

    const [, content] = envWriteCall!;
    expect(content).toContain("ORCA_LINEAR_API_KEY=lin_api_test123");
    expect(content).toContain('ORCA_LINEAR_PROJECT_IDS=["proj-1"]');
    expect(content).toContain("ORCA_TUNNEL_HOSTNAME=orca.example.com");
    expect(content).toContain("CLOUDFLARE_TUNNEL_ID=existing-tunnel-uuid");
    expect(content).toContain("ORCA_LINEAR_WEBHOOK_SECRET=");
  });

  // -------------------------------------------------------------------------
  // Existing .env loading
  // -------------------------------------------------------------------------

  test("uses existing Linear API key from .env when user accepts", async () => {
    setupHappyPath();
    setupLinearClientMock();

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".env")) return true;
      if (p.endsWith("cert.pem")) return true; // skip cloudflare auth prompt
      return false;
    });

    mockReadFileSync.mockReturnValue(
      "ORCA_LINEAR_API_KEY=lin_api_existing\nORCA_TUNNEL_HOSTNAME=old.example.com\n",
    );

    mockConfirm.mockImplementation(({ message }: { message: string }) => {
      if (message.includes("existing Linear API key")) return Promise.resolve(true);
      if (message.includes("Overwrite")) return Promise.resolve(true);
      return Promise.resolve(true);
    });

    await runInit();

    // No password prompt when user accepts existing key
    expect(mockPassword).not.toHaveBeenCalled();
    // LinearClient constructed with the existing key
    expect(MockLinearClient).toHaveBeenCalledWith("lin_api_existing");
  });

  test("preserves extra vars from existing .env in output", async () => {
    setupHappyPath();
    setupLinearClientMock();

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".env")) return true;
      if (p.endsWith("cert.pem")) return true;
      return false;
    });

    mockReadFileSync.mockReturnValue(
      "ORCA_LINEAR_API_KEY=lin_api_existing\nMY_CUSTOM_VAR=hello\n",
    );

    mockConfirm.mockImplementation(({ message }: { message: string }) => {
      if (message.includes("existing Linear API key")) return Promise.resolve(true);
      return Promise.resolve(true);
    });

    await runInit();

    const envWriteCall = mockWriteFileSync.mock.calls.find(([p]) =>
      typeof p === "string" && p.endsWith(".env"),
    );
    expect(envWriteCall).toBeDefined();
    const [, content] = envWriteCall!;
    expect(content).toContain("MY_CUSTOM_VAR=hello");
  });

  // -------------------------------------------------------------------------
  // Hostname required
  // -------------------------------------------------------------------------

  test("exits with code 1 when tunnel hostname is empty", async () => {
    setupHappyPath();
    setupLinearClientMock();
    mockInput.mockImplementation(({ message }: { message: string }) => {
      if (message.includes("Tunnel name")) return Promise.resolve("orca");
      if (message.includes("Hostname")) return Promise.resolve(""); // empty
      return Promise.resolve("");
    });

    await expect(runInit()).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Hostname is required"),
    );
  });

  // -------------------------------------------------------------------------
  // Skipping .env write
  // -------------------------------------------------------------------------

  test("skips .env write when user declines overwrite", async () => {
    setupHappyPath();
    setupLinearClientMock();

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".env")) return true;
      if (p.endsWith("cert.pem")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("ORCA_LINEAR_API_KEY=lin_api_existing\n");

    mockConfirm.mockImplementation(({ message }: { message: string }) => {
      if (message.includes("existing Linear API key")) return Promise.resolve(true);
      if (message.includes("Overwrite existing .env")) return Promise.resolve(false);
      return Promise.resolve(true);
    });

    await runInit();

    const envWriteCall = mockWriteFileSync.mock.calls.find(([p]) =>
      typeof p === "string" && p.endsWith(".env"),
    );
    expect(envWriteCall).toBeUndefined();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped .env write"),
    );
  });
});
