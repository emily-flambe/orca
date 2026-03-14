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
 *
 * Uses `detached: true` on non-Windows so the shell + children form a process
 * group that can be killed together via `process.kill(-pid)`.
 */
export function spawnShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs: number; invocationId: number },
): ShellHandle {
  const { cwd, timeoutMs, invocationId } = opts;
  const isWin = process.platform === "win32";

  // Use shell:true so the command string is interpreted as a shell command.
  // On non-Windows, detached:true creates a new process group so we can
  // kill the shell + all children together with process.kill(-pid).
  const child: ChildProcess = spawn(command, [], {
    cwd,
    shell: true,
    detached: !isWin,
    env: process.env,
  });

  // Unref the child on non-Windows so the process group leader doesn't
  // keep the parent alive if we forget to kill it. (detached children
  // do this automatically, but be explicit.)
  if (!isWin && child.pid) {
    child.unref();
  }

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  /** Kill the child process tree. */
  function killTree(): void {
    if (!child.pid) return;
    try {
      if (isWin) {
        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
      } else {
        // Kill entire process group (negative PID)
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      /* ignore — process may already be dead */
    }
  }

  /** Force-kill the child process tree. */
  function forceKillTree(): void {
    if (!child.pid) return;
    try {
      if (isWin) {
        execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    killTree();
    // Force-kill after 5 more seconds
    setTimeout(() => forceKillTree(), 5000);
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
