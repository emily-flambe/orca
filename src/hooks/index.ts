import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("hooks");

/**
 * Write Claude Code hook configuration to <worktreePath>/.claude/settings.local.json.
 *
 * Configures Notification and Stop hooks to POST structured events back to
 * the Orca API at /api/hooks/<invocationId>. Uses mkdirSync with recursive:true
 * so the .claude directory is created if it doesn't exist.
 *
 * Best-effort: logs a warning and does not throw on failure.
 */
export function writeHookConfig(
  worktreePath: string,
  invocationId: number,
  port: number,
): void {
  try {
    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const hookUrl = `http://localhost:${port}/api/hooks/${invocationId}`;
    const config = {
      hooks: {
        Notification: [
          {
            hooks: [
              {
                type: "http",
                url: hookUrl,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "http",
                url: hookUrl,
              },
            ],
          },
        ],
      },
    };

    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(config, null, 2),
    );
    logger.info(
      `wrote hook config for invocation ${invocationId} at port ${port}`,
    );
  } catch (err) {
    logger.warn(
      `failed to write hook config for invocation ${invocationId}: ${err}`,
    );
  }
}

/**
 * Remove Claude Code hook configuration from <worktreePath>/.claude/settings.local.json.
 *
 * Best-effort: logs a warning and does not throw on failure.
 */
export function cleanupHookConfig(worktreePath: string): void {
  try {
    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    rmSync(settingsPath, { force: true });
  } catch (err) {
    logger.warn(`failed to cleanup hook config at ${worktreePath}: ${err}`);
  }
}
