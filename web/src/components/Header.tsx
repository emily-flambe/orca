import type { Page } from "./Sidebar";

const PAGE_TITLES: Record<Page, string> = {
  dashboard: "Dashboard",
  tasks: "Tasks",
  logs: "Logs",
  settings: "Settings",
};

interface HeaderProps {
  activePage: Page;
  onOpenSidebar: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export default function Header({
  activePage,
  onOpenSidebar,
  theme,
  onToggleTheme,
}: HeaderProps) {
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

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side */}
      <button
        onClick={onToggleTheme}
        className="flex items-center justify-center w-11 h-11 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
        title={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
      >
        {theme === "dark" ? (
          // Sun icon
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          // Moon icon
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>
    </div>
  );
}
