import type {
  Task,
  TaskWithInvocations,
  OrcaStatus,
  CronSchedule,
  CronRun,
  Agent,
  AgentMemory,
} from "../types";

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

export function fetchVersion(): Promise<{ version: string }> {
  return fetchJson<{ version: string }>("/version");
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
  tokenBudgetLimit?: number;
  implementModel?: string;
  reviewModel?: string;
  fixModel?: string;
}): Promise<{
  ok: boolean;
  concurrencyCap: number;
  tokenBudgetLimit: number;
  implementModel: string;
  reviewModel: string;
  fixModel: string;
}> {
  return fetchJson<{
    ok: boolean;
    concurrencyCap: number;
    tokenBudgetLimit: number;
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
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface DailyStatEntry {
  date: string;
  completed: number;
  failed: number;
  costUsd: number;
  tokens: number;
}

export interface ActivityEntry {
  id: number;
  linearIssueId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  phase: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface SystemEvent {
  id: number;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MetricsData {
  // Observability fields
  uptime: {
    seconds: number | null;
    since: string | null;
    restartsToday: number;
  };
  throughput: {
    last24h: { completed: number; failed: number };
    last7d: { completed: number; failed: number };
  };
  errors: {
    lastHour: number;
    last24h: number;
  };
  queue: {
    ready: number;
    running: number;
    inReview: number;
  };
  budget: {
    windowHours: number;
  };
  recentEvents: SystemEvent[];
  // Legacy fields
  tasksByStatus: Record<string, number>;
  invocationStats: {
    byStatus: InvocationStat[];
    avgDurationSecs: number | null;
    avgCostUsd: number | null;
    totalCostUsd: number | null;
    avgTokens: number | null;
    totalTokens: number | null;
  };
  recentErrors: RecentError[];
  tokensLast24h: number;
  tokensLast7d: number;
  tokensPrev24h: number;
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

export interface TaskStateTransition {
  id: number;
  linearIssueId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  invocationId: number | null;
  createdAt: string;
}

export function fetchTaskTransitions(
  id: string,
): Promise<TaskStateTransition[]> {
  return fetchJson<TaskStateTransition[]>(
    `/tasks/${encodeURIComponent(id)}/transitions`,
  );
}

export function fetchCronSchedules(): Promise<CronSchedule[]> {
  return fetchJson<CronSchedule[]>("/cron");
}

export function fetchCronRuns(scheduleId: number): Promise<CronRun[]> {
  return fetchJson<CronRun[]>(`/cron/${scheduleId}/runs`);
}

export function fetchCronTasks(
  scheduleId: number,
): Promise<import("../types").TaskWithInvocations[]> {
  return fetchJson<import("../types").TaskWithInvocations[]>(
    `/cron/${scheduleId}/tasks`,
  );
}

export function createCronSchedule(data: {
  name: string;
  type: "claude" | "shell";
  schedule: string;
  prompt: string;
  repoPath?: string;
  model?: string;
  maxTurns?: number;
  timeoutMin?: number;
  maxRuns?: number;
  enabled?: number;
}): Promise<CronSchedule> {
  return fetchJson<CronSchedule>("/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateCronSchedule(
  id: number,
  data: Partial<{
    name: string;
    type: "claude" | "shell";
    schedule: string;
    prompt: string;
    repoPath: string | null;
    model: string | null;
    maxTurns: number | null;
    timeoutMin: number;
    maxRuns: number | null;
    enabled: number;
  }>,
): Promise<CronSchedule> {
  return fetchJson<CronSchedule>(`/cron/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteCronSchedule(id: number): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/cron/${id}`, { method: "DELETE" });
}

export function triggerCron(id: number): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/cron/${id}/trigger`, { method: "POST" });
}

export async function fetchInngestWorkflows(): Promise<
  import("../types").InngestWorkflow[]
> {
  const res = await fetchJson<{
    functions: import("../types").InngestWorkflow[];
    error?: string;
  }>("/inngest/workflows");
  return res.functions;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function fetchAgents(): Promise<Agent[]> {
  return fetchJson<Agent[]>("/agents");
}

export function fetchAgentDetail(
  id: string,
): Promise<Agent & { memories: AgentMemory[]; tasks: Task[] }> {
  return fetchJson<Agent & { memories: AgentMemory[]; tasks: Task[] }>(
    `/agents/${encodeURIComponent(id)}`,
  );
}

export function createAgent(
  data: Partial<Agent> & { id: string; name: string; systemPrompt: string },
): Promise<Agent> {
  return fetchJson<Agent>("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateAgent(id: string, data: Partial<Agent>): Promise<Agent> {
  return fetchJson<Agent>(`/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteAgent(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function toggleAgent(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    `/agents/${encodeURIComponent(id)}/toggle`,
    { method: "POST" },
  );
}

export function triggerAgent(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    `/agents/${encodeURIComponent(id)}/trigger`,
    { method: "POST" },
  );
}

export function deleteAgentMemory(
  agentId: string,
  memoryId: number,
): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(
    `/agents/${encodeURIComponent(agentId)}/memories/${memoryId}`,
    { method: "DELETE" },
  );
}

export type { CronSchedule };
