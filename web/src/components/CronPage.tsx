import { useState, useEffect, useCallback } from "react";
import type { CronSchedule, CronScheduleWithTasks } from "../types";
import {
  fetchCronSchedules,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  toggleCronSchedule,
  triggerCronSchedule,
  fetchCronSchedule,
} from "../hooks/useApi";

// -------------------------------------------------------------------------
// Cron expression utilities (client-side)
// -------------------------------------------------------------------------

// Validates a single cron field token (number, *, */n, n-m, or comma-separated list)
function validateCronField(
  token: string,
  min: number,
  max: number,
): boolean {
  if (token === "*") return true;
  // */n step
  const stepMatch = token.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const n = Number(stepMatch[1]);
    return n >= 1 && n <= max;
  }
  // Comma-separated list of values or ranges
  return token.split(",").every((part) => {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      return lo >= min && hi <= max && lo <= hi;
    }
    const n = Number(part);
    return /^\d+$/.test(part) && n >= min && n <= max;
  });
}

function validateCronExpr(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (expr.trim() === "" || parts.length !== 5) {
    return "Must have exactly 5 fields: minute hour day month weekday";
  }
  const [minute, hour, dom, month, dow] = parts;
  if (!validateCronField(minute, 0, 59)) return "Minute must be 0–59";
  if (!validateCronField(hour, 0, 23)) return "Hour must be 0–23";
  if (!validateCronField(dom, 1, 31)) return "Day-of-month must be 1–31";
  if (!validateCronField(month, 1, 12)) return "Month must be 1–12";
  if (!validateCronField(dow, 0, 7)) return "Weekday must be 0–7 (0=Sunday)";
  return null;
}

function describeCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "";
  const [minute, hour, dom, month, dow] = parts;

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  const everyNMin = minute.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyNMin[1]} minutes`;
  }
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every hour";
  }
  const everyNHours = hour.match(/^\*\/(\d+)$/);
  if (minute === "0" && everyNHours && dom === "*" && month === "*" && dow === "*") {
    return `Every ${everyNHours[1]} hours`;
  }
  const hourNum = parseInt(hour, 10);
  const isFixedHour = /^\d+$/.test(hour) && !isNaN(hourNum);
  if (minute === "0" && isFixedHour && month === "*") {
    const ampm = hourNum < 12 ? "AM" : "PM";
    const displayHour = hourNum % 12 === 0 ? 12 : hourNum % 12;
    const timeStr = `${displayHour}:00 ${ampm}`;
    if (dom === "*" && dow === "*") return `Daily at ${timeStr}`;
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const dowNum = parseInt(dow, 10);
    if (dom === "*" && /^\d+$/.test(dow) && !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6) {
      return `Weekly on ${dayNames[dowNum]} at ${timeStr}`;
    }
    if (dom === "1" && dow === "*") return `Monthly on the 1st at ${timeStr}`;
  }
  return `Cron: ${expr}`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 0) {
    const abs = -diff;
    if (abs < 60_000) return "in <1m";
    if (abs < 3_600_000) return `in ${Math.floor(abs / 60_000)}m`;
    if (abs < 86_400_000) return `in ${Math.floor(abs / 3_600_000)}h`;
    return `in ${Math.floor(abs / 86_400_000)}d`;
  }
  if (diff < 60_000) return "<1m ago";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// -------------------------------------------------------------------------
// Form types
// -------------------------------------------------------------------------

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
}

const EMPTY_FORM: FormState = {
  name: "",
  type: "claude",
  schedule: "",
  prompt: "",
  repoPath: "",
  model: "",
  maxTurns: "",
  timeoutMin: "30",
  maxRuns: "",
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
  };
}

// -------------------------------------------------------------------------
// Modal
// -------------------------------------------------------------------------

function CronFormModal({
  editSchedule,
  onClose,
  onSaved,
}: {
  editSchedule: CronSchedule | null;
  onClose: () => void;
  onSaved: (s: CronSchedule) => void;
}) {
  const [form, setForm] = useState<FormState>(
    editSchedule ? scheduleToForm(editSchedule) : EMPTY_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronError = form.schedule.trim() ? validateCronExpr(form.schedule) : null;
  const cronPreview = form.schedule.trim() && !cronError ? describeCronExpr(form.schedule) : null;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (cronError) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        schedule: form.schedule.trim(),
        prompt: form.prompt.trim(),
        repoPath: form.type === "claude" && form.repoPath.trim() ? form.repoPath.trim() : undefined,
        model: form.model.trim() || undefined,
        maxTurns: form.maxTurns.trim() ? parseInt(form.maxTurns, 10) : undefined,
        timeoutMin: form.timeoutMin.trim() ? parseInt(form.timeoutMin, 10) : 30,
        maxRuns: form.maxRuns.trim() ? parseInt(form.maxRuns, 10) : undefined,
      };
      const saved = editSchedule
        ? await updateCronSchedule(editSchedule.id, payload)
        : await createCronSchedule(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500 transition-colors";
  const labelCls = "block text-xs text-gray-400 mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">
            {editSchedule ? "Edit Cron Schedule" : "New Cron Schedule"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className={labelCls}>Name *</label>
            <input
              className={inputCls}
              placeholder="Daily report"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>

          {/* Type */}
          <div>
            <label className={labelCls}>Type *</label>
            <div className="flex gap-3">
              {(["claude", "shell"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set("type", t)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    form.type === t
                      ? t === "claude"
                        ? "bg-blue-600 text-white"
                        : "bg-green-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <label className={labelCls}>Schedule (cron expression) *</label>
            <input
              className={`${inputCls} font-mono ${cronError ? "border-red-500" : ""}`}
              placeholder="0 9 * * *"
              value={form.schedule}
              onChange={(e) => set("schedule", e.target.value)}
              required
            />
            {cronError && (
              <p className="mt-1 text-xs text-red-400">{cronError}</p>
            )}
            {cronPreview && (
              <p className="mt-1 text-xs text-green-400">{cronPreview}</p>
            )}
            {!form.schedule.trim() && (
              <p className="mt-1 text-xs text-gray-500">
                5 fields: minute hour day month weekday (e.g. <span className="font-mono">0 9 * * 1</span> = every Monday at 9am)
              </p>
            )}
          </div>

          {/* Prompt/Command */}
          <div>
            <label className={labelCls}>
              {form.type === "claude" ? "Prompt *" : "Command *"}
            </label>
            <textarea
              className={`${inputCls} h-24 resize-none font-mono text-xs`}
              placeholder={form.type === "claude" ? "Generate a daily summary report..." : "npm run build"}
              value={form.prompt}
              onChange={(e) => set("prompt", e.target.value)}
              required
            />
          </div>

          {/* Repo path — claude only */}
          {form.type === "claude" && (
            <div>
              <label className={labelCls}>Repo Path *</label>
              <input
                className={inputCls}
                placeholder="/path/to/repo"
                value={form.repoPath}
                onChange={(e) => set("repoPath", e.target.value)}
                required={form.type === "claude"}
              />
            </div>
          )}

          {/* Advanced options */}
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <p className="text-xs text-gray-500 uppercase tracking-wider font-medium">Advanced</p>
            {form.type === "claude" && (
              <div>
                <label className={labelCls}>Model (optional)</label>
                <input
                  className={inputCls}
                  placeholder="sonnet"
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                />
              </div>
            )}
            {form.type === "claude" && (
              <div>
                <label className={labelCls}>Max Turns (optional)</label>
                <input
                  className={inputCls}
                  type="number"
                  min="1"
                  placeholder="unlimited"
                  value={form.maxTurns}
                  onChange={(e) => set("maxTurns", e.target.value)}
                />
              </div>
            )}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className={labelCls}>Timeout (minutes)</label>
                <input
                  className={inputCls}
                  type="number"
                  min="1"
                  placeholder="30"
                  value={form.timeoutMin}
                  onChange={(e) => set("timeoutMin", e.target.value)}
                />
              </div>
              <div className="flex-1">
                <label className={labelCls}>Max Runs (optional)</label>
                <input
                  className={inputCls}
                  type="number"
                  min="1"
                  placeholder="unlimited"
                  value={form.maxRuns}
                  onChange={(e) => set("maxRuns", e.target.value)}
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !!cronError}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : editSchedule ? "Save Changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Recent tasks expandable
// -------------------------------------------------------------------------

function RecentTasksSection({
  scheduleId,
  refreshKey,
}: {
  scheduleId: number;
  refreshKey: number;
}) {
  const [detail, setDetail] = useState<CronScheduleWithTasks | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchCronSchedule(scheduleId);
      setDetail(d);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [scheduleId]);

  // Re-fetch when opened or when refreshKey changes (e.g. after Trigger Now)
  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, refreshKey, load]);

  const toggle = () => {
    setOpen((v) => !v);
  };

  return (
    <div className="mt-2">
      <button
        onClick={toggle}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Recent runs</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {loading && <p className="text-xs text-gray-600">Loading...</p>}
          {!loading && detail && detail.recentTasks.length === 0 && (
            <p className="text-xs text-gray-600 italic">No runs yet</p>
          )}
          {!loading && detail && detail.recentTasks.map((task) => (
            <div
              key={task.linearIssueId}
              className="flex items-center gap-2 text-xs text-gray-400 bg-gray-800/40 rounded px-2 py-1"
            >
              <span className="font-mono text-gray-500 shrink-0">{task.linearIssueId}</span>
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] ${
                  task.orcaStatus === "done"
                    ? "bg-green-500/20 text-green-400"
                    : task.orcaStatus === "failed"
                      ? "bg-red-500/20 text-red-400"
                      : task.orcaStatus === "running"
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-gray-500/20 text-gray-400"
                }`}
              >
                {task.orcaStatus}
              </span>
              <span className="text-gray-600 truncate">{task.agentPrompt?.slice(0, 60)}</span>
              <span className="ml-auto text-gray-600 shrink-0">{formatRelativeTime(task.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------
// Main CronPage
// -------------------------------------------------------------------------

export default function CronPage() {
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editSchedule, setEditSchedule] = useState<CronSchedule | null>(null);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [triggerSuccess, setTriggerSuccess] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  // Incremented per-schedule when Trigger Now succeeds, so RecentTasksSection refreshes
  const [triggerKeys, setTriggerKeys] = useState<Record<number, number>>({});

  const load = useCallback(async () => {
    try {
      const data = await fetchCronSchedules();
      setSchedules(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (id: number) => {
    setToggling(id);
    try {
      const updated = await toggleCronSchedule(id);
      setSchedules((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      console.error("Toggle failed:", err);
    } finally {
      setToggling(null);
    }
  };

  const handleTrigger = async (id: number) => {
    setTriggering(id);
    try {
      await triggerCronSchedule(id);
      setTriggerSuccess(id);
      setTriggerKeys((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
      setTimeout(() => setTriggerSuccess(null), 2000);
    } catch (err) {
      console.error("Trigger failed:", err);
    } finally {
      setTriggering(null);
    }
  };

  const handleDelete = async (s: CronSchedule) => {
    if (!window.confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    try {
      await deleteCronSchedule(s.id);
      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleSaved = (saved: CronSchedule) => {
    setSchedules((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id);
      if (idx === -1) return [...prev, saved];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    setShowModal(false);
    setEditSchedule(null);
  };

  const openEdit = (s: CronSchedule) => {
    setEditSchedule(s);
    setShowModal(true);
  };

  const openCreate = () => {
    setEditSchedule(null);
    setShowModal(true);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Cron Schedules
          </h2>
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
          >
            <span>+</span>
            <span>New Schedule</span>
          </button>
        </div>

        {loading && (
          <div className="text-sm text-gray-500 text-center py-8">
            Loading schedules...
          </div>
        )}
        {error && (
          <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-4 py-3">
            {error}
          </div>
        )}
        {!loading && schedules.length === 0 && !error && (
          <div className="text-sm text-gray-500 text-center py-12">
            No cron schedules yet.{" "}
            <button
              onClick={openCreate}
              className="text-blue-400 hover:text-blue-300 underline transition-colors"
            >
              Create one
            </button>
          </div>
        )}

        {/* Schedule cards */}
        {schedules.map((s) => {
          const isEnabled = s.enabled === 1;
          const isTriggering = triggering === s.id;
          const isTriggered = triggerSuccess === s.id;
          const isToggling = toggling === s.id;

          return (
            <div
              key={s.id}
              className={`bg-gray-900 border rounded-lg p-4 transition-colors ${
                isEnabled ? "border-gray-800" : "border-gray-800/50 opacity-60"
              }`}
            >
              {/* Top row */}
              <div className="flex items-start gap-3">
                {/* Enable toggle */}
                <button
                  onClick={() => handleToggle(s.id)}
                  disabled={isToggling}
                  className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                    isEnabled ? "bg-blue-600" : "bg-gray-700"
                  } disabled:opacity-50`}
                  title={isEnabled ? "Disable" : "Enable"}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      isEnabled ? "translate-x-4" : ""
                    }`}
                  />
                </button>

                {/* Name + type */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-200">{s.name}</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        s.type === "claude"
                          ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                          : "bg-green-500/20 text-green-400 border border-green-500/30"
                      }`}
                    >
                      {s.type}
                    </span>
                  </div>

                  {/* Schedule expression + description */}
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    <code className="text-xs font-mono text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
                      {s.schedule}
                    </code>
                    <span className="text-xs text-gray-500">
                      {describeCronExpr(s.schedule)}
                    </span>
                  </div>

                  {/* Stats row */}
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                    <span>
                      <span className="text-gray-400">{s.runCount}</span> runs
                    </span>
                    {s.lastRunAt && (
                      <span>
                        Last: <span className="text-gray-400">{formatRelativeTime(s.lastRunAt)}</span>
                      </span>
                    )}
                    {s.nextRunAt && isEnabled && (
                      <span>
                        Next: <span className="text-gray-400">{formatRelativeTime(s.nextRunAt)}</span>
                      </span>
                    )}
                    {s.maxRuns != null && (
                      <span>
                        Max: <span className="text-gray-400">{s.maxRuns}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleTrigger(s.id)}
                    disabled={isTriggering || isTriggered}
                    className={`px-2.5 py-1 text-xs rounded transition-colors ${
                      isTriggered
                        ? "bg-green-600/20 text-green-400 border border-green-600/30"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 border border-gray-700"
                    } disabled:opacity-50`}
                    title="Trigger now"
                  >
                    {isTriggered ? "✓ Triggered" : isTriggering ? "..." : "▶ Run"}
                  </button>
                  <button
                    onClick={() => openEdit(s)}
                    className="px-2.5 py-1 text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 border border-gray-700 rounded transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(s)}
                    className="px-2.5 py-1 text-xs bg-gray-800 text-red-500 hover:bg-red-900/20 border border-gray-700 hover:border-red-800 rounded transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Recent runs */}
              <RecentTasksSection scheduleId={s.id} refreshKey={triggerKeys[s.id] ?? 0} />
            </div>
          );
        })}
      </div>

      {/* Modal */}
      {showModal && (
        <CronFormModal
          editSchedule={editSchedule}
          onClose={() => {
            setShowModal(false);
            setEditSchedule(null);
          }}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
