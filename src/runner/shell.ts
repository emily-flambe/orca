import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface ShellResult {
  exitCode: number | null;
  output: string; // combined stdout + stderr
  timedOut: boolean;
}

export interface ShellHandle {
  kill(): void;
  done: Promise<ShellResult>;
}

/** Active shell processes keyed by invocation ID — for cleanup on shutdown. */
export const activeShellHandles = new Map<number, ShellHandle>();

/**
 * Spawn a shell command, capture combined stdout+stderr, enforce timeout.
 * Returns a handle with a `done` promise and a `kill()` method.
 */
export function spawnShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs: number; invocationId: number },
): ShellHandle {
  const { cwd, timeoutMs, invocationId } = opts;
  // Use shell:true so the command string is interpreted as a shell command.
  // On Unix, detached:true creates a new process group so we can kill the
  // entire tree (shell + children) via process.kill(-pid). On Windows,
  // process groups work differently so we fall back to child.kill().
  const useProcessGroup = process.platform !== "win32";
  const child: ChildProcess = spawn(command, [], {
    cwd,
    shell: true,
    env: process.env,
    detached: useProcessGroup,
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  function killTree(signal: NodeJS.Signals) {
    try {
      if (useProcessGroup && child.pid != null) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      /* ignore — process may already be gone */
    }
  }

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    // Force-kill after 5 more seconds
    setTimeout(() => killTree("SIGKILL"), 5000);
  }, timeoutMs);

  const done = new Promise<ShellResult>((resolve) => {
    child.on("close", (exitCode) => {
      clearTimeout(timeoutId);
      activeShellHandles.delete(invocationId);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({ exitCode, output, timedOut });
    });
  });

  const handle: ShellHandle = {
    kill() {
      clearTimeout(timeoutId);
      killTree("SIGTERM");
    },
    done,
  };

  activeShellHandles.set(invocationId, handle);
  return handle;
}
