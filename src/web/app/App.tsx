import "dockview-core/dist/styles/dockview.css";
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type SerializedDockview,
} from "dockview-react";
import { type RefObject, useEffect, useRef } from "react";
import { useNeedsInputNotifications } from "../notifications.ts";
import { useRevealEntity } from "../reveal.ts";
import { useActiveTheme, useStore } from "../store.ts";
import { ActivityTab, useTabActivity } from "../TabActivity.tsx";
import { useRunEffect } from "../use-run-effect.ts";
import { type PmWindow, mergeExternalWindows, resolveActive } from "../windows.ts";
import { DisconnectBanner } from "./DisconnectBanner.tsx";
import { buildDefaultLayout, dockComponents, PANE_TITLES } from "./layout.ts";
import { ReviewOverlay } from "./ReviewOverlay.tsx";
import { TopBar } from "./TopBar.tsx";
import { useConnectionWatch } from "./useConnectionWatch.ts";
import { WindowRail } from "./WindowRail.tsx";
import { WindowTabs } from "./WindowTabs.tsx";

type ShellReq = {
  key: string;
  cwd: string;
  session: number | null;
  title: string;
  n: number;
} | null;
type BrowserReq = { url: string; n: number } | null;
type PaneReq = { id: string; n: number } | null;

/** Dispose `ref.current` (a subscription) when the component unmounts. */
export function useDisposeOnUnmount(ref: RefObject<{ dispose: () => void } | null>): void {
  useEffect(() => () => ref.current?.dispose(), [ref]);
}

/** Each open*Terminal() adds (or focuses) a shell panel keyed by shellReq.key. */
export function useShellPanels(apiRef: RefObject<DockviewApi | null>, shellReq: ShellReq): void {
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
  }, [shellReq, apiRef]);
}

/** Browser button → add a new browser pane (an iframe on a dev server / preview).
 *  Each request opens a distinct panel (keyed by `n`) so several previews can run at
 *  once; the loaded URL rides in the panel params so it persists with the layout. */
export function useBrowserPanels(
  apiRef: RefObject<DockviewApi | null>,
  browserReq: BrowserReq,
): void {
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
  }, [browserReq, apiRef]);
}

/** A pane-launcher button → focus the singleton pane if it's already open, else add
 *  it. New panes land "within" the main group (next to Sessions/Tasks) when that
 *  anchor exists, otherwise wherever dockview puts a group-less panel. */
export function usePaneLauncher(apiRef: RefObject<DockviewApi | null>, paneReq: PaneReq): void {
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
  }, [paneReq, apiRef]);
}

/** Pin this browser tab to a window via the URL (`#w=<id>`). On mount a valid hash
 *  wins over the persisted active id — so duplicating the tab, bookmarking it, or
 *  opening the app in a second OS window next to the first lands on the window that
 *  tab was showing (side-by-side, Firefox-style). A stale hash (window since closed)
 *  is a no-op: switchWindow ignores unknown ids and the effect below re-stamps the
 *  hash with the window that actually shows. replaceState, not pushState — switching
 *  windows shouldn't grow the browser history. */
export function useWindowUrlPin(activeWindowId: string): void {
  useEffect(() => {
    const m = window.location.hash.match(/^#w=(.+)$/);
    if (m) useStore.getState().switchWindow(decodeURIComponent(m[1]));
  }, []);
  useEffect(() => {
    history.replaceState(null, "", `#w=${encodeURIComponent(activeWindowId)}`);
  }, [activeWindowId]);
}

/** Adopt window-list changes written by OTHER tabs. Same-origin tabs share the
 *  persisted pm-ui blob but zustand doesn't cross-sync live, so each write persists
 *  the writer's whole (possibly stale) window list — without this, a background tab
 *  would clobber the layout being edited here. On a storage event, merge: take the
 *  other tab's list, keep our copy of our active window (mergeExternalWindows). The
 *  merged write re-persists; convergence ends the ping-pong because a same-value
 *  setItem fires no storage event. A corrupt/foreign blob is ignored. */
export function useCrossTabWindows(): void {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "pm-ui" || !e.newValue) return;
      try {
        const incoming = (JSON.parse(e.newValue) as { state?: { windows?: unknown } })?.state
          ?.windows;
        if (!Array.isArray(incoming)) return;
        const s = useStore.getState();
        const merged = mergeExternalWindows(s.windows, incoming as PmWindow[], s.activeWindowId);
        if (JSON.stringify(merged) !== JSON.stringify(s.windows)) {
          useStore.setState({ windows: merged });
        }
      } catch {
        // never let another tab's bad write break this one
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}

/** Switching windows swaps the dock wholesale to the incoming window's layout. The
 *  `shownWindowRef` distinguishes a real switch from the initial mount (onReady
 *  already showed the first window) and from unrelated re-renders. The layout
 *  subscription stays live through the swap — the change events it fires just write
 *  the incoming window's own layout back to it. */
export function useWindowSwitch(
  apiRef: RefObject<DockviewApi | null>,
  shownWindowRef: RefObject<string | null>,
  activeWindowId: string,
  showWindow: (api: DockviewApi) => void,
): void {
  useEffect(() => {
    const api = apiRef.current;
    if (!api || shownWindowRef.current === activeWindowId) return;
    shownWindowRef.current = activeWindowId;
    showWindow(api);
  });
}

// The single pane of glass. The plan is split into two list panels — a SESSIONS
// monitor (every run of work, live + history) and a TASKS launchpad/record (every
// task, any status) — alongside the scratchpad and the supervisor shell. Done/archived
// is a status filter on each, not its own tab. Every panel renders off TanStack DB
// collections (collections.ts) that sync themselves live from PGlite over /sync —
// no store data, no poll, no refetch (see plan-data.ts).
//
// The dock layout is the *active window's* layout (store.windows, windows.ts) —
// each Window is a saved view (repo tabs + layout + local scratchpad), persisted
// per-device by the store's `persist` middleware so the disconnect→reload recovery
// (and any plain browser refresh) keeps your panes. App mirrors that state onto the
// dockview api: onReady restores the active window, switching windows swaps the
// dock wholesale, and onDidLayoutChange writes every change back via setLayout.

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
  // Which window the dock currently shows — lets the switch effect below tell a real
  // switch apart from the initial mount and from unrelated re-renders.
  const shownWindowRef = useRef<string | null>(null);
  const activeWindowId = useStore((s) => s.activeWindowId);
  const shellReq = useStore((s) => s.shellReq);
  const browserReq = useStore((s) => s.browserReq);
  const paneReq = useStore((s) => s.paneReq);
  const setLayout = useStore((s) => s.setLayout);
  const loadSettings = useStore((s) => s.loadSettings);

  // The plan/session data flows through the TanStack DB collections (each syncs
  // itself over /sync). The only server state not in a collection is the auto-rebase
  // toggle, so fetch that once on mount.
  useRunEffect(loadSettings);

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

  // Show a window on the dock: restore its saved layout, else lay out the default.
  // A corrupt/incompatible saved layout (or one that restores to nothing) falls back
  // to the default so a reload can never leave you staring at a blank dock. A layout
  // saved before a pane rename can still reference a component id we no longer
  // register (e.g. the old active/backlog panes) — applying that would render a
  // broken panel, so we discard it up front and rebuild the default. clear() first:
  // on a window *switch* the dock still holds the outgoing window's panels, and
  // buildDefaultLayout on a dirty dock would duplicate them (fromJSON replaces
  // wholesale, so the clear is only load-bearing on the fallback path).
  const showWindow = (api: DockviewApi) => {
    const s = useStore.getState();
    const saved = resolveActive(s.windows, s.activeWindowId)?.layout ?? null;
    let restored = false;
    if (saved && layoutIsCompatible(saved)) {
      try {
        api.fromJSON(saved);
        restored = api.panels.length > 0;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      api.clear();
      buildDefaultLayout(api);
    }
  };

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    shownWindowRef.current = useStore.getState().activeWindowId;
    showWindow(event.api);
    // Mirror every layout change back into the store — add/move/close a panel,
    // resize, focus a tab — so it persists into the active window and the next load
    // (notably the disconnect→reload) comes back as-is. Subscribed after the initial
    // build so restoring doesn't write over what we just restored.
    layoutSubRef.current = event.api.onDidLayoutChange(() => setLayout(event.api.toJSON()));
  };

  // Switching windows swaps the dock wholesale to the incoming window's layout.
  useWindowSwitch(apiRef, shownWindowRef, activeWindowId, showWindow);

  // Session restore across browser tabs: pin this tab to its window via the URL, and
  // merge window-list writes from other tabs instead of clobbering.
  useWindowUrlPin(activeWindowId);
  useCrossTabWindows();

  // Tear the layout subscription down with the component.
  useDisposeOnUnmount(layoutSubRef);

  // Store-request → dockview panel effects (add/focus a shell, browser, or pane).
  useShellPanels(apiRef, shellReq);
  useBrowserPanels(apiRef, browserReq);
  usePaneLauncher(apiRef, paneReq);

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
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <WindowRail />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <WindowTabs />
          <div className={skinClass} style={{ flex: 1, minHeight: 0 }}>
            <DockviewReact
              components={dockComponents}
              defaultTabComponent={ActivityTab}
              onReady={onReady}
              theme={editor.dockTheme}
            />
          </div>
        </div>
      </div>
      <ReviewOverlay />
    </div>
  );
}
