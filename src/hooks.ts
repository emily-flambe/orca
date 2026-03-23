import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the active Orca port from deploy-state.json, falling back to
 * the PORT environment variable, then to 4000.
 */
export function getOrcaPort(): number {
  try {
    const stateFile = join(process.cwd(), "deploy-state.json");
    if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, "utf-8")) as {
        activePort?: number;
      };
      if (typeof state.activePort === "number" && state.activePort > 0) {
        return state.activePort;
      }
    }
  } catch {
    // Non-critical — fall through to env var / default
  }

  const envPort = process.env["PORT"];
  if (envPort) {
    const parsed = Number(envPort);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 4000;
}

/**
 * Build the webhook URL for a given invocation ID.
 * Claude Code hooks POST to this URL when hook events fire.
 */
export function getHookUrl(invocationId: number): string {
  const port = getOrcaPort();
  return `http://localhost:${port}/api/hooks/${invocationId}`;
}
