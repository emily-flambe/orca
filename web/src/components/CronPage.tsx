import { useState, useEffect, useRef, useCallback } from "react";
import type { CronSchedule } from "../types";
import {
  fetchCronSchedules,
  createCronSchedule,
  updateCronSchedule,
  deleteCronSchedule,
  toggleCronSchedule,
  triggerCronSchedule,
  validateCronExpressionApi,
} from "../hooks/useApi";

// ---------------------------------------------------------------------------
// Relative date utility
// ---------------------------------------------------------------------------

function relativeDate(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const secs = Math.floor(abs / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let label: string;
  if (secs < 60) label = "just now";
  else if (mins < 60) label = `${mins}m`;
  else if (hours < 24) label = `${hours}h`;
  else label = `${days}d`;

  if (label === "just now") return label;
  return future ? `in ${label}` : `${label} ago`;
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
  timeoutMin: "30",
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
    enabled: s.enabled !== 0,
  };
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalProps {
  editing: CronSchedule | null;
  onClose: () => void;
  onSaved: () => void;
}

function CronModal({ editing, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState<FormState>(
    editing ? scheduleToForm(editing) : DEFAULT_FORM,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cronValidation, setCronValidation] = useState<{
    valid: boolean;
    error?: string;
    description?: string;
  } | null>(null);
  const [cronValidating, setCronValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // Debounced cron expression validation
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!form.schedule.trim()) {
      setCronValidation(null);
      setCronValidating(false);
      return;
    }
    setCronValidating(true);
    setCronValidation(null);
    debounceRef.current = setTimeout(() => {
      validateCronExpressionApi(form.schedule)
        .then((result) => {
          setCronValidation(result);
          setCronValidating(false);
        })
        .catch(() => {
          setCronValidation({ valid: false, error: "Validation failed" });
          setCronValidating(false);
        });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [form.schedule]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!form.schedule.trim()) {
      setError("Schedule is required");
      return;
    }
    if (cronValidating) {
      setError("Validating cron expression, please wait");
      return;
    }
    if (!cronValidation || !cronValidation.valid) {
      setError(cronValidation?.error ?? "Invalid cron expression");
      return;
    }
    if (!form.prompt.trim()) {
      setError("Prompt / Command is required");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        type: form.type,
        schedule: form.schedule.trim(),
        prompt: form.prompt.trim(),
        repoPath: form.repoPath.trim() || null,
        model: form.model.trim() || null,
        maxTurns: form.maxTurns ? parseInt(form.maxTurns, 10) : null,
        timeoutMin: form.timeoutMin ? parseInt(form.timeoutMin, 10) : 30,
        maxRuns: form.maxRuns ? parseInt(form.maxRuns, 10) : null,
        enabled: form.enabled ? 1 : 0,
      };

      if (editing) {
        await updateCronSchedule(editing.id, payload);
      } else {
        await createCronSchedule(payload as Parameters<typeof createCronSchedule>[0]);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-100">
            {editing ? "Edit Schedule" : "New Schedule"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="Daily summary"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">Type</label>
            <div className="flex gap-4">
              {(["claude", "shell"] as const).map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="type"
                    value={t}
                    checked={form.type === t}
                    onChange={() => setField("type", t)}
                    className="accent-blue-500"
                  />
                  {t === "claude" ? "Claude" : "Shell"}
                </label>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Cron Expression
            </label>
            <input
              type="text"
              value={form.schedule}
              onChange={(e) => setField("schedule", e.target.value)}
              placeholder="0 9 * * 1-5"
              className={`w-full bg-gray-800 border rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none ${
                cronValidation
                  ? cronValidation.valid
                    ? "border-green-600 focus:border-green-500"
                    : "border-red-600 focus:border-red-500"
                  : "border-gray-700 focus:border-gray-500"
              }`}
            />
            {cronValidation && (
              <p
                className={`mt-1 text-xs ${cronValidation.valid ? "text-green-400" : "text-red-400"}`}
              >
                {cronValidation.valid
                  ? cronValidation.description
                  : cronValidation.error}
              </p>
            )}
          </div>

          {/* Prompt / Command */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              {form.type === "claude" ? "Prompt" : "Command"}
            </label>
            <textarea
              value={form.prompt}
              onChange={(e) => setField("prompt", e.target.value)}
              rows={4}
              placeholder={
                form.type === "claude"
                  ? "Describe the task for the Claude agent..."
                  : "bash -c 'echo hello'"
              }
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-y"
            />
          </div>

          {/* Repo Path — claude only */}
          {form.type === "claude" && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Repo Path
              </label>
              <input
                type="text"
                value={form.repoPath}
                onChange={(e) => setField("repoPath", e.target.value)}
                placeholder="/path/to/repo (optional, defaults to cwd)"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
              />
            </div>
          )}

          {/* Model — claude only */}
          {form.type === "claude" && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Model</label>
              <select
                value={form.model}
                onChange={(e) => setField("model", e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-gray-500"
              >
                <option value="">Default</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </select>
            </div>
          )}

          {/* Max Turns — claude only */}
          {form.type === "claude" && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Max Turns (optional)
              </label>
              <input
                type="number"
                min="1"
                value={form.maxTurns}
                onChange={(e) => setField("maxTurns", e.target.value)}
                placeholder="Unlimited"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          )}

          {/* Timeout */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Timeout (minutes)
            </label>
            <input
              type="number"
              min="1"
              value={form.timeoutMin}
              onChange={(e) => setField("timeoutMin", e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>

          {/* Max Runs */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Max Runs (optional)
            </label>
            <input
              type="number"
              min="1"
              value={form.maxRuns}
              onChange={(e) => setField("maxRuns", e.target.value)}
              placeholder="Unlimited"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>

          {/* Enabled */}
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setField("enabled", e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
            </label>
            <span className="text-sm text-gray-300">Enabled</span>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving..." : editing ? "Save Changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm delete dialog
// ---------------------------------------------------------------------------

function ConfirmDeleteDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-100">Delete Schedule</h2>
        <p className="text-sm text-gray-400">
          Delete <span className="text-gray-200 font-medium">{name}</span>? This
          cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-500 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-5 right-5 z-50 bg-gray-800 border border-gray-700 text-gray-200 text-sm px-4 py-3 rounded-lg shadow-lg max-w-sm">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CronPage
// ---------------------------------------------------------------------------

export default function CronPage() {
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<CronSchedule | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<CronSchedule | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchCronSchedules()
      .then(setSchedules)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (s: CronSchedule) => {
    try {
      const updated = await toggleCronSchedule(s.id);
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Toggle failed");
    }
  };

  const handleTrigger = async (s: CronSchedule) => {
    try {
      const result = await triggerCronSchedule(s.id);
      setToast(`Triggered! Task ID: ${result.taskId}`);
      load();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Trigger failed");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteCronSchedule(deleteTarget.id);
      setSchedules((prev) => prev.filter((x) => x.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Delete failed");
      setDeleteTarget(null);
    }
  };

  const handleSaved = () => {
    setModalOpen(false);
    setEditingSchedule(null);
    load();
  };

  const openCreate = () => {
    setEditingSchedule(null);
    setModalOpen(true);
  };

  const openEdit = (s: CronSchedule) => {
    setEditingSchedule(s);
    setModalOpen(true);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Cron Schedules
        </h2>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors"
        >
          + New Schedule
        </button>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {loading ? (
          <div className="px-4 py-8 text-sm text-gray-500 text-center">
            Loading...
          </div>
        ) : schedules.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-500 text-center">
            No cron schedules yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">Schedule</th>
                  <th className="px-4 py-3 text-left font-medium">Enabled</th>
                  <th className="px-4 py-3 text-left font-medium">Runs</th>
                  <th className="px-4 py-3 text-left font-medium">Last Run</th>
                  <th className="px-4 py-3 text-left font-medium">Next Run</th>
                  <th className="px-4 py-3 text-left font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {schedules.map((s) => (
                  <tr
                    key={s.id}
                    className="hover:bg-gray-800/40 transition-colors"
                  >
                    <td className="px-4 py-3 text-gray-200 font-medium">
                      {s.name}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 text-xs rounded-full font-medium ${
                          s.type === "claude"
                            ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                            : "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                        }`}
                      >
                        {s.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      <div className="font-mono text-xs text-gray-400">
                        {s.schedule}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(s)}
                        className="relative inline-flex items-center cursor-pointer"
                        title={s.enabled ? "Disable" : "Enable"}
                      >
                        <span
                          className={`w-9 h-5 flex items-center rounded-full transition-colors ${s.enabled ? "bg-blue-600" : "bg-gray-700"}`}
                        >
                          <span
                            className={`inline-block w-4 h-4 mx-0.5 bg-white rounded-full shadow transition-transform ${s.enabled ? "translate-x-4" : "translate-x-0"}`}
                          />
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-3 text-gray-400 tabular-nums">
                      {s.runCount}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {relativeDate(s.lastRunAt)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {relativeDate(s.nextRunAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleTrigger(s)}
                          className="px-2 py-1 text-xs bg-amber-600/20 text-amber-400 border border-amber-600/30 rounded hover:bg-amber-600/30 transition-colors"
                        >
                          Trigger
                        </button>
                        <button
                          onClick={() => openEdit(s)}
                          className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded hover:border-gray-500 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(s)}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 border border-red-900/40 rounded hover:border-red-700/50 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modals */}
      {(modalOpen || editingSchedule) && (
        <CronModal
          editing={editingSchedule}
          onClose={() => {
            setModalOpen(false);
            setEditingSchedule(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteDialog
          name={deleteTarget.name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {toast && (
        <Toast message={toast} onDismiss={() => setToast(null)} />
      )}
    </div>
  );
}
