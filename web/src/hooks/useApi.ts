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

export function fetchRunningInvocations(): Promise<
  import("../types").Invocation[]
> {
  return fetchJson<import("../types").Invocation[]>("/invocations/running");
}

export function fetchInvocationLogs(id: number): Promise<{ lines: unknown[] }> {
  return fetchJson<{ lines: unknown[] }>(`/invocations/${id}/logs`);
}

export function abortInvocation(id: number): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/invocations/${id}/abort`, {
    method: "POST",
  });
}

export function retryTask(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}/retry`, {
    method: "POST",
  });
}

export function updateTaskStatus(
  id: string,
  status: string,
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/tasks/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export function updateConfig(config: {
  concurrencyCap?: number;
  implementModel?: string;
  reviewModel?: string;
  fixModel?: string;
}): Promise<{
  ok: boolean;
  concurrencyCap: number;
  implementModel: string;
  reviewModel: string;
  fixModel: string;
}> {
  return fetchJson<{
    ok: boolean;
    concurrencyCap: number;
    implementModel: string;
    reviewModel: string;
    fixModel: string;
  }>("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export interface InvocationStat {
  status: string;
  count: number;
}

export interface RecentError {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  outputSummary: string | null;
  phase: string | null;
  costUsd: number | null;
}

export interface DailyStatEntry {
  date: string;
  completed: number;
  failed: number;
  costUsd: number;
}

export interface ActivityEntry {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  phase: string | null;
  costUsd: number | null;
}

export interface MetricsData {
  tasksByStatus: Record<string, number>;
  invocationStats: {
    byStatus: InvocationStat[];
    avgDurationSecs: number | null;
    avgCostUsd: number | null;
    totalCostUsd: number | null;
  };
  recentErrors: RecentError[];
  costLast24h: number;
  costLast7d: number;
  costPrev24h: number;
  dailyStats: DailyStatEntry[];
  recentActivity: ActivityEntry[];
  successRate12h: number | null;
}

export function fetchMetrics(): Promise<MetricsData> {
  return fetchJson<MetricsData>("/metrics");
}

export interface SystemLogsData {
  lines: string[];
  total: number;
  sizeBytes: number;
}

export function fetchSystemLogs(params?: {
  tail?: number;
  filter?: string;
}): Promise<SystemLogsData> {
  const qs = new URLSearchParams();
  if (params?.tail != null) qs.set("tail", String(params.tail));
  if (params?.filter) qs.set("filter", params.filter);
  const query = qs.toString();
  return fetchJson<SystemLogsData>(`/logs${query ? `?${query}` : ""}`);
}

export interface ProjectOption {
  id: string;
  name: string;
}

export function fetchProjects(): Promise<ProjectOption[]> {
  return fetchJson<ProjectOption[]>("/projects");
}

export function createTask(data: {
  title: string;
  description?: string;
  projectId?: string;
  priority?: number;
  status?: "todo" | "backlog";
}): Promise<{ identifier: string; id: string }> {
  return fetchJson<{ identifier: string; id: string }>("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
