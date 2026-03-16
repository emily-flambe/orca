// ---------------------------------------------------------------------------
// File I/O helpers for task tracking state
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskTrackingState } from "./stuck-tasks.js";

export const DEFAULT_STATE_FILE = "tmp/task-state-tracking.json";

/**
 * Load tracking state from disk. Returns {} if file doesn't exist.
 */
export async function loadTrackingState(
  filePath: string = DEFAULT_STATE_FILE,
): Promise<TaskTrackingState> {
  try {
    const contents = await readFile(filePath, "utf8");
    return JSON.parse(contents) as TaskTrackingState;
  } catch (err) {
    // File not found or parse error — start fresh
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

/**
 * Save tracking state to disk. Creates tmp/ dir if needed.
 */
export async function saveTrackingState(
  state: TaskTrackingState,
  filePath: string = DEFAULT_STATE_FILE,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}
