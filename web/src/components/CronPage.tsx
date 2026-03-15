import { useState, useEffect, useCallback } from "react";
import type { CronSchedule, TaskWithInvocations } from "../types";
import {
  fetchCronSchedules,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  fetchCronScheduleTasks,
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

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (secs < 3600) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "done":
      return "bg-green-900/40 text-green-400 border-green-700/40";
    case "failed":
      return "bg-red-900/40 text-red-400 border-red-700/40";
    case "running":
      return "bg-blue-900/40 text-blue-400 border-blue-700/40";
    case "canceled":
      return "bg-gray-800 text-gray-500 border-gray-700";
    case "dispatched":
    case "ready":
      return "bg-yellow-900/40 text-yellow-400 border-yellow-700/40";
    default:
      return "bg-gray-800 text-gray-400 border-gray-700";
  }
}

const PAGE_SIZE = 20;

function CronHistoryPanel({ schedule }: { schedule: CronSchedule }) {
  const isShellType = schedule.type === "shell";

  const [tasks, setTasks] = useState<TaskWithInvocations[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(!isShellType);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (isShellType) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExpandedTaskId(null);
    fetchCronScheduleTasks(schedule.id, PAGE_SIZE, offset)
      .then((data) => {
        if (cancelled) return;
        setTasks(data.tasks);
        setTotal(data.total);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schedule.id, offset, isShellType]);

  // Shell crons don't create Task records — show lastRunStatus/lastRunAt directly
  if (isShellType) {
    if (!schedule.lastRunAt && !schedule.lastRunStatus) {
      return (
        <div className="border-t border-gray-800 px-4 py-3 text-xs text-gray-500 italic">
          No runs yet.
        </div>
      );
    }
    return (
      <div className="border-t border-gray-800 px-4 py-3">
        <div className="bg-gray-800/50 rounded px-3 py-2 text-xs text-gray-400 flex items-center gap-3">
          <span className="text-gray-500">Last run:</span>
          {schedule.lastRunStatus && (
            <span
              className={`px-1.5 py-0.5 rounded-full border ${
                schedule.lastRunStatus === "success"
                  ? "bg-green-900/40 text-green-400 border-green-700/40"
                  : "bg-red-900/40 text-red-400 border-red-700/40"
              }`}
            >
              {schedule.lastRunStatus}
            </span>
          )}
          {schedule.lastRunAt && (
            <span className="text-gray-500">
              {formatLastRun(schedule.lastRunAt)}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border-t border-gray-800 px-4 py-3 text-xs text-gray-500">
        Loading history...
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-t border-gray-800 px-4 py-3 text-xs text-red-400">
        Error: {error}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="border-t border-gray-800 px-4 py-3 text-xs text-gray-500 italic">
        {total === 0 ? "No runs yet." : "No results on this page."}
      </div>
    );
  }

  const isClaudeType = schedule.type === "claude";

  return (
    <div className="border-t border-gray-800">
      {tasks.map((task) => {
        const latestInvocation =
          task.invocations.length > 0
            ? task.invocations
                .slice()
                .sort((a, b) =>
                  (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
                )[task.invocations.length - 1]
            : null;

        const duration = latestInvocation
          ? latestInvocation.endedAt
            ? formatDuration(
                latestInvocation.startedAt,
                latestInvocation.endedAt,
              )
            : task.orcaStatus === "running"
              ? formatDuration(latestInvocation.startedAt, null)
              : "—"
          : "—";

        const isExpanded = expandedTaskId === task.linearIssueId;
        const shortId = task.linearIssueId.slice(-12);

        return (
          <div
            key={task.linearIssueId}
            className="border-b border-gray-800 last:border-b-0"
          >
            <button
              onClick={() =>
                setExpandedTaskId(isExpanded ? null : task.linearIssueId)
              }
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/50 transition-colors"
            >
              <span className="text-xs text-gray-600 font-mono">
                {isExpanded ? "▼" : "▶"}
              </span>
              <span className="font-mono text-xs text-gray-400 shrink-0">
                {shortId}
              </span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full border shrink-0 ${statusBadgeClass(task.orcaStatus)}`}
              >
                {task.orcaStatus}
              </span>
              <span className="text-xs text-gray-500 shrink-0">
                {formatLastRun(task.createdAt)}
              </span>
              <span className="text-xs text-gray-600 shrink-0">{duration}</span>
            </button>

            {isExpanded && (
              <div className="px-4 pb-3">
                {isClaudeType && latestInvocation ? (
                  <LogViewer
                    invocationId={latestInvocation.id}
                    isRunning={latestInvocation.status === "running"}
                    outputSummary={latestInvocation.outputSummary}
                    compact
                  />
                ) : (
                  <div className="bg-gray-800/50 rounded px-3 py-2 text-xs text-gray-400">
                    <span className="text-gray-500">Status:</span>{" "}
                    <span
                      className={
                        statusBadgeClass(task.orcaStatus).includes("green")
                          ? "text-green-400"
                          : statusBadgeClass(task.orcaStatus).includes("red")
                            ? "text-red-400"
                            : "text-gray-300"
                      }
                    >
                      {task.orcaStatus}
                    </span>
                    {task.doneAt && (
                      <span className="ml-3 text-gray-500">
                        Completed: {formatLastRun(task.doneAt)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {(total > PAGE_SIZE || offset > 0) && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-800 text-xs text-gray-500">
          <span>
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
// Main page
// ---------------------------------------------------------------------------

export default function CronPage() {
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [expandedScheduleId, setExpandedScheduleId] = useState<number | null>(
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
  }

  async function handleUpdate(id: number, form: FormState) {
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
  }

  async function handleToggleEnabled(s: CronSchedule) {
    const updated = await updateCronSchedule(s.id, {
      enabled: s.enabled === 1 ? 0 : 1,
    });
    setSchedules((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
  }

  async function handleDelete(id: number) {
    await deleteCronSchedule(id);
    setSchedules((prev) => prev.filter((s) => s.id !== id));
    setDeletingId(null);
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
            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <div
                className="p-4 space-y-2 cursor-pointer hover:bg-gray-800/30 transition-colors"
                onClick={() =>
                  setExpandedScheduleId(
                    expandedScheduleId === s.id ? null : s.id,
                  )
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-gray-600 select-none">
                      {expandedScheduleId === s.id ? "▼" : "▶"}
                    </span>
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
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleEnabled(s);
                      }}
                      className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0 ${s.enabled === 1 ? "bg-blue-600" : "bg-gray-600"}`}
                      title={s.enabled === 1 ? "Disable" : "Enable"}
                    >
                      <span
                        className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${s.enabled === 1 ? "translate-x-3.5" : "translate-x-0.5"}`}
                      />
                    </button>
                  </div>
                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
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
              </div>
              {expandedScheduleId === s.id && <CronHistoryPanel schedule={s} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
