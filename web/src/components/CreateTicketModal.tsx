import { useState, useEffect, useRef } from "react";
import { fetchProjects, createTask, type ProjectOption } from "../hooks/useApi";

interface Props {
  onClose: () => void;
  onCreated: (identifier: string) => void;
}

const PRIORITY_OPTIONS = [
  { label: "P4 – No priority", value: 0 },
  { label: "P0 – Urgent", value: 1 },
  { label: "P1 – High", value: 2 },
  { label: "P2 – Normal", value: 3 },
  { label: "P3 – Low", value: 4 },
] as const;

export default function CreateTicketModal({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<number>(0);
  const [status, setStatus] = useState<"todo" | "backlog">("todo");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    fetchProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setProjectId(ps[0]!.id);
      })
      .catch(() => {});
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        projectId: projectId || undefined,
        priority,
        status,
      });
      onCreated(result.identifier);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create ticket");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-gray-100">New ticket</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Title <span className="text-red-400">*</span></label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Markdown supported..."
              rows={4}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-none"
            />
          </div>

          {/* Project + Priority + Status row */}
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Project */}
            <div className="flex-1">
              <label className="block text-xs text-gray-400 mb-1">Project</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Priority + Status: side-by-side even on mobile */}
            <div className="flex gap-3">
              <div className="flex-1 sm:w-36 sm:flex-none">
                <label className="block text-xs text-gray-400 mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex-1 sm:w-28 sm:flex-none">
                <label className="block text-xs text-gray-400 mb-1">Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "todo" | "backlog")}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-2 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
                >
                  <option value="todo">Todo</option>
                  <option value="backlog">Backlog</option>
                </select>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="px-4 py-1.5 rounded bg-purple-600 text-purple-100 text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Creating..." : "Create ticket"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
