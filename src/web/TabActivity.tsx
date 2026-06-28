import {
  type DockviewApi,
  DockviewDefaultTab,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import { type RefObject, useEffect, useRef } from "react";
import { useStore } from "./store.ts";
import { type ActivitySnapshot, paneActivity, snapshotActivity } from "./tab-activity.ts";

// The in-app activity layer: a dot on a dockview tab when its pane has changes you
// haven't seen (its tab wasn't on screen). The cue clears the instant you look.

// One injected stylesheet for the activity dot.
const DOT_STYLE_ID = "pm-tab-activity-style";
function ensureDotStyle(): void {
  if (typeof document === "undefined" || document.getElementById(DOT_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = DOT_STYLE_ID;
  el.textContent = `
.pm-tab-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #4dabf7;
  margin-right: 6px; flex: 0 0 auto;
}`;
  document.head.appendChild(el);
}

/** Custom dockview tab = the default tab (title + close) prefixed with an activity
 *  dot when this pane is flagged. Clears its own flag the moment the tab is viewed
 *  (becomes visible), so the cue is self-extinguishing. */
export function ActivityTab(props: IDockviewPanelHeaderProps) {
  const id = props.api.id;
  const flagged = useStore((s) => !!s.tabActivity[id]);
  const clearTab = useStore((s) => s.clearTab);

  useEffect(() => ensureDotStyle(), []);

  useEffect(() => {
    const clearIfVisible = () => {
      if (props.api.isVisible) clearTab(id);
    };
    clearIfVisible(); // already on screen when mounted → nothing to flag
    const d1 = props.api.onDidVisibilityChange(clearIfVisible);
    const d2 = props.api.onDidActiveChange(clearIfVisible);
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [id, props.api, clearTab]);

  return (
    <div style={{ display: "flex", alignItems: "center", height: "100%" }}>
      {flagged && <span className="pm-tab-dot" aria-hidden />}
      <DockviewDefaultTab {...props} />
    </div>
  );
}

/** Watch the store and light up tabs on the defined triggers — but only ones not
 *  currently on screen (a change in the pane you're looking at needs no cue). The
 *  first run only seeds the snapshot so a reload doesn't flag everything. */
export function useTabActivity(apiRef: RefObject<DockviewApi | null>): void {
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const flagTab = useStore((s) => s.flagTab);
  const prev = useRef<ActivitySnapshot | null>(null);

  useEffect(() => {
    const snap = snapshotActivity(sessions, tasks);
    if (prev.current === null) {
      prev.current = snap;
      return;
    }
    const panes = paneActivity(prev.current, snap);
    prev.current = snap;
    for (const pane of panes) {
      const visible = apiRef.current?.getPanel(pane)?.api.isVisible ?? false;
      if (!visible) flagTab(pane);
    }
  }, [sessions, tasks, flagTab, apiRef]);
}
