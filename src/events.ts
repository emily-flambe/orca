import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Singleton event bus
// ---------------------------------------------------------------------------

export const orcaEvents = new EventEmitter();

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
}

export interface StatusPayload {
  activeSessions: number;
  queuedTasks: number;
  costInWindow: number;
  budgetLimit: number;
  budgetWindowHours: number;
}

// ---------------------------------------------------------------------------
// Typed emit helpers
// ---------------------------------------------------------------------------

export function emitTaskUpdated(task: unknown): void {
  orcaEvents.emit("task:updated", task);
}

export function emitInvocationStarted(payload: InvocationStartedPayload): void {
  orcaEvents.emit("invocation:started", payload);
}

export function emitInvocationCompleted(payload: InvocationCompletedPayload): void {
  orcaEvents.emit("invocation:completed", payload);
}

export function emitStatusUpdated(status: StatusPayload): void {
  orcaEvents.emit("status:updated", status);
}
