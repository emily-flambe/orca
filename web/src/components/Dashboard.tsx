import type { Task } from "../types";
import ActiveSessionsGrid from "./ActiveSessionsGrid";

interface Props {
  tasks: Task[];
}

export default function Dashboard({ tasks }: Props) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.orcaStatus === "done").length;
  const running = tasks.filter(
    (t) => t.orcaStatus === "running" || t.orcaStatus === "dispatched"
  ).length;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-xl font-semibold text-gray-100">Dashboard</h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Total Tasks</div>
          <div className="text-2xl font-mono font-semibold text-gray-100">{total}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Done</div>
          <div className="text-2xl font-mono font-semibold text-green-400">{done}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Running</div>
          <div className="text-2xl font-mono font-semibold text-blue-400">{running}</div>
        </div>
      </div>

      <ActiveSessionsGrid />
    </div>
  );
}
