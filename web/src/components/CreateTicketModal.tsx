import { useState, useEffect, useCallback } from "react";
import { fetchProjects, createTicket } from "../hooks/useApi";
import type { ProjectInfo } from "../hooks/useApi";

const PRIORITY_OPTIONS = [
  { label: "P0 (urgent)", value: 1 },
  { label: "P1 (high)", value: 2 },
  { label: "P2 (medium)", value: 3 },
  { label: "P3 (low)", value: 4 },
  { label: "P4 (none)", value: 0 },
] as const;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (identifier: string) => void;
}

export default function CreateTicketModal({ isOpen, onClose, onSuccess }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState(3);
  const [status, setStatus] = useState<"ready" | "backlog">("ready");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [titleError, setTitleError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    fetchProjects()
      .then(setProjects)
      .catch(() => {});
  }, [isOpen]);

  const resetForm = useCallback(() => {
    setTitle("");
    setDescription("");
    setProjectId("");
    setPriority(3);
    setStatus("ready");
    setError("");
    setTitleError("");
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError("Title is required");
      return;
    }
    setTitleError("");
    setError("");
    setSubmitting(true);
    try {
      const result = await createTicket({
        title: title.trim(),
        description: description || undefined,
        projectId: projectId || undefined,
        priority,
        status,
      });
      handleClose();
      onSuccess(result.identifier);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ticket");
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">New ticket</h2>
          <button
            onClick={handleClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (titleError) setTitleError(""); }}
              placeholder="Ticket title"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
            {titleError && <p className="text-xs text-red-400 mt-1">{titleError}</p>}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the task..."
              rows={4}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-none"
            />
          </div>

          {/* Project + Priority row */}
          <div className="flex gap-3">
            {/* Project */}
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">Project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div className="w-36">
              <label className="block text-xs text-gray-400 mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
              >
                {PRIORITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Status */}
          <div className="w-48">
            <label className="block text-xs text-gray-400 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as "ready" | "backlog")}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
            >
              <option value="ready">Todo (queued)</option>
              <option value="backlog">Backlog</option>
            </select>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
            >
              {submitting ? "Creating..." : "Create ticket"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
