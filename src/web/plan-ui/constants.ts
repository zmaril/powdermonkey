import { type Icon, IconCloud, IconDeviceLaptop, IconServer } from "@tabler/icons-react";
import { SessionKind, SessionState, TaskKind, TaskStatus } from "../../shared/types.ts";

// Shared lookup maps for the task/session badges rendered across the panes
// (Active, Backlog, Archive). Keeping them in one place means a task looks the
// same whichever pane shows it.

export const STATUS_COLOR: Record<TaskStatus, string> = {
  [TaskStatus.Pending]: "gray",
  [TaskStatus.Dispatched]: "blue",
  [TaskStatus.Merged]: "green",
  [TaskStatus.Cancelled]: "red",
};

// "Try Again" is the user-facing label for a session parked waiting to resume.
export const SESSION_BADGE: Record<SessionState, { label: string; color: string }> = {
  [SessionState.Running]: { label: "running", color: "blue" }, // lint-allow-string: UI label
  [SessionState.Waiting]: { label: "Try Again", color: "yellow" },
  [SessionState.Idle]: { label: "idle", color: "gray" }, // lint-allow-string: UI label
  [SessionState.Stopped]: { label: "stopped", color: "red" }, // lint-allow-string: UI label
};

// Badge color per task kind. Total over TaskKind so adding a kind is a compile
// error here until it has a color. `task` has one for totality, but KindBadge
// never renders it — the default kind on every card would be noise.
export const TASK_KIND_COLOR: Record<TaskKind, string> = {
  [TaskKind.Task]: "gray",
  [TaskKind.Bug]: "red",
  [TaskKind.Spike]: "grape",
};

// Icon per session kind. Typed as Record<SessionKind, Icon> so adding a kind is a
// compile error here until it has an icon — the same total-coverage guarantee the
// status/badge maps rely on. Consumers render the component (e.g. `<Icon size={14} />`).
export const KIND_ICON: Record<SessionKind, Icon> = {
  [SessionKind.Local]: IconDeviceLaptop,
  [SessionKind.Remote]: IconCloud,
  [SessionKind.Exe]: IconServer,
};
