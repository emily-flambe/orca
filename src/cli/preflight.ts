// ---------------------------------------------------------------------------
// Prerequisite checker for `orca init`
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { resolveClaudeBinary } from "../runner/index.js";

export interface PreflightResult {
  name: string;
  status: "ok" | "missing" | "warn";
  version?: string;
  message?: string;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 }).trim();
}

function checkNode(): PreflightResult {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);
  if (major < 22) {
    return {
      name: "Node.js",
      status: "warn",
      version,
      message: "Node.js >= 22 recommended",
    };
  }
  return { name: "Node.js", status: "ok", version };
}

function checkGit(): PreflightResult {
  try {
    const out = run("git", ["--version"]);
    const match = out.match(/(\d+(?:\.\d+)+)/);
    const version = match?.[1] ?? out;

    // On Windows, warn if core.longpaths is not enabled
    if (platform() === "win32") {
      try {
        const longpaths = run("git", ["config", "--global", "core.longpaths"]);
        if (longpaths !== "true") {
          return {
            name: "git",
            status: "warn",
            version,
            message:
              "git core.longpaths not enabled — run: git config --global core.longpaths true",
          };
        }
      } catch {
        return {
          name: "git",
          status: "warn",
          version,
          message:
            "git core.longpaths not enabled — run: git config --global core.longpaths true",
        };
      }
    }

    return { name: "git", status: "ok", version };
  } catch {
    return {
      name: "git",
      status: "missing",
      message:
        platform() === "win32"
          ? "Install git: winget install Git.Git"
          : "Install git: brew install git",
    };
  }
}

function checkClaude(): PreflightResult {
  try {
    const { command, prefixArgs } = resolveClaudeBinary("claude");
    const out = run(command, [...prefixArgs, "--version"]);
    const match = out.match(/(\d+(?:\.\d+)+)/);
    const version = match?.[1] ?? out;
    return { name: "claude CLI", status: "ok", version };
  } catch {
    return {
      name: "claude CLI",
      status: "missing",
      message: "Install Claude Code: npm install -g @anthropic-ai/claude-code",
    };
  }
}

function checkGh(): PreflightResult {
  try {
    const out = run("gh", ["--version"]);
    const match = out.match(/(\d+(?:\.\d+)+)/);
    const version = match?.[1] ?? out;

    // Check authentication
    try {
      const authOut = run("gh", ["auth", "status"]);
      const userMatch = authOut.match(/Logged in to .+ as (\S+)/);
      const user = userMatch?.[1];
      return {
        name: "gh CLI",
        status: "ok",
        version: user ? `${version} (authenticated as ${user})` : version,
      };
    } catch {
      return {
        name: "gh CLI",
        status: "warn",
        version,
        message: "gh CLI not authenticated — run: gh auth login",
      };
    }
  } catch {
    return {
      name: "gh CLI",
      status: "missing",
      message:
        platform() === "win32"
          ? "Install gh: winget install GitHub.cli"
          : "Install gh: brew install gh",
    };
  }
}

function checkCloudflared(): PreflightResult {
  const candidates =
    platform() === "darwin"
      ? ["cloudflared", "/opt/homebrew/bin/cloudflared"]
      : ["cloudflared"];

  for (const candidate of candidates) {
    try {
      const out = run(candidate, ["--version"]);
      const match = out.match(/(\d+(?:\.\d+)+)/);
      const version = match?.[1] ?? out;
      return { name: "cloudflared", status: "ok", version };
    } catch {
      // try next candidate
    }
  }

  return {
    name: "cloudflared",
    status: "missing",
    message:
      platform() === "win32"
        ? "Install cloudflared: winget install Cloudflare.cloudflared"
        : "Install cloudflared: brew install cloudflared",
  };
}

export function runPreflightChecks(): PreflightResult[] {
  return [
    checkNode(),
    checkGit(),
    checkClaude(),
    checkGh(),
    checkCloudflared(),
  ];
}
