import type { ReactNode } from "react";

/**
 * The few icons the UI needs, drawn on one 16px grid with one stroke width so they read as a set.
 * Always decorative: the control they sit in carries the name, as visible text or an `aria-label`.
 */
const icon =
  (paths: ReactNode) =>
  ({ className = "" }: { className?: string }) => (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4 shrink-0 ${className}`}
    >
      {paths}
    </svg>
  );

export const MenuIcon = icon(<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />);
export const CloseIcon = icon(<path d="M4 4l8 8M12 4l-8 8" />);
export const PlusIcon = icon(<path d="M8 3v10M3 8h10" />);
export const ChevronIcon = icon(<path d="M6 3.5L10.5 8 6 12.5" />);
export const SendIcon = icon(<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />);
export const StopIcon = icon(<rect x="4" y="4" width="8" height="8" rx="1.5" />);
export const PaperclipIcon = icon(
  <path d="M13 7.5l-5.2 5.2a3.2 3.2 0 01-4.5-4.5l5.6-5.6a2.1 2.1 0 013 3l-5.6 5.6a1 1 0 01-1.5-1.5L10 4.5" />,
);
export const ChartIcon = icon(<path d="M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V9" />);
export const FolderIcon = icon(
  <path d="M2 4.5A1.5 1.5 0 013.5 3h2.8l1.5 1.5h4.7A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" />,
);
export const BranchIcon = icon(<path d="M5 2.5v11M5 10.5a3 3 0 003-3h1.5a2.5 2.5 0 002.5-2.5M12 3.5v1.5" />);
export const DiffIcon = icon(<path d="M8 2.5v6M5 5.5h6M5 12.5h6" />);
export const TerminalIcon = icon(<path d="M3.5 4.5L7 8l-3.5 3.5M8.5 12h4" />);
export const FileIcon = icon(<path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6zM9 2v4h4" />);
const thumb = (
  <path d="M5 7.5v6M5 7.5L7.5 2.5a1.5 1.5 0 011.5 1.5v2.5h3a1.5 1.5 0 011.5 1.7l-.6 3.6A1.5 1.5 0 0111.4 13.5H3.5a1 1 0 01-1-1v-4a1 1 0 011-1z" />
);
export const ThumbUpIcon = icon(thumb);
export const ThumbDownIcon = icon(<g transform="rotate(180 8 8)">{thumb}</g>);
