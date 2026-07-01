import type { IDockviewPanelProps } from "dockview-react";
import { TasksPane } from "../panes/tasks/TasksPane.tsx";

export function TasksPanel(props: IDockviewPanelProps) {
  return <TasksPane api={props.api} />;
}
