import type { SerializedDockview } from "dockview-react";

// The Window model (docs/windows.md, vocabulary.md § Window): a Window is a real
// native OS window — one per PM window, each owning its own repo "tabs" plus the
// dockview layout you look at them through. Firefox-style: usually unnamed and
// disposable, identified by its repo set, reopened on relaunch. Pure frontend state,
// persisted per-device (the store's localStorage persist) — never synced, never part
// of the plan hierarchy.
//
// The shared `windows` list is the *registry*: every currently-open PM window. Each
// webview renders exactly ONE of them, chosen by its `#w=<id>` URL hash — there is no
// in-app switcher. The registry is shared across every native window / browser tab on
// the origin (same localStorage), so the merge rule (mergeExternalWindows) keeps each
// webview authoritative for its own window while adopting the rest.
//
// This module is the pure core — window construction, list surgery, the boot planner,
// and the legacy single-layout migration, free of React and the store — so the
// semantics are unit-testable. The store holds the registry and delegates here.

/** Where a window last was in the (global) Scratch note: selection + scroll. The
 *  CONTENT is global and server-side — closing a window loses nothing — a window
 *  only remembers its own reading/writing position into it. */
export type ScratchCursor = { start: number; end: number; scroll: number };

export type PmWindow = {
  // Client-minted, stable across reloads — the persisted identity of the window.
  id: string;
  // Optional label; an unnamed window reads as its repo set, like a browser window.
  name: string | null;
  // The repo "tabs", ordered. The panes show the *union* of these repos (the tab
  // strip is the working set's composition, not a one-at-a-time focus). Empty =
  // unscoped: the window sees everything.
  repoIds: number[];
  // The dockview arrangement, exactly what api.toJSON() returns. Null until the
  // window has been shown once — the default layout is built on first show.
  layout: SerializedDockview | null;
  // This window's cursor into the global Scratch note; null = never opened it.
  scratchCursor: ScratchCursor | null;
};

export function newWindow(repoIds: number[] = []): PmWindow {
  return { id: crypto.randomUUID(), name: null, repoIds, layout: null, scratchCursor: null };
}

/** An empty window under a *specific* id. A webview learns which window it is from its
 *  `#w=<id>` hash; the full record should be in the shared registry, but when it isn't
 *  — a stale bookmark, a since-closed window, a raced cross-tab write — we stand up an
 *  empty (unscoped) window under that id so the webview still renders something. */
export function windowWithId(id: string): PmWindow {
  return { id, name: null, repoIds: [], layout: null, scratchCursor: null };
}

/** Boot planning for the *primary* webview — the one launched with no `#w=` hash (the
 *  Tauri boot window, or a fresh browser visit). It adopts the first registered window
 *  as its own, or mints a fresh one when the registry is empty. `spawn` is the rest of
 *  the registry: the windows a desktop relaunch reopens as their own OS windows (the
 *  primary webview fans them out; see window-bridge.ts). */
export function planBoot(registry: PmWindow[]): {
  adopt: PmWindow;
  spawn: PmWindow[];
  minted: boolean;
} {
  if (registry.length === 0) return { adopt: newWindow(), spawn: [], minted: true };
  return { adopt: registry[0], spawn: registry.slice(1), minted: false };
}

/** Patch one window in place (immutably); unknown ids are a no-op. */
export function updateWindow(
  list: PmWindow[],
  id: string,
  patch: Partial<Omit<PmWindow, "id">>,
): PmWindow[] {
  return list.map((w) => (w.id === id ? { ...w, ...patch } : w));
}

/** Drop a window from the registry. Real windows are Firefox-style disposable: a
 *  closed window is gone — no synthetic replacement, no focus handoff (there's no
 *  in-app active window to hand to; the OS window itself is closing). Closing the last
 *  window empties the registry; the app quits (Tauri) / the tab closes (browser), and
 *  the next launch mints a fresh window (planBoot). Unknown ids are a no-op. */
export function dropWindow(list: PmWindow[], id: string): PmWindow[] {
  return list.filter((w) => w.id !== id);
}

/** The active window, tolerating a stale id (persisted device state can drift —
 *  e.g. an interrupted close): fall back to the first window rather than nothing. */
export function resolveActive(list: PmWindow[], activeId: string): PmWindow | null {
  return list.find((w) => w.id === activeId) ?? list[0] ?? null;
}

/** Fold the pre-Windows persisted shape — one bare dock `layout` — into "window 1",
 *  so an existing device comes up exactly as it was, now inside a window. */
export function fromLegacyLayout(layout: SerializedDockview | null): PmWindow {
  return { ...newWindow(), layout };
}

/** Merge a pm-ui blob written by ANOTHER browser tab into this tab's window list.
 *  Same-origin tabs share the localStorage blob, and zustand persists the whole
 *  window list on every write — so without a merge, a background tab's write would
 *  clobber the layout being edited here with its stale copy. The rule: each tab is
 *  authoritative for the window it's SHOWING. Adopt the other tab's list (it may
 *  have created/closed/re-arranged windows or edited the ones it shows), but keep
 *  our copy of our active window — and resurrect it if the other tab closed it (a
 *  window being looked at can't be closed out from under the viewer). Two tabs on
 *  the SAME window stay last-write-wins, accepted. */
export function mergeExternalWindows(
  ours: PmWindow[],
  theirs: PmWindow[],
  activeId: string,
): PmWindow[] {
  const mine = ours.find((w) => w.id === activeId);
  if (!mine) return theirs;
  if (!theirs.some((w) => w.id === activeId)) return [...theirs, mine];
  return theirs.map((w) => (w.id === activeId ? mine : w));
}

/** What a rail entry / tab strip calls the window: its name if given, else the
 *  labels of its repo tabs (resolved by the caller from the repos collection),
 *  else a placeholder for a fresh unscoped window. */
export function windowLabel(w: PmWindow, repoLabel: (id: number) => string | undefined): string {
  if (w.name) return w.name;
  const labels = w.repoIds.map((id) => repoLabel(id)).filter((s): s is string => !!s);
  if (labels.length > 0) return labels.join(" · ");
  return "new window";
}
