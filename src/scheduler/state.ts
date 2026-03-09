import type { SchedulerHandle } from "./index.js";

/**
 * Shared scheduler handle reference.
 * Stored here (not in cli/index.ts) to avoid circular dependencies.
 */
let handle: SchedulerHandle | null = null;

export function setSchedulerHandle(h: SchedulerHandle): void {
  handle = h;
}

export function getSchedulerHandle(): SchedulerHandle | null {
  return handle;
}
