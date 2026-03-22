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

export interface StatusPayload {
  activeSessions: number;
  queuedTasks: number;
  costInWindow: number;
  budgetLimit: number;
  budgetWindowHours: number;
  tokensInWindow: number;
  tokenBudgetLimit: number;
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

export function emitStatusUpdated(status: StatusPayload): void {
  orcaEvents.emit("status:updated", status);
}

export function emitTasksRefreshed(): void {
  orcaEvents.emit("tasks:refreshed");
}
