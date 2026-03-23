import {
  mkdirSync,
  writeFileSync,
  rmSync,
  rmdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const logger = createLogger("hooks");

/**
 * Write a .claude/settings.local.json to the worktree that configures
 * Claude Code hooks to POST events back to Orca's hook endpoint.
 *
 * Merges with any existing settings.local.json so that pre-existing
 * `permissions`, `PreToolUse`, and other hooks are preserved.
 *
 * Called before agent spawn so Claude Code picks up the config.
 */
export function writeHookConfig(
  worktreePath: string,
  invocationId: number,
  port: number,
): void {
  const claudeDir = join(worktreePath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");
  const hookUrl = `http://localhost:${port}/api/hooks/${invocationId}`;

  // Build hook command: reads JSON from stdin, POSTs to Orca
  const command = `curl -s -X POST "${hookUrl}" -H "Content-Type: application/json" --data-binary @-`;

  const hookEntry = {
    matcher: "",
    hooks: [{ type: "command", command }],
  };

  const orcaHooks = {
    Notification: [hookEntry],
    Stop: [hookEntry],
  };

  try {
    mkdirSync(claudeDir, { recursive: true });

    // Merge with existing settings to preserve user-configured hooks/permissions
    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        // Existing file is corrupt — start fresh
      }
    }

    const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
    const merged = {
      ...existing,
      hooks: {
        ...existingHooks,
        // Prepend Orca hooks so they run first; preserve any existing entries
        Notification: [
          ...(orcaHooks.Notification as unknown[]),
          ...(existingHooks.Notification ?? []),
        ],
        Stop: [...(orcaHooks.Stop as unknown[]), ...(existingHooks.Stop ?? [])],
      },
    };

    writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf-8");
    logger.info(
      `wrote hook config for invocation ${invocationId} at ${settingsPath}`,
    );
  } catch (err) {
    // Non-fatal: log warning but don't fail worktree setup
    logger.warn(
      `failed to write hook config for invocation ${invocationId}: ${err}`,
    );
  }
}

/**
 * Remove the .claude/settings.local.json hook config from the worktree.
 * Also removes the .claude directory if it is now empty (i.e. Orca created it).
 * Best-effort: the whole worktree directory is typically deleted on teardown
 * anyway, but this handles explicit cleanup scenarios.
 */
export function cleanHookConfig(worktreePath: string): void {
  const claudeDir = join(worktreePath, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");
  if (!existsSync(settingsPath)) return;
  try {
    rmSync(settingsPath);
    logger.info(`cleaned hook config at ${settingsPath}`);
  } catch (err) {
    logger.warn(`failed to clean hook config at ${settingsPath}: ${err}`);
    return;
  }
  // Remove the .claude directory if it is now empty (best-effort)
  try {
    rmdirSync(claudeDir);
  } catch {
    // Non-empty (other files present) — leave it alone
  }
}
