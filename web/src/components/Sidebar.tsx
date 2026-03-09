import { useState, useRef, useCallback, useEffect } from "react";
import type { OrcaStatus, Task } from "../types";
import CreateTicketModal from "./CreateTicketModal";

export type Page = "dashboard" | "tasks" | "logs" | "settings";

const MIN_WIDTH = 150;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 200;
const STORAGE_KEY = "orca-sidebar-width";

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
  } catch {
    return DEFAULT_WIDTH;
  }
}

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  status: OrcaStatus | null;
  tasks: Task[];
  onSync: () => Promise<void>;
  onNewTicket: (identifier: string) => void;
  isOpen: boolean; // mobile open state
}

// Simple hash to pick a color for a project name
const PROJECT_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-red-500",
];

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]!;
}

export default function Sidebar({
  activePage,
  onNavigate,
  status,
  tasks,
  onSync,
  onNewTicket,
  isOpen,
}: SidebarProps) {
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  // Refs to track active drag listeners so we can clean them up on unmount.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Clean up any active drag listeners on unmount.
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (window.innerWidth < 768) return;
    e.preventDefault();
    setIsDragging(true);

    const sidebarEl = sidebarRef.current;
    if (!sidebarEl) return;
    const rect = sidebarEl.getBoundingClientRect();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = moveEvent.clientX - rect.left;
      setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth)));
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragCleanupRef.current = null;
    };

    const onMouseUp = () => {
      setIsDragging(false);
      cleanup();
      // Read the final width from the ref to avoid the setState-as-side-effect anti-pattern.
      const finalWidth = sidebarRef.current
        ? Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, sidebarRef.current.offsetWidth),
          )
        : null;
      if (finalWidth !== null) {
        try {
          localStorage.setItem(STORAGE_KEY, String(finalWidth));
        } catch {
          // ignore
        }
      }
    };

    dragCleanupRef.current = cleanup;
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.body.style.userSelect = "none";
    } else {
      document.body.style.userSelect = "";
    }
    return () => {
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  // Build projects list from tasks
  const projectCounts: Record<string, number> = {};
  for (const task of tasks) {
    if (task.projectName) {
      projectCounts[task.projectName] =
        (projectCounts[task.projectName] ?? 0) + 1;
    }
  }
  const projects = Object.entries(projectCounts).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  // Build queued tasks list
  const QUEUED_STATUSES = new Set(["ready", "in_review", "changes_requested"]);
  const QUEUED_PHASE_ORDER: Record<string, number> = {
    in_review: 0,
    changes_requested: 1,
    ready: 2,
  };
  const queuedTasks = tasks
    .filter((t) => QUEUED_STATUSES.has(t.orcaStatus))
    .sort((a, b) => {
      const phaseA = QUEUED_PHASE_ORDER[a.orcaStatus] ?? 99;
      const phaseB = QUEUED_PHASE_ORDER[b.orcaStatus] ?? 99;
      if (phaseA !== phaseB) return phaseA - phaseB;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return timeA - timeB;
    });

  const navItemClass = (page: Page) =>
    `flex items-center gap-2.5 px-3 py-2 rounded text-sm cursor-pointer transition-colors w-full text-left ${
      activePage === page
        ? "bg-gray-800 text-white"
        : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
    }`;

  return (
    <>
      {/* Sidebar panel */}
      <div
        ref={sidebarRef}
        className={`
          fixed md:relative inset-y-0 left-0 z-20
          flex flex-col bg-gray-900 border-r border-gray-800 shrink-0
          transition-transform duration-200
          ${isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
        style={{ width: `${sidebarWidth}px` }}
      >
        {/* Header */}
        <div className="h-14 flex items-center px-4 border-b border-gray-800 shrink-0">
          <span className="text-sm font-bold tracking-widest uppercase text-gray-100">
            Orca
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
          {/* Dashboard */}
          <button
            className={navItemClass("dashboard")}
            onClick={() => onNavigate("dashboard")}
          >
            <span>Dashboard</span>
            {status && status.activeSessions > 0 && (
              <span className="ml-auto flex items-center gap-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                <span className="text-xs text-blue-400 tabular-nums">
                  {status.activeSessions}
                </span>
              </span>
            )}
          </button>

          {/* New ticket button */}
          <button
            className="flex items-center gap-2.5 px-3 py-2 rounded text-sm cursor-pointer transition-colors w-full text-left text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
            onClick={() => setShowModal(true)}
          >
            <span className="text-gray-500">+</span>
            <span>New ticket</span>
          </button>

          <div className="my-1 border-t border-gray-800" />

          {/* Tasks */}
          <button
            className={navItemClass("tasks")}
            onClick={() => onNavigate("tasks")}
          >
            <span>Tasks</span>
            {tasks.length > 0 && (
              <span className="ml-auto text-xs text-gray-500 tabular-nums">
                {tasks.length}
              </span>
            )}
          </button>

          {/* Logs */}
          <button
            className={navItemClass("logs")}
            onClick={() => onNavigate("logs")}
          >
            <span>Logs</span>
          </button>

          {/* Queued section */}
          {queuedTasks.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-800" />
              <div className="px-3 py-1.5 text-xs text-gray-500 uppercase tracking-wider font-medium">
                Queued
              </div>
              <div className="flex flex-col gap-0.5">
                {queuedTasks.slice(0, 5).map((task) => (
                  <div
                    key={task.linearIssueId}
                    className="flex items-center gap-2 px-3 py-1.5 rounded text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-800/40 transition-colors cursor-default"
                  >
                    <span className="text-gray-500 font-mono tabular-nums shrink-0">
                      {task.linearIssueId}
                    </span>
                    <span className="truncate text-gray-400">
                      {task.agentPrompt}
                    </span>
                  </div>
                ))}
                {queuedTasks.length > 5 && (
                  <button
                    className="px-3 py-1 text-xs text-gray-500 hover:text-gray-400 text-left transition-colors"
                    onClick={() => onNavigate("tasks")}
                  >
                    view all
                  </button>
                )}
              </div>
            </>
          )}

          <div className="my-1 border-t border-gray-800" />

          {/* Projects section */}
          <button
            className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-400 transition-colors w-full text-left"
            onClick={() => setProjectsExpanded((v) => !v)}
          >
            <span className="uppercase tracking-wider font-medium">
              Projects
            </span>
            <span className="ml-auto text-gray-600">
              {projectsExpanded ? "▾" : "▸"}
            </span>
          </button>

          {projectsExpanded && (
            <div className="flex flex-col gap-0.5">
              {projects.length === 0 ? (
                <div className="px-3 py-1 text-xs text-gray-600 italic">
                  No projects
                </div>
              ) : (
                projects.map(([name, count]) => (
                  <div
                    key={name}
                    className="flex items-center gap-2.5 px-3 py-1.5 rounded text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-800/40 transition-colors cursor-default"
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full shrink-0 ${projectColor(name)}`}
                    />
                    <span className="truncate">{name}</span>
                    <span className="ml-auto text-gray-600 tabular-nums">
                      {count}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          <div className="my-1 border-t border-gray-800" />

          {/* Settings */}
          <button
            className={navItemClass("settings")}
            onClick={() => onNavigate("settings")}
          >
            <span>Settings</span>
          </button>
        </nav>

        {/* Drag handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hidden md:block group/handle"
          onMouseDown={handleDragStart}
        >
          <div className="absolute inset-y-0 right-0 w-1 bg-transparent group-hover/handle:bg-gray-700 transition-colors" />
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 px-2 py-2 shrink-0">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full px-2 py-1.5 rounded text-xs bg-purple-600 text-purple-100 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>

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
