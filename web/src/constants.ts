export const MANUAL_STATUSES = [
  { value: "backlog", label: "backlog", bg: "bg-gray-500/20 text-gray-500" },
  { value: "ready", label: "queued", bg: "bg-cyan-500/20 text-cyan-400" },
  { value: "done", label: "done", bg: "bg-green-500/20 text-green-400" },
  { value: "canceled", label: "cancel", bg: "bg-gray-500/20 text-gray-400" },
  { value: "failed", label: "failed", bg: "bg-red-500/20 text-red-400" },
] as const;

export const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;
