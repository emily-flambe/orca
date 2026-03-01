import type { Task, TaskWithInvocations, OrcaStatus, ObservabilityMetrics, ObservabilityErrors, LogSearchResult } from "../types";

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

export function retryTask(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export function updateTaskStatus(id: string, status: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export function updateConfig(config: { concurrencyCap?: number }): Promise<{ ok: boolean; concurrencyCap: number }> {
  return fetchJson<{ ok: boolean; concurrencyCap: number }>("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function fetchObservabilityMetrics(): Promise<ObservabilityMetrics> {
  return fetchJson<ObservabilityMetrics>("/observability/metrics");
}

export function fetchObservabilityErrors(): Promise<ObservabilityErrors> {
  return fetchJson<ObservabilityErrors>("/observability/errors");
}

export function searchLogs(params: { q?: string; taskId?: string }): Promise<LogSearchResult> {
  const searchParams = new URLSearchParams();
  if (params.q) searchParams.set("q", params.q);
  if (params.taskId) searchParams.set("taskId", params.taskId);
  return fetchJson<LogSearchResult>(`/observability/logs/search?${searchParams.toString()}`);
}
