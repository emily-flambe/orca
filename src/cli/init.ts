// ---------------------------------------------------------------------------
// `orca init` — Interactive setup wizard
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { input, password, checkbox, confirm } from "@inquirer/prompts";
import { parse as dotenvParse } from "dotenv";
import { runPreflightChecks, type PreflightResult } from "./preflight.js";
import { LinearClient } from "../linear/client.js";
import { createDb } from "../db/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printCheck(r: PreflightResult): void {
  const icon = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
  const prefix = r.status === "ok" ? "  " : "  ";
  const versionStr = r.version ? ` ${r.version}` : "";
  const msg = r.message ? ` — ${r.message}` : "";
  console.log(`${prefix}${icon} ${r.name}${versionStr}${msg}`);
}

function run(cmd: string, args: string[], opts?: { timeout?: number }): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: opts?.timeout ?? 30_000,
  }).trim();
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
  console.log("\n=== Orca Setup ===\n");

  // -------------------------------------------------------------------------
  // Phase 1 — Preflight
  // -------------------------------------------------------------------------

  console.log("Checking prerequisites...");
  const checks = runPreflightChecks();
  for (const c of checks) {
    printCheck(c);
  }

  const missing = checks.filter((c) => c.status === "missing");
  if (missing.length > 0) {
    console.log(
      "\nRequired tools are missing. Install them and re-run `orca init`.",
    );
    process.exit(1);
  }
  console.log();

  // -------------------------------------------------------------------------
  // Phase 2 — Load existing .env
  // -------------------------------------------------------------------------

  const envPath = join(process.cwd(), ".env");
  let existing: Record<string, string> = {};
  if (existsSync(envPath)) {
    existing = dotenvParse(readFileSync(envPath, "utf8"));
    console.log("Found existing .env — using values as defaults.\n");
  }

  // -------------------------------------------------------------------------
  // Phase 3 — Linear API key
  // -------------------------------------------------------------------------

  console.log("--- Linear ---");
  let linearApiKey: string;
  if (existing.ORCA_LINEAR_API_KEY) {
    const useExisting = await confirm({
      message: "Use existing Linear API key from .env?",
      default: true,
    });
    if (useExisting) {
      linearApiKey = existing.ORCA_LINEAR_API_KEY;
    } else {
      linearApiKey = await password({
        message: "Linear API key:",
        mask: "*",
      });
    }
  } else {
    linearApiKey = await password({
      message: "Linear API key:",
      mask: "*",
    });
  }

  // Validate API key
  const client = new LinearClient(linearApiKey);
  let workspaceName: string;
  try {
    const viewer = await client.fetchViewer();
    workspaceName = viewer.organizationName;
    console.log(`  ✓ Connected (workspace: "${workspaceName}")\n`);
  } catch (err) {
    console.error(
      `  ✗ Failed to authenticate with Linear: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Phase 4 — Project selection
  // -------------------------------------------------------------------------

  const allProjects = await client.fetchAllProjects();
  if (allProjects.length === 0) {
    console.error("  ✗ No projects found in your Linear workspace.");
    process.exit(1);
  }

  // Pre-select projects from existing config
  let preselected: string[] = [];
  if (existing.ORCA_LINEAR_PROJECT_IDS) {
    try {
      preselected = JSON.parse(existing.ORCA_LINEAR_PROJECT_IDS);
    } catch {
      // ignore malformed
    }
  }

  const selectedProjectIds = await checkbox({
    message: "Select projects to sync:",
    choices: allProjects.map((p) => ({
      name: p.name,
      value: p.id,
      checked: preselected.includes(p.id),
    })),
    required: true,
  });

  if (selectedProjectIds.length === 0) {
    console.error("  ✗ At least one project must be selected.");
    process.exit(1);
  }

  console.log(`  ✓ ${selectedProjectIds.length} project(s) selected\n`);

  // -------------------------------------------------------------------------
  // Phase 5 — Repo paths
  // -------------------------------------------------------------------------

  // Check which projects have repo: lines
  const selectedProjects = allProjects.filter((p) =>
    selectedProjectIds.includes(p.id),
  );
  const projectsWithoutRepo = selectedProjects.filter((p) => {
    const repoMatch = (p.description || "").match(/^repo:\s*(.+)/m);
    return !repoMatch;
  });

  let defaultCwd = existing.ORCA_DEFAULT_CWD || "";
  if (projectsWithoutRepo.length > 0) {
    console.log(
      `Note: ${projectsWithoutRepo.length} project(s) missing \`repo:\` line in description:`,
    );
    for (const p of projectsWithoutRepo) {
      console.log(`  - ${p.name}`);
    }
    defaultCwd = await input({
      message: "Default repo path (ORCA_DEFAULT_CWD):",
      default: defaultCwd || process.cwd(),
    });
    console.log();
  }

  // -------------------------------------------------------------------------
  // Phase 6 — Cloudflare tunnel
  // -------------------------------------------------------------------------

  console.log("--- Cloudflare Tunnel ---");
  const tunnelName = await input({
    message: "Tunnel name:",
    default: existing.CLOUDFLARE_TUNNEL_ID ? "orca" : "orca",
  });

  const tunnelHostname = await input({
    message: "Hostname (e.g. orca.example.com):",
    default: existing.ORCA_TUNNEL_HOSTNAME || "",
  });

  if (!tunnelHostname) {
    console.error("  ✗ Hostname is required.");
    process.exit(1);
  }

  // Authenticate with Cloudflare
  const certPath = join(homedir(), ".cloudflared", "cert.pem");
  if (!existsSync(certPath)) {
    console.log("\n  Authenticating with Cloudflare... (browser will open)\n");
    try {
      execFileSync("cloudflared", ["tunnel", "login"], {
        stdio: "inherit",
        timeout: 120_000,
      });
      console.log("  ✓ Authenticated");
    } catch (err) {
      console.error(
        `  ✗ Cloudflare authentication failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  } else {
    console.log("  ✓ Already authenticated with Cloudflare");
  }

  // Check if tunnel already exists
  let tunnelId: string | null = null;
  try {
    const listOut = run("cloudflared", ["tunnel", "list", "-o", "json"]);
    const tunnels = JSON.parse(listOut) as Array<{
      id: string;
      name: string;
    }>;
    const existing_tunnel = tunnels.find(
      (t) => t.name.toLowerCase() === tunnelName.toLowerCase(),
    );
    if (existing_tunnel) {
      tunnelId = existing_tunnel.id;
      console.log(
        `  ✓ Tunnel "${tunnelName}" already exists (UUID: ${tunnelId})`,
      );
    }
  } catch {
    // tunnel list may fail if no tunnels exist — that's fine
  }

  // Create tunnel if needed
  if (!tunnelId) {
    try {
      const createOut = run("cloudflared", ["tunnel", "create", tunnelName]);
      // Parse UUID from output like "Created tunnel orca with id abc-123-def"
      const idMatch = createOut.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      );
      if (idMatch) {
        tunnelId = idMatch[1];
        console.log(`  ✓ Tunnel "${tunnelName}" created (UUID: ${tunnelId})`);
      } else {
        console.error(`  ✗ Could not parse tunnel UUID from: ${createOut}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `  ✗ Failed to create tunnel: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }

  // Create DNS route
  try {
    run("cloudflared", ["tunnel", "route", "dns", tunnelName, tunnelHostname]);
    console.log(`  ✓ DNS route: ${tunnelHostname} → tunnel`);
  } catch (err) {
    // May fail if CNAME already exists — that's usually fine
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      console.log(`  ✓ DNS route already exists for ${tunnelHostname}`);
    } else {
      console.warn(`  ⚠ DNS route creation failed: ${msg}`);
      console.warn("    You may need to manually add a CNAME record.");
    }
  }

  // Generate config.yml
  const cloudflaredDir = join(homedir(), ".cloudflared");
  const credentialsFile = join(cloudflaredDir, `${tunnelId}.json`);
  const configPath = join(cloudflaredDir, "config.yml");
  const configContent = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    `ingress:`,
    `  - hostname: ${tunnelHostname}`,
    `    service: http://localhost:3000`,
    `  - service: http_status:404`,
    "",
  ].join("\n");

  let writeConfig = true;
  if (existsSync(configPath)) {
    writeConfig = await confirm({
      message: `Overwrite existing ${configPath}?`,
      default: false,
    });
  }
  if (writeConfig) {
    writeFileSync(configPath, configContent, "utf8");
    console.log(`  ✓ Config written to ${configPath}`);
  }

  // Validate ingress
  try {
    run("cloudflared", ["tunnel", "ingress", "validate"]);
    console.log("  ✓ Ingress rules validated");
  } catch {
    console.warn("  ⚠ Ingress validation failed — check config.yml");
  }

  console.log();

  // -------------------------------------------------------------------------
  // Phase 7 — Webhook auto-creation
  // -------------------------------------------------------------------------

  console.log("--- Linear Webhook ---");
  let finalWebhookSecret = randomBytes(32).toString("hex");
  const webhookUrl = `https://${tunnelHostname}/api/webhooks/linear`;

  // Get unique team IDs across selected projects
  const projectMeta = await client.fetchProjectMetadata(selectedProjectIds);
  const teamIds = [...new Set(projectMeta.flatMap((p) => p.teamIds))];

  let webhookCreated = false;
  for (const teamId of teamIds) {
    try {
      await client.createWebhook(teamId, webhookUrl, finalWebhookSecret);
      webhookCreated = true;
    } catch (err) {
      console.warn(
        `  ⚠ Failed to create webhook for team ${teamId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (webhookCreated) {
    console.log(`  ✓ Webhook created at ${webhookUrl}`);
  } else {
    console.warn("  ⚠ Could not auto-create webhook.");
    console.warn(
      `    Create manually at Linear Settings → API → Webhooks with URL: ${webhookUrl}`,
    );
    finalWebhookSecret = await input({
      message: "Enter webhook secret (or press Enter to use generated secret):",
      default: finalWebhookSecret,
    });
  }

  console.log();

  // -------------------------------------------------------------------------
  // Phase 8 — Write .env
  // -------------------------------------------------------------------------

  console.log("--- Database ---");
  const dbPath = existing.ORCA_DB_PATH || "./orca.db";
  createDb(dbPath);
  console.log(`  ✓ Initialized at ${dbPath}\n`);

  // Build .env content
  const envLines: string[] = [
    "# =============================================================================",
    "# Orca Configuration (generated by `orca init`)",
    "# =============================================================================",
    "",
    "# --- Linear Integration (required) ---",
    "",
    `ORCA_LINEAR_API_KEY=${linearApiKey}`,
    `ORCA_LINEAR_WEBHOOK_SECRET=${finalWebhookSecret}`,
    `ORCA_LINEAR_PROJECT_IDS=${JSON.stringify(selectedProjectIds)}`,
    `ORCA_TUNNEL_HOSTNAME=${tunnelHostname}`,
    "",
    "# --- Cloudflare Tunnel ---",
    "",
    `CLOUDFLARE_TUNNEL_ID=${tunnelId}`,
  ];

  if (defaultCwd) {
    envLines.push(
      "",
      "# --- Default Repo ---",
      "",
      `ORCA_DEFAULT_CWD=${defaultCwd}`,
    );
  }

  // Preserve any extra vars from existing .env
  const generatedKeys = new Set([
    "ORCA_LINEAR_API_KEY",
    "ORCA_LINEAR_WEBHOOK_SECRET",
    "ORCA_LINEAR_PROJECT_IDS",
    "ORCA_TUNNEL_HOSTNAME",
    "CLOUDFLARE_TUNNEL_ID",
    "ORCA_DEFAULT_CWD",
  ]);
  const extraVars = Object.entries(existing).filter(
    ([k]) => !generatedKeys.has(k),
  );
  if (extraVars.length > 0) {
    envLines.push("", "# --- Preserved from previous .env ---", "");
    for (const [k, v] of extraVars) {
      envLines.push(`${k}=${v}`);
    }
  }

  envLines.push(""); // trailing newline
  const envContent = envLines.join("\n");

  let writeEnv = true;
  if (existsSync(envPath)) {
    writeEnv = await confirm({
      message: "Overwrite existing .env?",
      default: true,
    });
  }

  if (writeEnv) {
    writeFileSync(envPath, envContent, "utf8");
    console.log(
      `Wrote .env (${generatedKeys.size} vars + ${extraVars.length} preserved)`,
    );
  } else {
    console.log("Skipped .env write.");
  }

  // -------------------------------------------------------------------------
  // Phase 10 — Summary
  // -------------------------------------------------------------------------

  console.log("\n=== Setup Complete ===\n");
  console.log("Configured:");
  console.log(`  Linear workspace: ${workspaceName}`);
  console.log(`  Projects: ${selectedProjectIds.length}`);
  console.log(`  Tunnel: ${tunnelName} (${tunnelHostname})`);
  console.log(`  Database: ${dbPath}`);
  console.log();
  console.log("Run `npm run dev -- start` to launch orca.");
}
