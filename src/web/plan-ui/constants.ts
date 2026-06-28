import { SessionKind, SessionState, TaskStatus } from "../../shared/types.ts";

// Shared lookup maps for the task/session badges rendered across the panes
// (Active, Backlog, Archive). Keeping them in one place means a task looks the
// same whichever pane shows it.

export const STATUS_COLOR: Record<TaskStatus, string> = {
  [TaskStatus.Pending]: "gray",
  [TaskStatus.Dispatched]: "blue",
  [TaskStatus.Merged]: "green",
};

// "Try Again" is the user-facing label for a session parked waiting to resume.
export const SESSION_BADGE: Record<SessionState, { label: string; color: string }> = {
  [SessionState.Running]: { label: "running", color: "blue" },
  [SessionState.Waiting]: { label: "Try Again", color: "yellow" },
  [SessionState.Idle]: { label: "idle", color: "gray" },
  [SessionState.Stopped]: { label: "stopped", color: "red" },
};

// Glyph per session kind. Typed as Record<SessionKind, …> so adding a kind is a
// compile error here until it has an icon — the same total-coverage guarantee the
// status/badge maps rely on.
export const KIND_ICON: Record<SessionKind, string> = {
  [SessionKind.Local]: "💻",
  [SessionKind.Remote]: "☁️",
};
