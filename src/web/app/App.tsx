import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  themeAbyss,
} from "dockview-react";
import { useEffect, useRef } from "react";
import { ActivityTab, useTabActivity } from "../TabActivity.tsx";
import { useNeedsInputNotifications } from "../notifications.ts";
import { useStore } from "../store.ts";
import { DisconnectBanner } from "./DisconnectBanner.tsx";
import { ReviewOverlay } from "./ReviewOverlay.tsx";
import { TopBar } from "./TopBar.tsx";
import { PANE_TITLES, buildDefaultLayout, dockComponents } from "./layout.ts";
import { useConnectionWatch } from "./useConnectionWatch.ts";

// The single pane of glass. The plan is split into three panels — a live ACTIVE
// monitor, a launchpad BACKLOG editor, and the ARCHIVE book of work — alongside
// the scratchpad and the supervisor shell. Every panel renders off TanStack DB
// collections (collections.ts) that sync themselves live from PGlite over /sync —
// no store data, no poll, no refetch (see plan-data.ts).
//
// The dock layout is store state (useStore.layout), persisted by the store's
// `persist` middleware so the disconnect→reload recovery (and any plain browser
// refresh) keeps your panes. App mirrors that state onto the dockview api: onReady
// restores it, and onDidLayoutChange writes every change back via setLayout.

export function App() {
  const apiRef = useRef<DockviewApi | null>(null);
  const layoutSubRef = useRef<{ dispose: () => void } | null>(null);
  const shellReq = useStore((s) => s.shellReq);
  const browserReq = useStore((s) => s.browserReq);
  const paneReq = useStore((s) => s.paneReq);
  const setLayout = useStore((s) => s.setLayout);
  const loadSettings = useStore((s) => s.loadSettings);

  // The plan/session data flows through the TanStack DB collections (each syncs
  // itself over /sync). The only server state not in a collection is the auto-rebase
  // toggle, so fetch that once on mount.
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Ping the operator (OS notification) whenever a session falls idle at a prompt.
  // Watches the sessions collection, firing only on the needs_input edge.
  useNeedsInputNotifications();

  // In-app glanceable layer: light up a pane's tab when something happens in it
  // while its tab is off screen (new session, needs-you, task status change). The
  // tab clears itself when viewed. apiRef is set in onReady below.
  useTabActivity(apiRef);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Restore the layout from the store (rehydrated from localStorage by persist);
    // otherwise lay out the default. A corrupt/incompatible saved layout (or one
    // that restores to nothing) falls back to the default so a reload can never
    // leave you staring at a blank dock.
    const saved = useStore.getState().layout;
    let restored = false;
    if (saved) {
      try {
        event.api.fromJSON(saved);
        restored = event.api.panels.length > 0;
      } catch {
        restored = false;
      }
    }
    if (!restored) buildDefaultLayout(event.api);
    // Mirror every layout change back into the store — add/move/close a panel,
    // resize, focus a tab — so it persists and the next load (notably the
    // disconnect→reload) comes back as-is. Subscribed after the initial build so
    // restoring doesn't write over what we just restored.
    layoutSubRef.current = event.api.onDidLayoutChange(() => setLayout(event.api.toJSON()));
  };

  // Tear the layout subscription down with the component.
  useEffect(() => () => layoutSubRef.current?.dispose(), []);

  // Each open*Terminal() adds (or focuses) a shell panel keyed by shellReq.key.
  useEffect(() => {
    const api = apiRef.current;
    if (!shellReq || !api) return;
    const id = shellReq.key === "repo" ? "shell-0" : `shell-${shellReq.key}`;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id,
      component: "shell",
      params: { cwd: shellReq.cwd, session: shellReq.session },
      // Session panels show the bare tag (LOCAL · PM/TASK-35); plain shells keep
      // a "shell · " prefix to set them apart.
      title: shellReq.session != null ? shellReq.title : `shell · ${shellReq.title}`,
      position: { referencePanel: "shell-0", direction: "within" },
    });
  }, [shellReq]);

  // Browser button → add a new browser pane (an iframe on a dev server / preview).
  // Each request opens a distinct panel (keyed by `n`) so you can watch several
  // previews at once; the loaded URL rides in the panel params so it persists with
  // the layout. Added in the main group, alongside Active/Backlog/Archive.
  useEffect(() => {
    const api = apiRef.current;
    if (!browserReq) return;
    api?.addPanel({
      id: `browser-${browserReq.n}`,
      component: "browser",
      params: { url: browserReq.url },
      title: "Browser",
      position: { referencePanel: "active", direction: "within" },
    });
  }, [browserReq]);

  // A pane-launcher button → focus the singleton pane if it's already open, else add
  // it. New panes land "within" the main group (next to Active/Backlog/Archive) when
  // that anchor exists, otherwise wherever dockview puts a group-less panel — so a
  // launcher always brings the pane up even if the default layout was torn apart.
  useEffect(() => {
    const api = apiRef.current;
    if (!paneReq || !api) return;
    const existing = api.getPanel(paneReq.id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const anchor = api.getPanel("active") ? "active" : api.panels[0]?.id;
    api.addPanel({
      id: paneReq.id,
      component: paneReq.id,
      title: PANE_TITLES[paneReq.id] ?? paneReq.id,
      position: anchor ? { referencePanel: anchor, direction: "within" } : undefined,
    });
  }, [paneReq]);

  const disconnected = useConnectionWatch();

  return (
    <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
      {disconnected && <DisconnectBanner />}
      <TopBar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact
          components={dockComponents}
          defaultTabComponent={ActivityTab}
          onReady={onReady}
          theme={themeAbyss}
        />
      </div>
      <ReviewOverlay />
    </div>
  );
}
