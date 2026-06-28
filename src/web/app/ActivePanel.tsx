import type { IDockviewPanelProps } from "dockview-react";
import { ActivePane } from "../panes/active/ActivePane.tsx";

// The tabbed list panes take their dockview panel api so they can persist/restore
// their scroll position across a tab switch — under the default 'onlyWhenVisible'
// renderer a switch detaches the pane's DOM (resetting scrollTop) while the React
// component stays mounted, so the visibility edge is the only signal to restore on.
export function ActivePanel(props: IDockviewPanelProps) {
  return <ActivePane api={props.api} />;
}
