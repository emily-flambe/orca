import { useState } from "react";
import type { Task } from "../types";

type Page = "dashboard" | "tasks" | "logs" | "settings";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  activeSessions: number;
  tasks: Task[];
  onSync: () => Promise<void>;
  onNewTicket: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

const PROJECT_COLORS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-pink-500",
  "bg-orange-500",
];

function hashProjectName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getProjectColor(name: string): string {
  return PROJECT_COLORS[hashProjectName(name) % PROJECT_COLORS.length]!;
}

export default function Sidebar({
  activePage,
  onNavigate,
  activeSessions,
  tasks,
  onNewTicket,
  theme,
  onToggleTheme,
}: SidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);

  const uniqueProjects = Array.from(
    new Set(tasks.map((t) => t.projectName).filter((p): p is string => p !== null))
  );

  const navItem = (page: Page, label: string) => {
    const active = activePage === page;
    return (
      <button
        key={page}
        onClick={() => onNavigate(page)}
        className={`px-3 py-2 text-sm rounded-md w-full text-left transition-colors ${
          active
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:text-gray-200"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="w-[200px] h-full bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Logo */}
      <div className="px-4 py-4 shrink-0">
        <span className="text-white font-bold text-base">Orca</span>
      </div>

      {/* Nav content */}
      <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto">
        {/* Dashboard with active sessions badge */}
        <button
          onClick={() => onNavigate("dashboard")}
          className={`px-3 py-2 text-sm rounded-md w-full text-left transition-colors flex items-center justify-between ${
            activePage === "dashboard"
              ? "bg-gray-800 text-white"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          <span>Dashboard</span>
          {activeSessions > 0 && (
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-xs font-medium">
              {activeSessions}
            </span>
          )}
        </button>

        {/* New ticket button */}
        <button
          onClick={onNewTicket}
          className="px-3 py-2 text-sm rounded-md w-full text-left text-gray-400 hover:text-gray-200 transition-colors"
        >
          + New ticket
        </button>

        {/* Divider */}
        <div className="my-1 border-t border-gray-800" />

        {/* Work section */}
        <div className="px-3 py-1 text-xs text-gray-600 uppercase tracking-wider">Work</div>
        {navItem("tasks", "Tasks")}
        {navItem("logs", "Logs")}

        {/* Divider */}
        <div className="my-1 border-t border-gray-800" />

        {/* Projects section */}
        <button
          onClick={() => setProjectsOpen((o) => !o)}
          className="px-3 py-2 text-sm rounded-md w-full text-left text-gray-400 hover:text-gray-200 transition-colors flex items-center justify-between"
        >
          <span>Projects</span>
          <span className="text-gray-600">{projectsOpen ? "▾" : "▸"}</span>
        </button>

        {projectsOpen && (
          <div className="flex flex-col gap-0.5">
            {uniqueProjects.length === 0 ? (
              <span className="px-3 py-1.5 text-xs text-gray-600">No projects</span>
            ) : (
              uniqueProjects.map((name) => (
                <div
                  key={name}
                  className="px-3 py-1.5 text-sm text-gray-400 flex items-center gap-2"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${getProjectColor(name)}`} />
                  <span className="truncate">{name}</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* Divider */}
        <div className="my-1 border-t border-gray-800" />
      </div>

      {/* Bottom section */}
      <div className="px-2 pb-3 shrink-0 flex flex-col gap-0.5">
        {navItem("settings", "Settings")}
        <button
          onClick={onToggleTheme}
          className="px-3 py-2 text-sm rounded-md w-full text-left text-gray-400 hover:text-gray-200 transition-colors"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "☀ Light" : "☾ Dark"}
        </button>
      </div>
    </div>
  );
}
