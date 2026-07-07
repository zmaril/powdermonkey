import type { IDockviewPanelProps } from "dockview-react";
import { SessionsPane } from "../panes/sessions/SessionsPane.tsx";

export function SessionsPanel(props: IDockviewPanelProps) {
  return <SessionsPane api={props.api} />;
}
