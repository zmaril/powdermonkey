import type { IDockviewPanelProps } from "dockview-react";
import { ArchivePane } from "../panes/archive/ArchivePane.tsx";

export function ArchivePanel(props: IDockviewPanelProps) {
  return <ArchivePane api={props.api} />;
}
