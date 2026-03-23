import { EventEmitter } from "node:events";
import type { Task } from "./db/queries.js";

// ---------------------------------------------------------------------------
// Singleton event bus
// ---------------------------------------------------------------------------

export const orcaEvents = new EventEmitter();
orcaEvents.setMaxListeners(50);

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface InvocationStartedPayload {
  taskId: string;
  invocationId: number;
}

export interface InvocationCompletedPayload {
  taskId: string;
  invocationId: number;
  status: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Typed emit helpers
// ---------------------------------------------------------------------------

export function emitTaskUpdated(task: Task): void {
  orcaEvents.emit("task:updated", task);
}

export function emitInvocationStarted(payload: InvocationStartedPayload): void {
  orcaEvents.emit("invocation:started", payload);
}

export function emitInvocationCompleted(
  payload: InvocationCompletedPayload,
): void {
  orcaEvents.emit("invocation:completed", payload);
}

export function emitTasksRefreshed(): void {
  orcaEvents.emit("tasks:refreshed");
}

// ---------------------------------------------------------------------------
// Hook events
// ---------------------------------------------------------------------------

export interface HookEventPayload {
  invocationId: number;
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export function emitHookEvent(payload: HookEventPayload): void {
  orcaEvents.emit("hook:event", payload);
}
