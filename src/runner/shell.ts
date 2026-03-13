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
 * Kill a child process and its entire process group.
 * On POSIX, sends the signal to -pid (the process group) so grandchildren
 * spawned by the shell intermediary are also killed.
 * On Windows, falls back to child.kill() since process groups work differently.
 */
function killProcessGroup(child: ChildProcess, signal: "SIGTERM" | "SIGKILL") {
  if (process.platform !== "win32" && child.pid != null) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* process may already be dead — fall through */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

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
  // detached:true on POSIX puts the child in its own process group so we can
  // kill the entire group (shell + grandchildren) with process.kill(-pid, sig).
  const child: ChildProcess = spawn(command, [], {
    cwd,
    shell: true,
    env: process.env,
    detached: process.platform !== "win32",
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, "SIGTERM");
    // Force-kill after 5 more seconds
    setTimeout(() => {
      killProcessGroup(child, "SIGKILL");
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
      killProcessGroup(child, "SIGTERM");
    },
    done,
  };

  activeShellHandles.set(invocationId, handle);
  return handle;
}
