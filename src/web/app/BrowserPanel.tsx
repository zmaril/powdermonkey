import type { IDockviewPanelProps } from "dockview-react";
import { BrowserPane } from "../BrowserPane.tsx";
import { useStore } from "../store.ts";

export function BrowserPanel(props: IDockviewPanelProps<{ url: string }>) {
  const rememberBrowserUrl = useStore((s) => s.rememberBrowserUrl);
  // Persist a navigation two ways: into this panel's params (so the layout, which is
  // serialized and saved, brings the URL back on reload) and into the store's
  // last-used URL (so the next fresh Browser pane opens where you left off).
  const onNavigate = (url: string) => {
    props.api.updateParameters({ url });
    rememberBrowserUrl(url);
  };
  return <BrowserPane url={props.params.url ?? ""} onNavigate={onNavigate} />;
}
