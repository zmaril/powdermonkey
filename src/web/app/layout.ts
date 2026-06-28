import type { DockviewApi } from "dockview-react";
import { AboutPanel } from "./AboutPanel.tsx";
import { ActivePanel } from "./ActivePanel.tsx";
import { ArchivePanel } from "./ArchivePanel.tsx";
import { BacklogPanel } from "./BacklogPanel.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { HelpPanel } from "./HelpPanel.tsx";
import { PlanReviewPanel } from "./PlanReviewPanel.tsx";
import { ScratchPanel } from "./ScratchPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { ShellPanel } from "./ShellPanel.tsx";

// The dockview component registry: each panel id maps to the component that renders
// it. The list panes (Active/Backlog/Archive) and Browser take their panel api/params
// through a thin wrapper; the prop-less panes render directly.
export const dockComponents = {
  shell: ShellPanel,
  active: ActivePanel,
  backlog: BacklogPanel,
  archive: ArchivePanel,
  scratch: ScratchPanel,
  browser: BrowserPanel,
  settings: SettingsPanel,
  about: AboutPanel,
  help: HelpPanel,
  planreview: PlanReviewPanel,
};

// Tab titles for the singleton panes opened by the top-bar launchers (openPane →
// paneReq). Component name and panel id are the same string as the pane id.
export const PANE_TITLES: Record<string, string> = {
  active: "Active",
  backlog: "Backlog",
  archive: "Archive",
  scratch: "Scratch",
  settings: "Settings",
  about: "About",
  help: "Help",
  planreview: "Plan",
};

// The default arrangement, built from scratch when there's no saved layout (or a
// saved one we couldn't restore): Active/Backlog/Archive tabs in the main group,
// the scratchpad over the supervisor shell on the left.
export function buildDefaultLayout(api: DockviewApi) {
  const active = api.addPanel({ id: "active", component: "active", title: "Active" });
  api.addPanel({
    id: "backlog",
    component: "backlog",
    title: "Backlog",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "archive", // lint-allow-string: dockview panel id, not an enum value
    component: "archive", // lint-allow-string: dockview component name, not an enum value
    title: "Archive",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "planreview",
    component: "planreview",
    title: "Plan",
    position: { direction: "within", referencePanel: "active" },
  });
  api.addPanel({
    id: "scratch",
    component: "scratch",
    title: "Scratch",
    position: { direction: "left", referencePanel: "active" },
  });
  api.addPanel({
    id: "shell-0",
    component: "shell",
    params: { cwd: "", session: null },
    title: "supervisor", // lint-allow-string: shell panel title, not the decision source
    position: { direction: "below", referencePanel: "scratch" },
  });
  // Show Active first (adding Backlog "within" would otherwise leave it focused).
  active.api.setActive();
}
