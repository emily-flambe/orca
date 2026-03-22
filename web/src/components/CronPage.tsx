import { useState, useEffect, useCallback } from "react";
import type {
  CronSchedule,
  CronRun,
  TaskWithInvocations,
  Invocation,
} from "../types";
import {
  fetchCronSchedules,
  fetchCronRuns,
  fetchCronTasks,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  triggerCronSchedule,
} from "../hooks/useApi";
import LogViewer from "./LogViewer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return "—";
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

function formatLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return "—";
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

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  name: string;
  type: "claude" | "shell";
  schedule: string;
  prompt: string;
  repoPath: string;
  model: string;
  maxTurns: string;
  timeoutMin: string;
  maxRuns: string;
  enabled: boolean;
}

const DEFAULT_FORM: FormState = {
  name: "",
  type: "claude",
  schedule: "",
  prompt: "",
  repoPath: "",
  model: "",
  maxTurns: "",
  timeoutMin: "60",
  maxRuns: "",
  enabled: true,
};

function scheduleToForm(s: CronSchedule): FormState {
  return {
    name: s.name,
    type: s.type,
    schedule: s.schedule,
    prompt: s.prompt,
    repoPath: s.repoPath ?? "",
    model: s.model ?? "",
    maxTurns: s.maxTurns != null ? String(s.maxTurns) : "",
    timeoutMin: String(s.timeoutMin),
    maxRuns: s.maxRuns != null ? String(s.maxRuns) : "",
    enabled: s.enabled === 1,
  };
}

// ---------------------------------------------------------------------------
// Inline form
// ---------------------------------------------------------------------------

function CronForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: FormState;
  onSave: (data: FormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.schedule.trim() || !form.prompt.trim()) {
      setError("Name, schedule, and prompt are required.");
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
            placeholder="e.g. Nightly sync"
          />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            className={inputClass}
            value={form.type}
            onChange={(e) => set("type", e.target.value as "claude" | "shell")}
          >
            <option value="claude">claude</option>
            <option value="shell">shell</option>
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Cron schedule * (e.g. 0 2 * * *)</label>
        <input
          className={inputClass}
          value={form.schedule}
          onChange={(e) => set("schedule", e.target.value)}
          placeholder="0 2 * * *"
        />
      </div>

      <div>
        <label className={labelClass}>
          {form.type === "shell" ? "Shell command *" : "Prompt *"}
        </label>
        <textarea
          className={`${inputClass} min-h-[80px] resize-y`}
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder={
            form.type === "shell" ? "e.g. npm run sync" : "Describe the task..."
          }
        />
      </div>

      <div>
        <label className={labelClass}>Repo path (optional)</label>
        <input
          className={inputClass}
          value={form.repoPath}
          onChange={(e) => set("repoPath", e.target.value)}
          placeholder="/path/to/repo"
        />
      </div>

      {form.type === "claude" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Model (optional)</label>
            <input
              className={inputClass}
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="sonnet"
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
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Timeout (minutes)</label>
          <input
            type="number"
            className={`${inputClass} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            value={form.timeoutMin}
            onChange={(e) => set("timeoutMin", e.target.value)}
            placeholder="60"
          />
        </div>
        <div>
          <label className={labelClass}>Max runs (optional)</label>
          <input
            type="number"
            className={`${inputClass} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            value={form.maxRuns}
            onChange={(e) => set("maxRuns", e.target.value)}
            placeholder="unlimited"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled ? "true" : "false"}
          aria-label="Enable schedule"
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
// Run History
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    success: "bg-green-900/40 text-green-400 border-green-700/40",
    failed: "bg-red-900/40 text-red-400 border-red-700/40",
    running: "bg-blue-900/40 text-blue-400 border-blue-700/40",
  };
  const cls = colors[status] ?? "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}

// Shell run history (cron_shell)
function ShellRunHistory({ scheduleId }: { scheduleId: number }) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);

  useEffect(() => {
    fetchCronRuns(scheduleId)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [scheduleId]);

  if (loading) {
    return <div className="text-xs text-gray-500 py-2">Loading runs...</div>;
  }

  if (runs.length === 0) {
    return (
      <div className="text-xs text-gray-500 italic py-2">
        No run history yet.
      </div>
    );
  }

  const displayRuns = showAll ? runs : runs.slice(0, 20);

  return (
    <div className="space-y-1">
      {displayRuns.map((run) => (
        <div
          key={run.id}
          className="bg-gray-800/50 rounded px-2 py-1.5 space-y-1"
        >
          <div className="flex items-center gap-2 text-xs">
            {statusBadge(run.status)}
            <span className="text-gray-400">
              {formatTimestamp(run.startedAt)}
            </span>
            <span className="text-gray-500">
              {formatDuration(run.durationMs)}
            </span>
            {run.output && (
              <button
                onClick={() =>
                  setExpandedRunId(expandedRunId === run.id ? null : run.id)
                }
                className="text-gray-500 hover:text-gray-300 transition-colors ml-auto"
              >
                {expandedRunId === run.id ? "hide" : "output"}
              </button>
            )}
          </div>
          {expandedRunId === run.id && run.output && (
            <pre className="text-xs text-gray-400 bg-gray-900 rounded px-2 py-1 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
              {run.output}
            </pre>
          )}
        </div>
      ))}
      {!showAll && runs.length > 20 && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Show {runs.length - 20} more...
        </button>
      )}
    </div>
  );
}

// Invocation row for a claude task
function InvocationRow({ inv }: { inv: Invocation }) {
  const [expanded, setExpanded] = useState(false);

  const durationMs =
    inv.startedAt && inv.endedAt
      ? new Date(inv.endedAt).getTime() - new Date(inv.startedAt).getTime()
      : null;

  return (
    <div className="bg-gray-900 rounded px-2 py-1.5 space-y-1 border border-gray-800">
      <div className="flex items-center gap-2 text-xs">
        {statusBadge(inv.status)}
        <span className="text-gray-500 font-mono">{inv.phase ?? "—"}</span>
        <span className="text-gray-400">{formatTimestamp(inv.startedAt)}</span>
        <span className="text-gray-500">{formatDuration(durationMs)}</span>
        {inv.costUsd != null && (
          <span className="text-gray-500">${inv.costUsd.toFixed(4)}</span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-gray-500 hover:text-gray-300 transition-colors ml-auto"
        >
          {expanded ? "hide logs" : "view logs"}
        </button>
      </div>
      {expanded && (
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

// Claude task row with expandable invocations
function ClaudeTaskRow({ task }: { task: TaskWithInvocations }) {
  const [expanded, setExpanded] = useState(false);

  const taskStatusColors: Record<string, string> = {
    done: "bg-green-900/40 text-green-400 border-green-700/40",
    failed: "bg-red-900/40 text-red-400 border-red-700/40",
    running: "bg-blue-900/40 text-blue-400 border-blue-700/40",
    ready: "bg-yellow-900/40 text-yellow-400 border-yellow-700/40",
    canceled: "bg-gray-800 text-gray-500 border-gray-700",
  };
  const statusCls =
    taskStatusColors[task.orcaStatus] ??
    "bg-gray-800 text-gray-400 border-gray-700";

  const durationMs =
    task.createdAt && task.doneAt
      ? new Date(task.doneAt).getTime() - new Date(task.createdAt).getTime()
      : null;

  return (
    <div className="bg-gray-800/50 rounded px-2 py-1.5 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`text-xs px-1.5 py-0.5 rounded-full border ${statusCls}`}
        >
          {task.orcaStatus}
        </span>
        <span
          className="text-gray-500 font-mono truncate max-w-[160px]"
          title={task.linearIssueId}
        >
          {task.linearIssueId}
        </span>
        <span className="text-gray-400">{formatTimestamp(task.createdAt)}</span>
        <span className="text-gray-500">{formatDuration(durationMs)}</span>
        {task.invocations.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-500 hover:text-gray-300 transition-colors ml-auto"
          >
            {expanded
              ? "hide"
              : `${task.invocations.length} invocation${task.invocations.length !== 1 ? "s" : ""}`}
          </button>
        )}
      </div>
      {expanded && task.invocations.length > 0 && (
        <div className="space-y-1 pl-2 border-l border-gray-700">
          {task.invocations.map((inv) => (
            <InvocationRow key={inv.id} inv={inv} />
          ))}
        </div>
      )}
    </div>
  );
}

// Claude invocation history (cron_claude)
function ClaudeRunHistory({ scheduleId }: { scheduleId: number }) {
  const [tasks, setTasks] = useState<TaskWithInvocations[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetchCronTasks(scheduleId)
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [scheduleId]);

  if (loading) {
    return <div className="text-xs text-gray-500 py-2">Loading history...</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className="text-xs text-gray-500 italic py-2">
        No run history yet.
      </div>
    );
  }

  const displayTasks = showAll ? tasks : tasks.slice(0, 20);

  return (
    <div className="space-y-1">
      {displayTasks.map((task) => (
        <ClaudeTaskRow key={task.linearIssueId} task={task} />
      ))}
      {!showAll && tasks.length > 20 && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Show {tasks.length - 20} more...
        </button>
      )}
    </div>
  );
}

function RunHistory({
  scheduleId,
  scheduleType,
}: {
  scheduleId: number;
  scheduleType: "claude" | "shell";
}) {
  if (scheduleType === "claude") {
    return <ClaudeRunHistory scheduleId={scheduleId} />;
  }
  return <ShellRunHistory scheduleId={scheduleId} />;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface ToastCallbacks {
  success: (msg: string) => void;
  error: (msg: string) => void;
}

export default function CronPage({ onToast }: { onToast?: ToastCallbacks }) {
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [runningNowId, setRunningNowId] = useState<number | null>(null);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(
    null,
  );

  const load = useCallback(() => {
    fetchCronSchedules()
      .then(setSchedules)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(form: FormState) {
    const schedule = await createCronSchedule({
      name: form.name,
      type: form.type,
      schedule: form.schedule,
      prompt: form.prompt,
      repoPath: form.repoPath || undefined,
      model: form.model || undefined,
      maxTurns: form.maxTurns ? parseInt(form.maxTurns, 10) : undefined,
      timeoutMin: form.timeoutMin ? parseInt(form.timeoutMin, 10) : undefined,
      maxRuns: form.maxRuns ? parseInt(form.maxRuns, 10) : undefined,
      enabled: form.enabled ? 1 : 0,
    });
    setSchedules((prev) => [...prev, schedule]);
    setShowNew(false);
    onToast?.success("Schedule created");
  }

  async function handleUpdate(id: number, form: FormState) {
    try {
      const schedule = await updateCronSchedule(id, {
        name: form.name,
        type: form.type,
        schedule: form.schedule,
        prompt: form.prompt,
        repoPath: form.repoPath || null,
        model: form.model || null,
        maxTurns: form.maxTurns ? parseInt(form.maxTurns, 10) : null,
        timeoutMin: form.timeoutMin ? parseInt(form.timeoutMin, 10) : 60,
        maxRuns: form.maxRuns ? parseInt(form.maxRuns, 10) : null,
        enabled: form.enabled ? 1 : 0,
      });
      setSchedules((prev) => prev.map((s) => (s.id === id ? schedule : s)));
      setEditingId(null);
      onToast?.success("Schedule updated");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to update schedule",
      );
    }
  }

  async function handleToggleEnabled(s: CronSchedule) {
    if (togglingId === s.id) return;
    setTogglingId(s.id);
    try {
      const updated = await updateCronSchedule(s.id, {
        enabled: s.enabled === 1 ? 0 : 1,
      });
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
      onToast?.success(
        updated.enabled === 1 ? "Schedule enabled" : "Schedule disabled",
      );
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to update schedule",
      );
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteCronSchedule(id);
      setSchedules((prev) => prev.filter((s) => s.id !== id));
      setDeletingId(null);
      onToast?.success("Schedule deleted");
    } catch (err) {
      onToast?.error(
        err instanceof Error ? err.message : "Failed to delete schedule",
      );
    }
  }

  async function handleRunNow(id: number) {
    if (runningNowId === id) return;
    setRunningNowId(id);
    try {
      await triggerCronSchedule(id);
      onToast?.success("Job triggered");
      load();
    } catch (err) {
      onToast?.error(err instanceof Error ? err.message : "Failed to trigger job");
    } finally {
      setRunningNowId(null);
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
          Cron Schedules
        </h2>
        {!showNew && (
          <button
            onClick={() => setShowNew(true)}
            className="px-3 py-1.5 rounded text-xs bg-blue-600 text-blue-100 hover:bg-blue-700 transition-colors"
          >
            New schedule
          </button>
        )}
      </div>

      {showNew && (
        <CronForm
          initial={DEFAULT_FORM}
          onSave={handleCreate}
          onCancel={() => setShowNew(false)}
        />
      )}

      {schedules.length === 0 && !showNew && (
        <div className="text-sm text-gray-500 italic">
          No cron schedules configured.
        </div>
      )}

      {schedules.map((s) => (
        <div key={s.id}>
          {editingId === s.id ? (
            <CronForm
              initial={scheduleToForm(s)}
              onSave={(form) => handleUpdate(s.id, form)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-gray-200 truncate">
                    {s.name}
                  </span>
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded-full border ${s.type === "claude" ? "bg-purple-900/40 text-purple-400 border-purple-700/40" : "bg-gray-800 text-gray-400 border-gray-700"}`}
                  >
                    {s.type}
                  </span>
                  {s.lastRunStatus === "failed" && (
                    <span
                      className="inline-block h-2 w-2 rounded-full bg-red-500 shrink-0"
                      title="Last run failed"
                    />
                  )}
                  <button
                    role="switch"
                    aria-checked={s.enabled === 1 ? "true" : "false"}
                    aria-label={
                      s.enabled === 1 ? `Disable ${s.name}` : `Enable ${s.name}`
                    }
                    onClick={() => handleToggleEnabled(s)}
                    disabled={togglingId === s.id}
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${s.enabled === 1 ? "bg-blue-600" : "bg-gray-600"} disabled:opacity-50`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${s.enabled === 1 ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleRunNow(s.id)}
                    disabled={runningNowId === s.id}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-green-400 hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {runningNowId === s.id ? "Running..." : "Run now"}
                  </button>
                  <button
                    onClick={() => setEditingId(s.id)}
                    className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
                  >
                    Edit
                  </button>
                  {deletingId === s.id ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Confirm?</span>
                      <button
                        onClick={() => handleDelete(s.id)}
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
                      onClick={() => setDeletingId(s.id)}
                      className="px-2 py-1 text-xs text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
                <span className="font-mono bg-gray-800 px-1.5 py-0.5 rounded">
                  {s.schedule}
                </span>
                <span>Next: {formatNextRun(s.nextRunAt)}</span>
                <span>Runs: {s.runCount}</span>
                {s.lastRunAt && (
                  <span
                    className={
                      s.lastRunStatus === "success"
                        ? "text-green-400"
                        : s.lastRunStatus === "failed"
                          ? "text-red-400"
                          : "text-gray-500"
                    }
                  >
                    Last: {formatLastRun(s.lastRunAt)}
                  </span>
                )}
                {s.maxRuns != null && <span>Max: {s.maxRuns}</span>}
                {s.repoPath && (
                  <span className="truncate max-w-[200px]" title={s.repoPath}>
                    {s.repoPath}
                  </span>
                )}
              </div>

              <p className="text-xs text-gray-400 line-clamp-2">{s.prompt}</p>

              <button
                onClick={() =>
                  setExpandedHistoryId(expandedHistoryId === s.id ? null : s.id)
                }
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {expandedHistoryId === s.id
                  ? "Hide run history"
                  : "Run history"}
              </button>

              {expandedHistoryId === s.id && (
                <RunHistory scheduleId={s.id} scheduleType={s.type} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
