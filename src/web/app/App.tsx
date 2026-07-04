import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type SerializedDockview,
} from "dockview-react";
import { useEffect, useRef } from "react";
import { useNeedsInputNotifications } from "../notifications.ts";
import { useRevealEntity } from "../reveal.ts";
import { useActiveTheme, useStore } from "../store.ts";
import { ActivityTab, useTabActivity } from "../TabActivity.tsx";
import { DisconnectBanner } from "./DisconnectBanner.tsx";
import { buildDefaultLayout, dockComponents, PANE_TITLES } from "./layout.ts";
import { ReviewOverlay } from "./ReviewOverlay.tsx";
import { TopBar } from "./TopBar.tsx";
import { useConnectionWatch } from "./useConnectionWatch.ts";

// The single pane of glass. The plan is split into two list panels — a SESSIONS
// monitor (every run of work, live + history) and a TASKS launchpad/record (every
// task, any status) — alongside the scratchpad and the supervisor shell. Done/archived
// is a status filter on each, not its own tab. Every panel renders off TanStack DB
// collections (collections.ts) that sync themselves live from PGlite over /sync —
// no store data, no poll, no refetch (see plan-data.ts).
//
// The dock layout is store state (useStore.layout), persisted by the store's
// `persist` middleware so the disconnect→reload recovery (and any plain browser
// refresh) keeps your panes. App mirrors that state onto the dockview api: onReady
// restores it, and onDidLayoutChange writes every change back via setLayout.

// True when every panel in a saved layout maps to a component we still register, so
// dockview's fromJSON won't try to mount a panel whose component was renamed away. A
// shell/browser panel id is suffixed (shell-0, browser-2); the component name lives in
// the panel's `contentComponent`, which is what we check.
function layoutIsCompatible(saved: SerializedDockview): boolean {
  const panels = saved.panels ?? {};
  const known = new Set(Object.keys(dockComponents));
  return Object.values(panels).every((p) => known.has(p.contentComponent ?? ""));
}

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

  // Jump to a plan entity when its id is clicked in the terminal (pm-id links): focus
  // the pane it lives in, scroll it into view, and flash it.
  useRevealEntity(apiRef);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    // Restore the layout from the store (rehydrated from localStorage by persist);
    // otherwise lay out the default. A corrupt/incompatible saved layout (or one
    // that restores to nothing) falls back to the default so a reload can never
    // leave you staring at a blank dock. A layout saved before a pane rename can
    // still reference a component id we no longer register (e.g. the old
    // active/backlog panes) — applying that would render a broken panel, so we
    // discard it up front and rebuild the default.
    const saved = useStore.getState().layout;
    let restored = false;
    if (saved && layoutIsCompatible(saved)) {
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
  // the layout. Added in the main group, alongside Sessions/Tasks.
  useEffect(() => {
    const api = apiRef.current;
    if (!browserReq) return;
    api?.addPanel({
      id: `browser-${browserReq.n}`,
      component: "browser",
      params: { url: browserReq.url },
      title: "Browser",
      position: { referencePanel: "sessions", direction: "within" },
    });
  }, [browserReq]);

  // A pane-launcher button → focus the singleton pane if it's already open, else add
  // it. New panes land "within" the main group (next to Sessions/Tasks) when
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
    const anchor = api.getPanel("sessions") ? "sessions" : api.panels[0]?.id;
    api.addPanel({
      id: paneReq.id,
      component: paneReq.id,
      title: PANE_TITLES[paneReq.id] ?? paneReq.id,
      position: anchor ? { referencePanel: anchor, direction: "within" } : undefined,
    });
  }, [paneReq]);

  const disconnected = useConnectionWatch();
  // The dock chrome follows the selected editor theme (store state). Switching it in
  // Settings swaps dockview's theme live, alongside the Mantine re-skin in main.tsx.
  const editor = useActiveTheme();
  // One Dark has no native dockview theme — it rides Abyss, re-skinned in theme.css.
  // The wrapper class scopes that re-skin so the native Abyss theme stays untouched.
  const skinClass = editor.key === "one-dark" ? "pm-skin-onedark" : undefined;

  return (
    <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
      {disconnected && <DisconnectBanner />}
      <TopBar />
      <div className={skinClass} style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact
          components={dockComponents}
          defaultTabComponent={ActivityTab}
          onReady={onReady}
          theme={editor.dockTheme}
        />
      </div>
      <ReviewOverlay />
    </div>
  );
}
