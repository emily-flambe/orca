import { execSync, spawn } from "node:child_process";
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
  // Use shell:true so the command string is interpreted as a shell command
  const child: ChildProcess = spawn(command, [], {
    cwd,
    shell: true,
    env: process.env,
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  /** Kill the child process tree (Windows-aware). */
  function killTree(): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore — process may already be dead */
    }
  }

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killTree();
    // Force-kill after 5 more seconds (non-Windows fallback)
    if (process.platform !== "win32") {
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5000);
    }
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
      killTree();
    },
    done,
  };

  activeShellHandles.set(invocationId, handle);
  return handle;
}
