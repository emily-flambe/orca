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

export async function triggerSync(): Promise<{ synced: number }> {
  return fetchJson<{ synced: number }>("/sync", { method: "POST" });
}

export function fetchInvocationLogs(id: number): Promise<{ lines: unknown[] }> {
  return fetchJson<{ lines: unknown[] }>(`/invocations/${id}/logs`);
}

export function abortInvocation(id: number): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/invocations/${id}/abort`, { method: "POST" });
}

export function sendPrompt(invocationId: number, message: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/invocations/${invocationId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}
