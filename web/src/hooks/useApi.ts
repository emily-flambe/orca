import type { Task, TaskWithInvocations, OrcaStatus, OrcaMetrics, SystemLogs } from "../types";

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

export function fetchMetrics(): Promise<OrcaMetrics> {
  return fetchJson<OrcaMetrics>("/metrics");
}

export function fetchSystemLogs(params?: {
  lines?: number;
  search?: string;
  level?: string;
}): Promise<SystemLogs> {
  const query = new URLSearchParams();
  if (params?.lines) query.set("lines", String(params.lines));
  if (params?.search) query.set("search", params.search);
  if (params?.level) query.set("level", params.level);
  const qs = query.toString();
  return fetchJson<SystemLogs>(`/logs/system${qs ? `?${qs}` : ""}`);
}
