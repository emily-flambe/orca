import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Resolve the active Orca port from deploy-state.json.
 * Falls back to ORCA_PORT env var, then 4000.
 */
export function getActivePort(): number {
  try {
    const statePath = join(process.cwd(), "deploy-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      activePort?: number;
    };
    if (state.activePort) return state.activePort;
  } catch {
    // deploy-state.json missing or unreadable
  }
  return parseInt(process.env["ORCA_PORT"] ?? "4000", 10);
}

/**
 * Write .claude/settings.local.json into the worktree with hook config
 * pointing back to Orca's /api/hooks/:invocationId endpoint.
 *
 * Captures Notification and Stop events via curl POST to Orca.
 * Best-effort: errors are logged but don't block worktree setup.
 */
export function writeHookConfig(
  worktreePath: string,
  invocationId: number,
): void {
  try {
    const port = getActivePort();
    const hookUrl = `http://localhost:${port}/api/hooks/${invocationId}`;
    const hookCommand = `curl -s -X POST '${hookUrl}' -H 'Content-Type: application/json' -d @-`;

    const hookEntry = {
      hooks: [{ type: "command", command: hookCommand }],
    };

    const config = {
      hooks: {
        Notification: [hookEntry],
        Stop: [hookEntry],
      },
    };

    const claudeDir = join(worktreePath, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(config, null, 2),
      "utf8",
    );
  } catch (err) {
    process.stderr.write(
      `[orca/hooks] warning: failed to write hook config to ${worktreePath}: ${err}\n`,
    );
  }
}

/**
 * Remove the .claude/settings.local.json hook config from a worktree.
 * Best-effort: errors are silently ignored.
 */
export function cleanupHookConfig(worktreePath: string): void {
  try {
    const configPath = join(worktreePath, ".claude", "settings.local.json");
    if (existsSync(configPath)) {
      rmSync(configPath, { force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}
