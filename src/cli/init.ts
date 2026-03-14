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
import { createLogger } from "../logger.js";

const logger = createLogger("init");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printCheck(r: PreflightResult): void {
  const icon = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
  const prefix = r.status === "ok" ? "  " : "  ";
  const versionStr = r.version ? ` ${r.version}` : "";
  const msg = r.message ? ` — ${r.message}` : "";
  logger.info(`${prefix}${icon} ${r.name}${versionStr}${msg}`);
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
  logger.info("\n=== Orca Setup ===\n");

  // -------------------------------------------------------------------------
  // Phase 1 — Preflight
  // -------------------------------------------------------------------------

  logger.info("Checking prerequisites...");
  const checks = runPreflightChecks();
  for (const c of checks) {
    printCheck(c);
  }

  const missing = checks.filter((c) => c.status === "missing");
  if (missing.length > 0) {
    logger.info(
      "\nRequired tools are missing. Install them and re-run `orca init`.",
    );
    process.exit(1);
  }
  logger.info("");

  // -------------------------------------------------------------------------
  // Phase 2 — Load existing .env
  // -------------------------------------------------------------------------

  const envPath = join(process.cwd(), ".env");
  let existing: Record<string, string> = {};
  if (existsSync(envPath)) {
    existing = dotenvParse(readFileSync(envPath, "utf8"));
    logger.info("Found existing .env — using values as defaults.\n");
  }

  // -------------------------------------------------------------------------
  // Phase 3 — Linear API key
  // -------------------------------------------------------------------------

  logger.info("--- Linear ---");
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
    logger.info(`  ✓ Connected (workspace: "${workspaceName}")\n`);
  } catch (err) {
    logger.error(
      `  ✗ Failed to authenticate with Linear: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Phase 4 — Project selection
  // -------------------------------------------------------------------------

  const allProjects = await client.fetchAllProjects();
  if (allProjects.length === 0) {
    logger.error("  ✗ No projects found in your Linear workspace.");
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
    logger.error("  ✗ At least one project must be selected.");
    process.exit(1);
  }

  logger.info(`  ✓ ${selectedProjectIds.length} project(s) selected\n`);

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
    logger.info(
      `Note: ${projectsWithoutRepo.length} project(s) missing \`repo:\` line in description:`,
    );
    for (const p of projectsWithoutRepo) {
      logger.info(`  - ${p.name}`);
    }
    defaultCwd = await input({
      message: "Default repo path (ORCA_DEFAULT_CWD):",
      default: defaultCwd || process.cwd(),
    });
    logger.info("");
  }

  // -------------------------------------------------------------------------
  // Phase 6 — Cloudflare tunnel
  // -------------------------------------------------------------------------

  logger.info("--- Cloudflare Tunnel ---");
  const tunnelName = await input({
    message: "Tunnel name:",
    default: existing.CLOUDFLARE_TUNNEL_ID ? "orca" : "orca",
  });

  const tunnelHostname = await input({
    message: "Hostname (e.g. orca.example.com):",
    default: existing.ORCA_TUNNEL_HOSTNAME || "",
  });

  if (!tunnelHostname) {
    logger.error("  ✗ Hostname is required.");
    process.exit(1);
  }

  // Authenticate with Cloudflare
  const certPath = join(homedir(), ".cloudflared", "cert.pem");
  if (!existsSync(certPath)) {
    logger.info("\n  Authenticating with Cloudflare... (browser will open)\n");
    try {
      execFileSync("cloudflared", ["tunnel", "login"], {
        stdio: "inherit",
        timeout: 120_000,
      });
      logger.info("  ✓ Authenticated");
    } catch (err) {
      logger.error(
        `  ✗ Cloudflare authentication failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  } else {
    logger.info("  ✓ Already authenticated with Cloudflare");
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
      logger.info(
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
        logger.info(`  ✓ Tunnel "${tunnelName}" created (UUID: ${tunnelId})`);
      } else {
        logger.error(`  ✗ Could not parse tunnel UUID from: ${createOut}`);
        process.exit(1);
      }
    } catch (err) {
      logger.error(
        `  ✗ Failed to create tunnel: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }

  // Create DNS route
  try {
    run("cloudflared", ["tunnel", "route", "dns", tunnelName, tunnelHostname]);
    logger.info(`  ✓ DNS route: ${tunnelHostname} → tunnel`);
  } catch (err) {
    // May fail if CNAME already exists — that's usually fine
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      logger.info(`  ✓ DNS route already exists for ${tunnelHostname}`);
    } else {
      logger.warn(`  ⚠ DNS route creation failed: ${msg}`);
      logger.warn("    You may need to manually add a CNAME record.");
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
    logger.info(`  ✓ Config written to ${configPath}`);
  }

  // Validate ingress
  try {
    run("cloudflared", ["tunnel", "ingress", "validate"]);
    logger.info("  ✓ Ingress rules validated");
  } catch {
    logger.warn("  ⚠ Ingress validation failed — check config.yml");
  }

  logger.info("");

  // -------------------------------------------------------------------------
  // Phase 7 — Webhook auto-creation
  // -------------------------------------------------------------------------

  logger.info("--- Linear Webhook ---");
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
      logger.warn(
        `  ⚠ Failed to create webhook for team ${teamId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (webhookCreated) {
    logger.info(`  ✓ Webhook created at ${webhookUrl}`);
  } else {
    logger.warn("  ⚠ Could not auto-create webhook.");
    logger.warn(
      `    Create manually at Linear Settings → API → Webhooks with URL: ${webhookUrl}`,
    );
    finalWebhookSecret = await input({
      message: "Enter webhook secret (or press Enter to use generated secret):",
      default: finalWebhookSecret,
    });
  }

  logger.info("");

  // -------------------------------------------------------------------------
  // Phase 8 — Write .env
  // -------------------------------------------------------------------------

  logger.info("--- Database ---");
  const dbPath = existing.ORCA_DB_PATH || "./orca.db";
  createDb(dbPath);
  logger.info(`  ✓ Initialized at ${dbPath}\n`);

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
    logger.info(
      `Wrote .env (${generatedKeys.size} vars + ${extraVars.length} preserved)`,
    );
  } else {
    logger.info("Skipped .env write.");
  }

  // -------------------------------------------------------------------------
  // Phase 10 — Summary
  // -------------------------------------------------------------------------

  logger.info("\n=== Setup Complete ===\n");
  logger.info("Configured:");
  logger.info(`  Linear workspace: ${workspaceName}`);
  logger.info(`  Projects: ${selectedProjectIds.length}`);
  logger.info(`  Tunnel: ${tunnelName} (${tunnelHostname})`);
  logger.info(`  Database: ${dbPath}`);
  logger.info("");
  logger.info("Run `npm run dev -- start` to launch orca.");
}
