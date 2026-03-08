import { useState, useEffect } from "react";
import type { OrcaStatus, Task } from "../types";
import CreateTicketModal from "./CreateTicketModal";

export type Page = "dashboard" | "tasks" | "logs" | "settings";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  tasks: Task[];
  onNewTicket: (identifier: string) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

const PROJECT_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-purple-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-cyan-500",
];

function getTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem("theme") as "dark" | "light") ?? "dark";
}

function applyTheme(theme: "dark" | "light") {
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
  }
  localStorage.setItem("theme", theme);
}

export default function Sidebar({
  activePage,
  onNavigate,
  status,
  tasks,
  onNewTicket,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const [showModal, setShowModal] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(getTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  };

  // Derive unique projects from tasks
  const projects = Array.from(
    new Set(tasks.map((t) => t.projectName).filter((p): p is string => Boolean(p)))
  );

  const activeSessions = status?.activeSessions ?? 0;

  const navItem = (page: Page, label: string) => {
    const isActive = activePage === page;
    return (
      <button
        key={page}
        onClick={() => {
          onNavigate(page);
          onMobileClose();
        }}
        className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
          isActive
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
        }`}
      >
        {label}
      </button>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-gray-900 w-[200px] shrink-0">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🐋</span>
          <span className="font-semibold text-gray-100 text-base">Orca</span>
        </div>
      </div>

      {/* Dashboard + New ticket */}
      <div className="px-2 pt-3 pb-2 border-b border-gray-800 space-y-1">
        <button
          onClick={() => {
            onNavigate("dashboard");
            onMobileClose();
          }}
          className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between ${
            activePage === "dashboard"
              ? "bg-gray-800 text-white"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
          }`}
        >
          <span>Dashboard</span>
          {activeSessions > 0 && (
            <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-blue-500 text-white font-medium">
              {activeSessions}
            </span>
          )}
        </button>
        <button
          onClick={() => { onMobileClose(); setShowModal(true); }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
        >
          + New ticket
        </button>
      </div>

      {/* Nav items */}
      <div className="px-2 pt-3 pb-2 border-b border-gray-800 space-y-1">
        {navItem("tasks", "Tasks")}
        {navItem("logs", "Logs")}
      </div>

      {/* Projects */}
      <div className="px-2 pt-3 pb-2 border-b border-gray-800">
        <button
          onClick={() => setProjectsOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider hover:text-gray-300 transition-colors"
        >
          <span>Projects</span>
          <span className="text-gray-600">{projectsOpen ? "▾" : "▸"}</span>
        </button>
        {projectsOpen && (
          <div className="mt-1 space-y-1">
            {projects.length === 0 ? (
              <div className="px-3 py-1 text-xs text-gray-600">No projects</div>
            ) : (
              projects.map((project, i) => (
                <div
                  key={project}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 rounded-md"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${PROJECT_COLORS[i % PROJECT_COLORS.length]}`}
                  />
                  <span className="truncate">{project}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom: Settings + Theme */}
      <div className="px-2 pb-3 space-y-1 border-t border-gray-800 pt-2">
        {navItem("settings", "Settings")}
        <button
          onClick={toggleTheme}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors flex items-center gap-2"
        >
          <span>{theme === "dark" ? "◑" : "○"}</span>
          <span>Theme</span>
        </button>
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
    </div>
  );

  return (
    <>
      {/* Desktop sidebar - always visible */}
      <div className="hidden md:flex h-full">
        {sidebarContent}
      </div>

      {/* Mobile sidebar - overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={onMobileClose}
          />
          {/* Sidebar panel */}
          <div className="relative z-10 h-full">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
