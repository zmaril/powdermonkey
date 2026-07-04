import type { DockviewApi } from "dockview-react";
import { AboutPanel } from "./AboutPanel.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { HelpPanel } from "./HelpPanel.tsx";
import { ScratchPanel } from "./ScratchPanel.tsx";
import { SessionsPanel } from "./SessionsPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { ShellPanel } from "./ShellPanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";

// The dockview component registry: each panel id maps to the component that renders
// it. The list panes (Sessions/Tasks) and Browser take their panel api/params through
// a thin wrapper; the prop-less panes render directly. The old Archive pane is gone —
// done/archived is a status filter on Sessions and Tasks now, not its own tab.
// Scratch is ONE global pane — the durable server-side note the supervisor reads
// as @notes — shown in every window; each window only remembers its own cursor
// into it (windows.ts ScratchCursor).
export const dockComponents = {
  shell: ShellPanel,
  sessions: SessionsPanel,
  tasks: TasksPanel,
  scratch: ScratchPanel,
  browser: BrowserPanel,
  settings: SettingsPanel,
  about: AboutPanel,
  help: HelpPanel,
};

// Tab titles for the singleton panes opened by the top-bar launchers (openPane →
// paneReq). Component name and panel id are the same string as the pane id.
export const PANE_TITLES: Record<string, string> = {
  sessions: "Sessions",
  tasks: "Tasks",
  scratch: "Scratch",
  settings: "Settings",
  about: "About",
  help: "Help",
};

// The default arrangement, built from scratch when there's no saved layout (or a
// saved one we couldn't restore): Sessions/Tasks tabs in the main group, the
// scratchpad over the supervisor shell on the left.
export function buildDefaultLayout(api: DockviewApi) {
  const sessions = api.addPanel({ id: "sessions", component: "sessions", title: "Sessions" });
  api.addPanel({
    id: "tasks",
    component: "tasks",
    title: "Tasks",
    position: { direction: "within", referencePanel: "sessions" },
  });
  api.addPanel({
    id: "scratch",
    component: "scratch",
    title: "Scratch",
    position: { direction: "left", referencePanel: "sessions" },
  });
  api.addPanel({
    id: "shell-0",
    component: "shell",
    params: { cwd: "", session: null },
    title: "supervisor", // lint-allow-string: shell panel title, not the decision source
    position: { direction: "below", referencePanel: "scratch" },
  });
  // Show Sessions first (adding Backlog "within" would otherwise leave it focused).
  sessions.api.setActive();
}
