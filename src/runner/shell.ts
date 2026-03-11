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
  let child: ChildProcess;

  // Use shell:true so the command string is interpreted as a shell command
  child = spawn(command, [], {
    cwd,
    shell: true,
    env: process.env,
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    // Force-kill after 5 more seconds
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 5000);
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
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
    done,
  };

  activeShellHandles.set(invocationId, handle);
  return handle;
}
