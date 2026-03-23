import { EventEmitter } from "node:events";
import { createLogger } from "./logger.js";

const logger = createLogger("hooks-store");

export interface HookEvent {
  timestamp: string;
  invocationId: number;
  payload: unknown;
}

interface HookEventState {
  events: HookEvent[];
  emitter: EventEmitter;
}

// In-memory store for hook events per invocation.
// Capped at MAX_INVOCATIONS entries total to prevent memory exhaustion.
export const hookEventStore = new Map<number, HookEventState>();

const MAX_INVOCATIONS = 500;

/**
 * Get or create the state for an invocation.
 * Evicts the oldest entry when the store exceeds MAX_INVOCATIONS.
 */
export function getOrCreateHookState(invocationId: number): HookEventState {
  let state = hookEventStore.get(invocationId);
  if (!state) {
    // Evict oldest entry if at capacity
    if (hookEventStore.size >= MAX_INVOCATIONS) {
      const oldestKey = hookEventStore.keys().next().value;
      if (oldestKey !== undefined) {
        hookEventStore.delete(oldestKey);
      }
    }
    state = { events: [], emitter: new EventEmitter() };
    hookEventStore.set(invocationId, state);
  }
  return state;
}

/**
 * Remove all stored hook events for an invocation.
 * Call when an invocation completes to free memory.
 */
export function clearHookEvents(invocationId: number): void {
  hookEventStore.delete(invocationId);
}

/**
 * Record an incoming hook event.
 * Keeps the last 200 events per invocation to bound memory usage.
 */
export function recordHookEvent(
  invocationId: number,
  payload: unknown,
): HookEvent {
  const state = getOrCreateHookState(invocationId);
  const event: HookEvent = {
    timestamp: new Date().toISOString(),
    invocationId,
    payload,
  };
  state.events.push(event);
  if (state.events.length > 200) {
    state.events.shift();
  }
  state.emitter.emit("hook", event);
  logger.info(
    `hook event for invocation ${invocationId}: ${JSON.stringify(payload).slice(0, 200)}`,
  );
  return event;
}

/**
 * Get all hook events for an invocation.
 */
export function getHookEvents(invocationId: number): HookEvent[] {
  return hookEventStore.get(invocationId)?.events ?? [];
}
