import type { IDockviewPanelProps } from "dockview-react";
import { BacklogPane } from "../panes/backlog/BacklogPane.tsx";

export function BacklogPanel(props: IDockviewPanelProps) {
  return <BacklogPane api={props.api} />;
}
