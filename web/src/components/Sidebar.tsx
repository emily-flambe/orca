import { useState, useMemo } from "react";
import type { OrcaStatus, Task } from "../types";
import CreateTicketModal from "./CreateTicketModal";

export type Page = "dashboard" | "tasks" | "logs" | "settings";

const PROJECT_COLORS = [
  "#3b82f6", "#a855f7", "#22c55e", "#eab308",
  "#ef4444", "#ec4899", "#6366f1", "#14b8a6", "#f97316", "#06b6d4",
];

function getProjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

interface Props {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  tasks: Task[];
  onSync: () => Promise<void>;
  onNewTicket: (identifier: string) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({
  activePage,
  onNavigate,
  status,
  tasks,
  onSync,
  onNewTicket,
  mobileOpen,
  onMobileClose,
}: Props) {
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const projects = useMemo(() => {
    const ps = new Set<string>();
    for (const t of tasks) if (t.projectName) ps.add(t.projectName);
    return [...ps].sort();
  }, [tasks]);

  const activeCount = status?.activeSessions ?? 0;

  const pct =
    status && status.budgetLimit > 0
      ? Math.min((status.costInWindow / status.budgetLimit) * 100, 100)
      : 0;
  const barColor =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  function NavItem({
    label,
    page,
    badge,
  }: {
    label: string;
    page: Page;
    badge?: number;
  }) {
    const active = activePage === page;
    return (
      <button
        onClick={() => {
          onNavigate(page);
          onMobileClose();
        }}
        className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
          active
            ? "bg-gray-700 text-gray-100"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        }`}
      >
        <span className="flex-1">{label}</span>
        {badge !== undefined && badge > 0 && (
          <span className="text-[10px] bg-blue-500 text-white rounded-full px-1.5 py-0.5 leading-none tabular-nums">
            {badge}
          </span>
        )}
      </button>
    );
  }

  const sidebarContent = (
    <div className="flex flex-col h-full w-[200px] shrink-0 bg-gray-900 border-r border-gray-800">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-gray-100 tracking-tight">Orca</span>
          <span className="text-[10px] text-gray-600 uppercase tracking-wider">orchestrator</span>
        </div>
      </div>

      {/* Quick actions */}
      <div className="p-2 space-y-0.5 shrink-0">
        <NavItem label="Dashboard" page="dashboard" badge={activeCount} />
        <button
          onClick={() => setShowModal(true)}
          className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        >
          + New ticket
        </button>
      </div>

      {/* Work section */}
      <div className="px-3 pt-2 pb-1 shrink-0">
        <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
          Work
        </span>
      </div>
      <div className="px-2 space-y-0.5 shrink-0">
        <NavItem label="Tasks" page="tasks" />
        <NavItem label="Logs" page="logs" />
      </div>

      {/* Projects section */}
      {projects.length > 0 && (
        <div className="shrink-0">
          <div className="px-3 pt-3 pb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
              Projects
            </span>
            <button
              onClick={() => setProjectsCollapsed((c) => !c)}
              className="text-gray-600 hover:text-gray-400 transition-colors"
              aria-label={projectsCollapsed ? "Expand projects" : "Collapse projects"}
            >
              <svg
                className={`w-3 h-3 transition-transform ${projectsCollapsed ? "" : "rotate-90"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          {!projectsCollapsed && (
            <div className="px-2 space-y-0.5 overflow-y-auto max-h-36">
              {projects.map((p) => (
                <div
                  key={p}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 rounded-md hover:bg-gray-800 cursor-default"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: getProjectColor(p) }}
                  />
                  <span className="truncate">{p}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Budget indicator */}
      {status && (
        <div className="px-4 py-2 border-t border-gray-800 shrink-0">
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
            <span>Budget</span>
            <span className="tabular-nums text-gray-400">
              ${status.costInWindow.toFixed(2)}
              <span className="text-gray-600"> / </span>${status.budgetLimit.toFixed(2)}
            </span>
          </div>
          <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${barColor} rounded-full transition-all`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Sync */}
      <div className="px-2 pb-1 shrink-0">
        <button
          onClick={handleSync}
          disabled={syncing}
          className="w-full px-3 py-1.5 rounded text-xs bg-purple-700/80 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {syncing ? "Syncing..." : "Sync Linear"}
        </button>
      </div>

      {/* Bottom: Settings + theme */}
      <div className="p-2 border-t border-gray-800 space-y-0.5 shrink-0">
        <NavItem label="Settings" page="settings" />
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar — always visible */}
      <div className="hidden md:flex h-full">{sidebarContent}</div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {sidebarContent}
          {/* Backdrop */}
          <div className="flex-1 bg-black/60" onClick={onMobileClose} />
        </div>
      )}

      {/* Create ticket modal */}
      {showModal && (
        <CreateTicketModal
          onClose={() => setShowModal(false)}
          onCreated={(identifier) => {
            setShowModal(false);
            onNewTicket(identifier);
          }}
        />
      )}
    </>
  );
}
