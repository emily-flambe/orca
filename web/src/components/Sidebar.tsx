import type { OrcaStatus } from "../types";

export type Page =
  | "tasks"
  | "metrics"
  | "cron"
  | "agents"
  | "logs"
  | "settings"
  | "health";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  isOpen: boolean; // mobile open state
}

export default function Sidebar({
  activePage,
  onNavigate,
  status,
  isOpen,
}: SidebarProps) {
  const activeCount = status?.activeSessions ?? 0;

  const navItemClass = (page: Page) =>
    `flex items-center gap-2.5 px-3 py-2 rounded text-sm cursor-pointer transition-colors w-full text-left ${
      activePage === page
        ? "bg-gray-800 text-white"
        : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
    }`;

  return (
    <div
      className={`
        fixed md:relative inset-y-0 left-0 z-20
        flex flex-col bg-gray-900 border-r border-gray-800 shrink-0
        transition-transform duration-200
        ${isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
      `}
      style={{ width: "200px" }}
    >
      {/* Header */}
      <div className="h-14 flex items-center px-4 border-b border-gray-800 shrink-0">
        <span className="text-sm font-bold tracking-widest uppercase text-gray-100">
          Orca
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
        {/* Tasks */}
        <button
          aria-label="Tasks"
          className={navItemClass("tasks")}
          onClick={() => onNavigate("tasks")}
        >
          <span>Tasks</span>
          {activeCount > 0 && (
            <span className="ml-auto bg-blue-600 text-white text-xs rounded-full px-1.5 py-0.5 tabular-nums">
              {activeCount}
            </span>
          )}
        </button>

        {/* Metrics */}
        <button
          aria-label="Metrics"
          className={navItemClass("metrics")}
          onClick={() => onNavigate("metrics")}
        >
          <span>Metrics</span>
        </button>

        {/* Cron */}
        <button
          aria-label="Cron"
          className={navItemClass("cron")}
          onClick={() => onNavigate("cron")}
        >
          <span>Cron</span>
        </button>

        {/* Agents */}
        <button
          aria-label="Agents"
          className={navItemClass("agents")}
          onClick={() => onNavigate("agents")}
        >
          <span>Agents</span>
        </button>

        {/* Logs */}
        <button
          aria-label="Logs"
          className={navItemClass("logs")}
          onClick={() => onNavigate("logs")}
        >
          <span>Logs</span>
        </button>

        {/* Health */}
        <button
          aria-label="Health"
          className={navItemClass("health")}
          onClick={() => onNavigate("health")}
        >
          <span>Health</span>
        </button>

        {/* Settings */}
        <button
          aria-label="Settings"
          className={navItemClass("settings")}
          onClick={() => onNavigate("settings")}
        >
          <span>Settings</span>
        </button>
      </nav>
    </div>
  );
}
