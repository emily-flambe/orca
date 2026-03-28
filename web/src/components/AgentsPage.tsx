import { useState, useEffect, useCallback } from "react";
import type { Agent, AgentMemory, Task, Invocation } from "../types";
import {
  fetchAgents,
  fetchAgentDetail,
  fetchTaskDetail,
  createAgent,
  updateAgent,
  deleteAgent,
  toggleAgent,
  triggerAgent,
  deleteAgentMemory,
  assignTaskAgent,
  fetchTasks,
} from "../hooks/useApi";
import { formatTimestamp, formatDurationMs } from "../utils/time.js";
import LogViewer from "./LogViewer";
import { getPhaseDisplayText } from "./ui/StatusBadge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return "\u2014";
  const d = new Date(lastRunAt);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 0) return "just now";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return "\u2014";
  const d = new Date(nextRunAt);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs < 0) return "overdue";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `in ${diffH}h`;
  return d.toLocaleDateString();
}

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  maxTurns: string;
  timeoutMin: string;
  repoPath: string;
  schedule: string;
  linearLabel: string;
  maxMemories: string;
  enabled: boolean;
}

const DEFAULT_FORM: FormState = {
  id: "",
  name: "",
  description: "",
  systemPrompt: "",
  model: "",
  maxTurns: "",
  timeoutMin: "45",
  repoPath: "",
  schedule: "",
  linearLabel: "",
  maxMemories: "100",
  enabled: true,
};

function agentToForm(a: Agent): FormState {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? "",
    systemPrompt: a.systemPrompt,
    model: a.model ?? "",
    maxTurns: a.maxTurns != null ? String(a.maxTurns) : "",
    timeoutMin: String(a.timeoutMin),
    repoPath: a.repoPath ?? "",
    schedule: a.schedule ?? "",
    linearLabel: a.linearLabel ?? "",
    maxMemories: String(a.maxMemories),
    enabled: a.enabled === 1,
  };
}

// ---------------------------------------------------------------------------
// Inline form
// ---------------------------------------------------------------------------

function AgentForm({
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  initial: FormState;
  isNew: boolean;
  onSave: (data: FormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // Auto-generate id from name when creating
      if (isNew && key === "name" && typeof value === "string") {
        next.id = generateId(value);
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.systemPrompt.trim()) {
      setError("Name and system prompt are required.");
      return;
    }
    if (isNew && !form.id.trim()) {
      setError("ID is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors";
  const labelClass = "text-xs text-gray-400 block mb-1";

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-gray-900 border border-gray-700 rounded-lg p-4 space-y-3"
    >
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-1">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Name *</label>
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Code Reviewer"
          />
        </div>
        <div>
          <label className={labelClass}>ID {isNew ? "*" : "(read-only)"}</label>
          <input
            className={inputClass}
            value={form.id}
            onChange={(e) => set("id", e.target.value)}
            placeholder="code-reviewer"
            readOnly={!isNew}
            tabIndex={isNew ? undefined : -1}
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Description (optional)</label>
        <input
          className={inputClass}
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What this agent does"
        />
      </div>

      <div>
        <label className={labelClass}>System prompt *</label>
        <textarea
          className={`${inputClass} min-h-[80px] resize-y`}
          value={form.systemPrompt}
          onChange={(e) => set("systemPrompt", e.target.value)}
          placeholder="You are an agent that..."
        />
      </div>

      <div>
        <label className={labelClass}>
          Schedule (optional, cron expression)
        </label>
        <input
          className={inputClass}
          value={form.schedule}
          onChange={(e) => set("schedule", e.target.value)}
          placeholder="0 2 * * *"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Repo path (optional)</label>
          <input
            className={inputClass}
            value={form.repoPath}
            onChange={(e) => set("repoPath", e.target.value)}
            placeholder="/path/to/repo"
          />
        </div>
        <div>
          <label className={labelClass}>Linear label (optional)</label>
          <input
            className={inputClass}
            value={form.linearLabel}
            onChange={(e) => set("linearLabel", e.target.value)}
            placeholder={`agent:${form.id || "agent-id"}`}
          />
          <span className="text-xs text-gray-600 mt-0.5 block">
            Tickets with this label auto-route to this agent
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Model (optional)</label>
          <input
            className={inputClass}
            value={form.model}
            onChange={(e) => set("model", e.target.value)}
            placeholder="opus"
          />
        </div>
        <div>
          <label className={labelClass}>Max turns (optional)</label>
          <input
            type="number"
            className={`${inputClass} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            value={form.maxTurns}
            onChange={(e) => set("maxTurns", e.target.value)}
            placeholder="50"
          />
        </div>
        <div>
          <label className={labelClass}>Timeout (min)</label>
          <input
            type="number"
            className={`${inputClass} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            value={form.timeoutMin}
            onChange={(e) => set("timeoutMin", e.target.value)}
            placeholder="45"
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Max memories</label>
        <input
          type="number"
          className={`${inputClass} w-32 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
          value={form.maxMemories}
          onChange={(e) => set("maxMemories", e.target.value)}
          placeholder="100"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled ? "true" : "false"}
          aria-label="Enable agent"
          onClick={() => set("enabled", !form.enabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.enabled ? "bg-blue-600" : "bg-gray-600"}`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${form.enabled ? "translate-x-4" : "translate-x-1"}`}
          />
        </button>
        <span className="text-sm text-gray-400">Enabled</span>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="px-3 py-1.5 rounded text-xs bg-blue-600 text-blue-100 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Agent detail (memories + recent tasks) — inline expansion
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline task row with expandable log viewer
// ---------------------------------------------------------------------------

function TaskLogRow({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [invocations, setInvocations] = useState<Invocation[] | null>(null);
  const [loadingInvocations, setLoadingInvocations] = useState(false);

  const statusColors: Record<string, string> = {
    done: "bg-green-900/40 text-green-400 border-green-700/40",
    failed: "bg-red-900/40 text-red-400 border-red-700/40",
    active: "bg-blue-900/40 text-blue-400 border-blue-700/40",
    ready: "bg-yellow-900/40 text-yellow-400 border-yellow-700/40",
    canceled: "bg-gray-800 text-gray-500 border-gray-700",
  };
  const statusCls =
    statusColors[task.lifecycleStage ?? task.orcaStatus] ??
    "bg-gray-800 text-gray-400 border-gray-700";

  function handleToggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (invocations === null) {
      setLoadingInvocations(true);
      fetchTaskDetail(task.linearIssueId)
        .then((detail) => setInvocations(detail.invocations))
        .catch(() => setInvocations([]))
        .finally(() => setLoadingInvocations(false));
    }
  }

  return (
    <div className="space-y-1">
      <div
        className="bg-gray-800/50 rounded px-2 py-1.5 flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-700/50 transition-colors"
        onClick={handleToggle}
        title="Click to view logs"
      >
        <span className={`px-1.5 py-0.5 rounded-full border ${statusCls}`}>
          {getPhaseDisplayText(task.lifecycleStage ?? "", task.currentPhase)}
        </span>
        <span
          className="text-gray-500 font-mono truncate max-w-[200px]"
          title={task.linearIssueId}
        >
          {task.linearIssueId}
        </span>
        <span className="text-gray-400 ml-auto shrink-0">
          {formatTimestamp(task.createdAt)}
        </span>
        <span className="text-gray-500 shrink-0">{expanded ? "▴" : "▾"}</span>
      </div>
      {expanded && (
        <div className="ml-2">
          {loadingInvocations && (
            <div className="text-xs text-gray-500 py-1">
              Loading invocations...
            </div>
          )}
          {invocations !== null && invocations.length === 0 && (
            <div className="text-xs text-gray-500 italic py-1">
              No invocations for this task.
            </div>
          )}
          {invocations !== null && invocations.length > 0 && (
            <div className="space-y-1">
              {invocations.map((inv) => (
                <InvocationLogRow key={inv.id} inv={inv} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InvocationLogRow({ inv }: { inv: Invocation }) {
  const [showLog, setShowLog] = useState(false);

  const durationMs =
    inv.startedAt && inv.endedAt
      ? new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime()
      : null;

  return (
    <div className="bg-gray-900 rounded px-2 py-1.5 space-y-1 border border-gray-800">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`px-1.5 py-0.5 rounded-full border ${
            inv.status === "completed"
              ? "bg-green-900/40 text-green-400 border-green-700/40"
              : inv.status === "failed"
                ? "bg-red-900/40 text-red-400 border-red-700/40"
                : inv.status === "running"
                  ? "bg-blue-900/40 text-blue-400 border-blue-700/40"
                  : "bg-gray-800 text-gray-400 border-gray-700"
          }`}
        >
          {inv.status}
        </span>
        <span className="text-gray-500 font-mono">{inv.phase ?? "---"}</span>
        <span className="text-gray-400">{formatTimestamp(inv.startedAt)}</span>
        <span className="text-gray-500">{formatDurationMs(durationMs)}</span>
        {inv.costUsd != null && (
          <span className="text-gray-500">${inv.costUsd.toFixed(4)}</span>
        )}
        <button
          onClick={() => setShowLog((v) => !v)}
          className="text-gray-500 hover:text-gray-300 transition-colors ml-auto"
        >
          {showLog ? "hide logs" : "view logs"}
        </button>
      </div>
      {showLog && (
        <div className="mt-1">
          <LogViewer
            invocationId={inv.id}
            isRunning={inv.status === "running"}
            outputSummary={inv.outputSummary}
            compact
          />
        </div>
      )}
    </div>
  );
}

function AgentDetail({
  agentId,
  onToast,
}: {
  agentId: string;
  onToast?: ToastCallbacks;
}) {
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [availableTickets, setAvailableTickets] = useState<Task[]>([]);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [deletingMemoryId, setDeletingMemoryId] = useState<number | null>(null);
  const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<number>>(
    new Set(),
  );

  const loadDetail = useCallback(() => {
    setLoading(true);
    setFetchError(null);
    fetchAgentDetail(agentId)
      .then((detail) => {
        setMemories(detail.memories);
        setTasks(detail.tasks);
      })
      .catch((err) => {
        setMemories([]);
        setTasks([]);
        setFetchError(
          err instanceof Error ? err.message : "Failed to load agent details",
        );
      })
      .finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    fetchTasks()
      .then((allTasks: Task[]) => {
        const assignable = allTasks.filter(
          (t: Task) =>
            (t.taskType === "linear" || t.taskType === null) &&
            !t.agentId &&
            t.lifecycleStage !== "active" && t.lifecycleStage !== "done",
        );
        setAvailableTickets(assignable);
      })
      .catch(console.error);
  }, []);

  function toggleMemoryExpanded(memoryId: number) {
    setExpandedMemoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(memoryId)) {
        next.delete(memoryId);
      } else {
        next.add(memoryId);
      }
      return next;
    });
  }

  async function handleDeleteMemory(memoryId: number) {
    try {
      await deleteAgentMemory(agentId, memoryId);
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
      setDeletingMemoryId(null);
      onToast?.success("Memory deleted");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to delete memory",
      );
    }
  }

  if (loading) {
    return <div className="text-xs text-gray-500 py-2">Loading details...</div>;
  }

  if (fetchError) {
    return (
      <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-2 py-2 flex items-center gap-2">
        <span>{fetchError}</span>
        <button
          onClick={loadDetail}
          className="px-2 py-0.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-2">
      {/* Memories */}
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Memories ({memories.length})
        </div>
        {memories.length === 0 ? (
          <div className="text-xs text-gray-500 italic">No memories yet.</div>
        ) : (
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {memories.map((m) => (
              <div
                key={m.id}
                className="bg-gray-800/50 rounded px-2 py-1.5 flex items-start gap-2"
              >
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full border shrink-0 ${
                    m.type === "episodic"
                      ? "bg-blue-900/40 text-blue-400 border-blue-700/40"
                      : m.type === "semantic"
                        ? "bg-green-900/40 text-green-400 border-green-700/40"
                        : "bg-purple-900/40 text-purple-400 border-purple-700/40"
                  }`}
                >
                  {m.type}
                </span>
                <p
                  className={`text-xs text-gray-400 flex-1 cursor-pointer hover:text-gray-300 transition-colors whitespace-pre-wrap ${expandedMemoryIds.has(m.id) ? "" : "line-clamp-2"}`}
                  onClick={() => toggleMemoryExpanded(m.id)}
                  title={
                    expandedMemoryIds.has(m.id)
                      ? "Click to collapse"
                      : "Click to expand"
                  }
                >
                  {m.content}
                </p>
                <span className="text-xs text-gray-600 shrink-0">
                  {formatTimestamp(m.createdAt)}
                </span>
                {deletingMemoryId === m.id ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleDeleteMemory(m.id)}
                      className="px-1 text-xs text-red-400 hover:text-red-300"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setDeletingMemoryId(null)}
                      className="px-1 text-xs text-gray-400 hover:text-gray-200"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeletingMemoryId(m.id)}
                    className="text-xs text-gray-600 hover:text-red-400 shrink-0 transition-colors"
                    title="Delete memory"
                  >
                    x
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Assign ticket */}
      {availableTickets.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
            Assign Ticket
          </div>
          <div className="flex items-center gap-2">
            <select
              value=""
              onChange={async (e) => {
                const ticketId = e.target.value;
                if (!ticketId) return;
                setAssigningId(ticketId);
                try {
                  await assignTaskAgent(ticketId, agentId);
                  // Refresh both lists
                  loadDetail();
                  setAvailableTickets((prev) =>
                    prev.filter((t) => t.linearIssueId !== ticketId),
                  );
                  onToast?.success(`Assigned ${ticketId} to agent`);
                } catch (err) {
                  onToast?.error(
                    err instanceof Error
                      ? err.message
                      : "Failed to assign ticket",
                  );
                } finally {
                  setAssigningId(null);
                }
              }}
              disabled={assigningId !== null}
              className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 cursor-pointer hover:border-gray-500 transition-colors flex-1"
            >
              <option value="">Select a ticket...</option>
              {availableTickets.map((t) => (
                <option key={t.linearIssueId} value={t.linearIssueId}>
                  {t.linearIssueId} — {(t.agentPrompt ?? "").slice(0, 60)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Recent tasks */}
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
          Recent Tasks ({tasks.length})
        </div>
        {tasks.length === 0 ? (
          <div className="text-xs text-gray-500 italic">No tasks yet.</div>
        ) : (
          <div className="space-y-1">
            {tasks.map((t) => (
              <TaskLogRow key={t.linearIssueId} task={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface ToastCallbacks {
  success: (msg: string) => void;
  error: (msg: string) => void;
}

export default function AgentsPage({ onToast }: { onToast?: ToastCallbacks }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [promptExpandedIds, setPromptExpandedIds] = useState<Set<string>>(
    new Set(),
  );

  const load = useCallback(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(form: FormState) {
    const agent = await createAgent({
      id: form.id,
      name: form.name,
      description: form.description || null,
      systemPrompt: form.systemPrompt,
      model: form.model || null,
      maxTurns: form.maxTurns ? parseInt(form.maxTurns, 10) : null,
      timeoutMin: form.timeoutMin ? parseInt(form.timeoutMin, 10) : 45,
      repoPath: form.repoPath || null,
      schedule: form.schedule || null,
      linearLabel: form.linearLabel || null,
      maxMemories: form.maxMemories ? parseInt(form.maxMemories, 10) : 100,
      enabled: form.enabled ? 1 : 0,
    });
    setAgents((prev) => [...prev, agent]);
    setShowNew(false);
    onToast?.success("Agent created");
  }

  async function handleUpdate(id: string, form: FormState) {
    try {
      const agent = await updateAgent(id, {
        name: form.name,
        description: form.description || null,
        systemPrompt: form.systemPrompt,
        model: form.model || null,
        maxTurns: form.maxTurns ? parseInt(form.maxTurns, 10) : null,
        timeoutMin: form.timeoutMin ? parseInt(form.timeoutMin, 10) : 45,
        repoPath: form.repoPath || null,
        schedule: form.schedule || null,
        linearLabel: form.linearLabel || null,
        maxMemories: form.maxMemories ? parseInt(form.maxMemories, 10) : 100,
        enabled: form.enabled ? 1 : 0,
      });
      setAgents((prev) => prev.map((a) => (a.id === id ? agent : a)));
      setEditingId(null);
      onToast?.success("Agent updated");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to update agent",
      );
    }
  }

  async function handleToggle(a: Agent) {
    if (togglingId === a.id) return;
    setTogglingId(a.id);
    try {
      await toggleAgent(a.id);
      // Refetch to get the updated state
      const updated = await fetchAgents();
      setAgents(updated);
      onToast?.success(a.enabled === 1 ? "Agent disabled" : "Agent enabled");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to toggle agent",
      );
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTrigger(a: Agent) {
    if (triggeringId === a.id) return;
    setTriggeringId(a.id);
    try {
      await triggerAgent(a.id);
      onToast?.success(`Triggered: ${a.name}`);
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to trigger agent",
      );
    } finally {
      setTriggeringId(null);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteAgent(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
      setDeletingId(null);
      onToast?.success("Agent deleted");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to delete agent",
      );
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Agents
        </h2>
        {!showNew && (
          <button
            onClick={() => setShowNew(true)}
            className="px-3 py-1.5 rounded text-xs bg-blue-600 text-blue-100 hover:bg-blue-700 transition-colors"
          >
            New agent
          </button>
        )}
      </div>

      {showNew && (
        <AgentForm
          initial={DEFAULT_FORM}
          isNew
          onSave={handleCreate}
          onCancel={() => setShowNew(false)}
        />
      )}

      {agents.length === 0 && !showNew && (
        <div className="text-sm text-gray-500 italic">
          No agents configured.
        </div>
      )}

      {agents.map((a) => (
        <div key={a.id}>
          {editingId === a.id ? (
            <AgentForm
              initial={agentToForm(a)}
              isNew={false}
              onSave={(form) => handleUpdate(a.id, form)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() =>
                      setExpandedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return next;
                      })
                    }
                    className="text-sm font-medium text-gray-200 truncate hover:text-blue-400 transition-colors cursor-pointer"
                    title="Click to expand details"
                  >
                    {a.name}
                  </button>
                  {a.lastRunStatus === "failed" && (
                    <span
                      className="inline-block h-2 w-2 rounded-full bg-red-500 shrink-0"
                      title="Last run failed"
                    />
                  )}
                  <button
                    role="switch"
                    aria-checked={a.enabled === 1 ? "true" : "false"}
                    aria-label={
                      a.enabled === 1 ? `Disable ${a.name}` : `Enable ${a.name}`
                    }
                    onClick={() => handleToggle(a)}
                    disabled={togglingId === a.id}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${a.enabled === 1 ? "bg-blue-600" : "bg-gray-600"} disabled:opacity-50`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${a.enabled === 1 ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleTrigger(a)}
                    disabled={triggeringId === a.id}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-green-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Run now"
                  >
                    {triggeringId === a.id ? "Running..." : "Run now"}
                  </button>
                  <button
                    onClick={() => setEditingId(a.id)}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
                  >
                    Edit
                  </button>
                  {deletingId === a.id ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Confirm?</span>
                      <button
                        onClick={() => handleDelete(a.id)}
                        className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(a.id)}
                      className="px-2 py-1 text-xs text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {a.description && (
                <p className="text-xs text-gray-400">{a.description}</p>
              )}

              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
                {a.schedule && (
                  <span className="font-mono bg-gray-800 px-1.5 py-0.5 rounded">
                    {a.schedule}
                  </span>
                )}
                {a.schedule && <span>Next: {formatNextRun(a.nextRunAt)}</span>}
                <span>Runs: {a.runCount}</span>
                {a.lastRunAt && (
                  <span
                    className={
                      a.lastRunStatus === "success"
                        ? "text-green-400"
                        : a.lastRunStatus === "failed"
                          ? "text-red-400"
                          : "text-gray-500"
                    }
                  >
                    Last: {formatLastRun(a.lastRunAt)}
                  </span>
                )}
                <span>
                  Model: {a.model ?? "opus"}
                  {!a.model && (
                    <span className="text-gray-600 ml-1">(default)</span>
                  )}
                </span>
                {a.repoPath && (
                  <span className="truncate max-w-[200px]" title={a.repoPath}>
                    {a.repoPath}
                  </span>
                )}
              </div>

              <p
                className={`text-xs text-gray-400 cursor-pointer hover:text-gray-300 transition-colors whitespace-pre-wrap ${promptExpandedIds.has(a.id) ? "" : "line-clamp-2"}`}
                onClick={() =>
                  setPromptExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(a.id)) next.delete(a.id);
                    else next.add(a.id);
                    return next;
                  })
                }
                title={
                  promptExpandedIds.has(a.id)
                    ? "Click to collapse"
                    : "Click to expand"
                }
              >
                {a.systemPrompt}
              </p>

              <button
                onClick={() =>
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(a.id)) next.delete(a.id);
                    else next.add(a.id);
                    return next;
                  })
                }
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {expandedIds.has(a.id) ? "Hide details" : "Memories & tasks"}
              </button>

              {expandedIds.has(a.id) && (
                <AgentDetail agentId={a.id} onToast={onToast} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
