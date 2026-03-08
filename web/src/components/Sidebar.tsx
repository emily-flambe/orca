import { useState, useMemo } from "react";
import type { OrcaStatus, Task } from "../types";
import CreateTicketModal from "./CreateTicketModal";

export type Page = "tasks" | "metrics" | "logs" | "settings";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  tasks: Task[];
  onSync: () => Promise<void>;
  onConfigUpdate: (config: { concurrencyCap?: number; implementModel?: string; reviewModel?: string; fixModel?: string }) => Promise<void>;
  onNewTicket: (identifier: string) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

/** Derive a deterministic color class from a project name. */
function projectColor(name: string): string {
  const colors = [
    "bg-blue-400",
    "bg-purple-400",
    "bg-green-400",
    "bg-yellow-400",
    "bg-pink-400",
    "bg-cyan-400",
    "bg-orange-400",
    "bg-teal-400",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return colors[hash % colors.length]!;
}

function NavItem({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 rounded text-sm transition-colors ${
        active
          ? "bg-gray-800 text-gray-100"
          : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
      }`}
    >
      <span>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-medium tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

function SidebarContent({
  activePage,
  onNavigate,
  status,
  tasks,
  onSync,
  onNewTicket,
  onClose,
}: {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  tasks: Task[];
  onSync: () => Promise<void>;
  onNewTicket: (identifier: string) => void;
  onClose?: () => void;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const projects = useMemo(() => {
    const ps = new Set<string>();
    for (const t of tasks) if (t.projectName) ps.add(t.projectName);
    return [...ps].sort();
  }, [tasks]);

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

  const navigate = (page: Page) => {
    onNavigate(page);
    onClose?.();
  };

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Logo */}
        <div className="h-12 flex items-center px-4 shrink-0 border-b border-gray-800">
          <span className="font-bold text-gray-100 text-base tracking-tight">Orca</span>
        </div>

        {/* Nav content */}
        <div className="flex-1 overflow-y-auto py-3 flex flex-col gap-1 px-2">
          {/* Quick actions */}
          <div className="space-y-0.5">
            <NavItem
              label="Dashboard"
              active={activePage === "metrics"}
              onClick={() => navigate("metrics")}
              badge={status?.activeSessions ?? 0}
            />
            <button
              onClick={() => setShowModal(true)}
              className="w-full flex items-center px-3 py-1.5 rounded text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
            >
              + New ticket
            </button>
          </div>

          {/* Divider */}
          <div className="my-1 border-t border-gray-800" />

          {/* Work section */}
          <div className="space-y-0.5">
            <p className="px-3 py-1 text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
              Work
            </p>
            <NavItem
              label="Tasks"
              active={activePage === "tasks"}
              onClick={() => navigate("tasks")}
            />
            <NavItem
              label="Logs"
              active={activePage === "logs"}
              onClick={() => navigate("logs")}
            />
          </div>

          {/* Projects section */}
          {projects.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-800" />
              <div className="space-y-0.5">
                <button
                  onClick={() => setProjectsExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-semibold text-gray-600 uppercase tracking-wider hover:text-gray-400 transition-colors"
                >
                  <span>Projects</span>
                  <span>{projectsExpanded ? "▾" : "▸"}</span>
                </button>
                {projectsExpanded &&
                  projects.map((name) => (
                    <div
                      key={name}
                      className="flex items-center gap-2 px-3 py-1 text-sm text-gray-400"
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${projectColor(name)}`}
                      />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
              </div>
            </>
          )}

          {/* Spacer */}
          <div className="flex-1" />
        </div>

        {/* Bottom section */}
        <div className="shrink-0 border-t border-gray-800 px-2 py-3 space-y-2">
          <NavItem
            label="Settings"
            active={activePage === "settings"}
            onClick={() => navigate("settings")}
          />

          <div className="border-t border-gray-800 pt-2 px-1 space-y-2">
            {/* Budget gauge */}
            {status && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Budget</span>
                  <span className="tabular-nums text-gray-400">
                    ${status.costInWindow.toFixed(2)}
                    <span className="text-gray-600"> / </span>$
                    {status.budgetLimit.toFixed(2)}
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

            {/* Active sessions + sync */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                {status && status.activeSessions > 0 && (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                  </span>
                )}
                <span>{status?.activeSessions ?? 0} active</span>
              </div>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-2 py-1 rounded text-xs bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {syncing ? "Syncing..." : "Sync"}
              </button>
            </div>
          </div>
        </div>
      </div>

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

export default function Sidebar({
  activePage,
  onNavigate,
  status,
  tasks,
  onSync,
  onConfigUpdate: _onConfigUpdate,
  onNewTicket,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden md:flex flex-col w-[200px] h-full border-r border-gray-800 bg-gray-950 shrink-0">
        <SidebarContent
          activePage={activePage}
          onNavigate={onNavigate}
          status={status}
          tasks={tasks}
          onSync={onSync}
          onNewTicket={onNewTicket}
        />
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={onMobileClose}
          />
          {/* Slide-in panel */}
          <div className="fixed inset-y-0 left-0 z-50 w-[200px] bg-gray-950 md:hidden">
            <SidebarContent
              activePage={activePage}
              onNavigate={onNavigate}
              status={status}
              tasks={tasks}
              onSync={onSync}
              onNewTicket={onNewTicket}
              onClose={onMobileClose}
            />
          </div>
        </>
      )}
    </>
  );
}
