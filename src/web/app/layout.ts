import type { DockviewApi } from "dockview-react";
import { ActivePane } from "../panes/active/ActivePane.tsx";
import { ArchivePane } from "../panes/archive/ArchivePane.tsx";
import { BacklogPane } from "../panes/backlog/BacklogPane.tsx";
import { ScratchPad } from "./ScratchPad.tsx";
import { ShellPanel } from "./ShellPanel.tsx";

// The dockview component registry: each panel id maps to the component that renders
// it. The panes and the scratchpad take no panel props, so they're registered
// directly (dockview hands them props they ignore); only ShellPanel needs the
// panel api/params, so it's the one wrapper here.
export const dockComponents = {
  shell: ShellPanel,
  active: ActivePane,
  backlog: BacklogPane,
  archive: ArchivePane,
  scratch: ScratchPad,
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
    id: "archive",
    component: "archive",
    title: "Archive",
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
    title: "supervisor",
    position: { direction: "below", referencePanel: "scratch" },
  });
  // Show Active first (adding Backlog "within" would otherwise leave it focused).
  active.api.setActive();
}
