import type { Page } from "./Sidebar";

const PAGE_TITLES: Record<Page, string> = {
  dashboard: "Dashboard",
  tasks: "Tasks",
  logs: "Logs",
  settings: "Settings",
  cron: "Cron",
};

interface HeaderProps {
  activePage: Page;
  onOpenSidebar: () => void;
}

export default function Header({ activePage, onOpenSidebar }: HeaderProps) {
  return (
    <div className="sticky top-0 z-20 h-14 flex items-center px-4 border-b border-gray-800 bg-gray-950 shrink-0">
      {/* Left side */}
      <button
        onClick={onOpenSidebar}
        className="md:hidden flex items-center justify-center w-11 h-11 -ml-2 mr-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        aria-label="Open navigation"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="3" y1="5" x2="17" y2="5" />
          <line x1="3" y1="10" x2="17" y2="10" />
          <line x1="3" y1="15" x2="17" y2="15" />
        </svg>
      </button>

      <span className="md:hidden text-sm font-bold tracking-widest uppercase text-gray-100">
        Orca
      </span>

      <span className="hidden md:block text-sm font-semibold text-gray-200">
        {PAGE_TITLES[activePage]}
      </span>
    </div>
  );
}
