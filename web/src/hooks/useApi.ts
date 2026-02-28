import type { Task, TaskWithInvocations, OrcaStatus } from "../types";

const BASE = "/api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "request failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchTasks(): Promise<Task[]> {
  return fetchJson<Task[]>("/tasks");
}

export function fetchTaskDetail(id: string): Promise<TaskWithInvocations> {
  return fetchJson<TaskWithInvocations>(`/tasks/${encodeURIComponent(id)}`);
}

export function fetchStatus(): Promise<OrcaStatus> {
  return fetchJson<OrcaStatus>("/status");
}

export async function updatePrompt(id: string, prompt: string): Promise<Task> {
  return fetchJson<Task>(`/tasks/${encodeURIComponent(id)}/prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

export async function dispatchTask(id: string): Promise<{ invocationId: number }> {
  return fetchJson<{ invocationId: number }>(`/tasks/${encodeURIComponent(id)}/dispatch`, {
    method: "POST",
  });
}

export async function triggerSync(): Promise<{ synced: number }> {
  return fetchJson<{ synced: number }>("/sync", { method: "POST" });
}
