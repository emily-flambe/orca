import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSession } from "../src/runner/index.js";
import type { McpServerConfig } from "../src/runner/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let invocationCounter = 90000;
function nextInvocationId(): number {
  return ++invocationCounter;
}

// ---------------------------------------------------------------------------
// MCP config feature
// ---------------------------------------------------------------------------

describe("MCP config (--mcp-config / mcpServers)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. --mcp-config and --strict-mcp-config appear in argv
  // -------------------------------------------------------------------------

  test("--mcp-config and --strict-mcp-config are passed to the CLI when mcpServers is set", async () => {
    const script = join(tmpDir, "argv-mcp.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      myServer: { type: "http", url: "http://localhost:9999" },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("--strict-mcp-config");
  });

  test("--mcp-config path points to a file named <invocationId>-mcp.json", async () => {
    const script = join(tmpDir, "argv-mcp-path.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      myServer: { type: "http", url: "http://localhost:9999" },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    const mcpConfigIdx = argv.indexOf("--mcp-config");
    expect(mcpConfigIdx).toBeGreaterThan(-1);

    const mcpConfigPath = argv[mcpConfigIdx + 1];
    expect(mcpConfigPath).toBeDefined();
    expect(mcpConfigPath).toContain(`${id}-mcp.json`);
  });

  // -------------------------------------------------------------------------
  // 2. Temp file content has correct { mcpServers: ... } structure
  // -------------------------------------------------------------------------

  test("temp MCP config file has correct { mcpServers: ... } JSON structure", async () => {
    // Script reads the mcp config path from argv, reads the file, and emits
    // the parsed content as the result so we can assert on it.
    const script = join(tmpDir, "read-mcp-file.js");
    writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : null;",
        "const fileContent = mcpPath ? fs.readFileSync(mcpPath, 'utf8') : 'NOT_FOUND';",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:fileContent}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      testServer: { type: "http", url: "http://example.com/mcp" },
      stdioServer: { command: "npx", args: ["-y", "some-mcp-server"] },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    expect(result.subtype).toBe("success");

    const fileContent = result.outputSummary;
    expect(fileContent).not.toBe("NOT_FOUND");

    const parsed = JSON.parse(fileContent) as unknown;
    expect(parsed).toMatchObject({
      mcpServers: {
        testServer: { type: "http", url: "http://example.com/mcp" },
        stdioServer: { command: "npx", args: ["-y", "some-mcp-server"] },
      },
    });
  });

  test("temp MCP config file contains only the provided servers (no extras)", async () => {
    const script = join(tmpDir, "read-mcp-exact.js");
    writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : null;",
        "const fileContent = mcpPath ? fs.readFileSync(mcpPath, 'utf8') : 'NOT_FOUND';",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:fileContent}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      onlyServer: { type: "http", url: "http://only.example.com" },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const parsed = JSON.parse(result.outputSummary) as { mcpServers: Record<string, unknown> };
    // Top-level keys: only "mcpServers"
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
    // Server keys: only "onlyServer"
    expect(Object.keys(parsed.mcpServers)).toEqual(["onlyServer"]);
  });

  // -------------------------------------------------------------------------
  // 3. Cleanup — temp file is deleted after session ends
  // -------------------------------------------------------------------------

  test("MCP temp file is deleted after session completes successfully", async () => {
    // The script captures the mcp config path from its own argv and emits it,
    // so we can check after handle.done that the file is gone.
    const script = join(tmpDir, "argv-capture.js");
    writeFileSync(
      script,
      [
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : 'NOT_FOUND';",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:mcpPath}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      cleanupServer: { type: "http", url: "http://cleanup.example.com" },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const mcpConfigPath = result.outputSummary;

    expect(mcpConfigPath).not.toBe("NOT_FOUND");
    expect(mcpConfigPath).toContain(`${id}-mcp.json`);

    // After done resolves, the cleanup inside logStream.end callback has run.
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  test("MCP temp file is deleted after session exits with non-zero code", async () => {
    const script = join(tmpDir, "mcp-nonzero-exit.js");
    writeFileSync(
      script,
      [
        // Emit the mcp config path then exit with code 1
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : 'NOT_FOUND';",
        "process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',errors:['deliberate failure'],mcpPath:mcpPath}) + '\\n');",
        "process.exit(1);",
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpConfigPath = join(tmpDir, "logs", `${id}-mcp.json`);

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: { srv: { type: "http", url: "http://x.example.com" } },
    });

    await handle.done;

    // The file should be cleaned up even after a non-zero exit
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. No-op when mcpServers is absent
  // -------------------------------------------------------------------------

  test("no --mcp-config flag when mcpServers is not provided", async () => {
    const script = join(tmpDir, "argv-no-mcp.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No mcpServers field
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--strict-mcp-config");
  });

  test("no MCP temp file created when mcpServers is not provided", async () => {
    const script = join(tmpDir, "no-mcp-file.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      // No mcpServers
    });

    await handle.done;

    expect(existsSync(expectedMcpPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. No-op when mcpServers is empty object
  // -------------------------------------------------------------------------

  test("no --mcp-config flag when mcpServers is empty object", async () => {
    const script = join(tmpDir, "argv-empty-mcp.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: {},
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--strict-mcp-config");
  });

  test("no MCP temp file created when mcpServers is empty object", async () => {
    const script = join(tmpDir, "no-mcp-file-empty.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:"ok"}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const expectedMcpPath = join(tmpDir, "logs", `${id}-mcp.json`);

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: {},
    });

    await handle.done;

    expect(existsSync(expectedMcpPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Edge cases / adversarial
  // -------------------------------------------------------------------------

  test("--strict-mcp-config appears AFTER --mcp-config <path> (correct ordering)", async () => {
    const script = join(tmpDir, "argv-order.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: { s: { type: "http", url: "http://order.example.com" } },
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    const mcpConfigIdx = argv.indexOf("--mcp-config");
    const strictMcpIdx = argv.indexOf("--strict-mcp-config");

    expect(mcpConfigIdx).toBeGreaterThan(-1);
    expect(strictMcpIdx).toBeGreaterThan(-1);
    // --strict-mcp-config must come after the path value (i.e., after mcpConfigIdx + 1)
    expect(strictMcpIdx).toBeGreaterThan(mcpConfigIdx + 1);
  });

  test("--mcp-config path value is immediately after --mcp-config flag (not after --strict)", async () => {
    const script = join(tmpDir, "argv-path-position.js");
    writeFileSync(
      script,
      [
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:JSON.stringify(process.argv)}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: { s: { type: "http", url: "http://pos.example.com" } },
    });

    const result = await handle.done;
    const argv: string[] = JSON.parse(result.outputSummary);

    const mcpConfigIdx = argv.indexOf("--mcp-config");
    expect(mcpConfigIdx).toBeGreaterThan(-1);

    const pathArg = argv[mcpConfigIdx + 1];
    // The value immediately after --mcp-config should be a file path, not another flag
    expect(pathArg).toBeDefined();
    expect(pathArg.startsWith("--")).toBe(false);
    expect(pathArg).toContain(`${id}-mcp.json`);
  });

  test("MCP config is valid JSON (not just a string dump)", async () => {
    const script = join(tmpDir, "valid-json.js");
    writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : null;",
        "let valid = false;",
        "if (mcpPath) { try { JSON.parse(fs.readFileSync(mcpPath,'utf8')); valid = true; } catch(e) {} }",
        "process.stdout.write(JSON.stringify({type:'result',subtype:'success',total_cost_usd:0,num_turns:1,result:String(valid)}) + '\\n');",
      ].join("\n"),
    );

    const id = nextInvocationId();
    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers: {
        jsonServer: { type: "http", url: "http://json.example.com" },
      },
    });

    const result = await handle.done;
    expect(result.outputSummary).toBe("true");
  });

  test("multiple MCP servers all appear in the written file", async () => {
    const script = join(tmpDir, "multi-servers.js");
    writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : null;",
        "const fileContent = mcpPath ? fs.readFileSync(mcpPath, 'utf8') : 'NOT_FOUND';",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:fileContent}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      alpha: { type: "http", url: "http://alpha.example.com" },
      beta: { type: "http", url: "http://beta.example.com" },
      gamma: { command: "gamma-server", args: ["--port", "8080"] },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const parsed = JSON.parse(result.outputSummary) as {
      mcpServers: Record<string, unknown>;
    };

    expect(Object.keys(parsed.mcpServers)).toHaveLength(3);
    expect(parsed.mcpServers).toHaveProperty("alpha");
    expect(parsed.mcpServers).toHaveProperty("beta");
    expect(parsed.mcpServers).toHaveProperty("gamma");
  });

  test("MCP server with headers field is serialized correctly", async () => {
    const script = join(tmpDir, "headers-server.js");
    writeFileSync(
      script,
      [
        "const fs = require('fs');",
        "const argv = process.argv;",
        "const idx = argv.indexOf('--mcp-config');",
        "const mcpPath = idx !== -1 ? argv[idx + 1] : null;",
        "const fileContent = mcpPath ? fs.readFileSync(mcpPath, 'utf8') : 'NOT_FOUND';",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",total_cost_usd:0,num_turns:1,result:fileContent}) + "\\n");',
      ].join("\n"),
    );

    const id = nextInvocationId();
    const mcpServers: Record<string, McpServerConfig> = {
      authServer: {
        type: "http",
        url: "http://auth.example.com/mcp",
        headers: { Authorization: "Bearer secret-token", "X-Custom": "value" },
      },
    };

    const handle = spawnSession({
      agentPrompt: "test",
      worktreePath: tmpDir,
      maxTurns: 5,
      invocationId: id,
      projectRoot: tmpDir,
      claudePath: process.execPath,
      claudeArgs: [script],
      mcpServers,
    });

    const result = await handle.done;
    const parsed = JSON.parse(result.outputSummary) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };

    expect(parsed.mcpServers.authServer.headers).toEqual({
      Authorization: "Bearer secret-token",
      "X-Custom": "value",
    });
  });
});
