import type { SerializedDockview } from "dockview-react";

// The Window model (docs/windows.md, vocabulary.md § Window): a Window is a saved
// *view* — a set of repo "tabs" plus the dockview layout you look at them through,
// plus a device-local scratchpad. Firefox-style: usually unnamed and disposable,
// identified by its repo set, session-restored on launch. Pure frontend state,
// persisted per-device (the store's localStorage persist) — never synced, never
// part of the plan hierarchy.
//
// This module is the pure core — window construction and list surgery, free of
// React and the store — so the semantics (never-empty list, focus handoff on
// close, the legacy single-layout migration) are unit-testable. The store holds
// the list and delegates here.

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
  // The per-window local scratchpad body. Device-local and disposable with the
  // window — the durable, supervisor-readable notepad is the server-side @notes.
  scratch: string;
};

export function newWindow(repoIds: number[] = []): PmWindow {
  return { id: crypto.randomUUID(), name: null, repoIds, layout: null, scratch: "" };
}

/** Patch one window in place (immutably); unknown ids are a no-op. */
export function updateWindow(
  list: PmWindow[],
  id: string,
  patch: Partial<Omit<PmWindow, "id">>,
): PmWindow[] {
  return list.map((w) => (w.id === id ? { ...w, ...patch } : w));
}

/** Close a window. The list is never left empty — closing the last window replaces
 *  it with a fresh unscoped one (there is always a view to stand in). When the
 *  closed window was active, focus moves to its right-hand neighbour (else the new
 *  last); closing a background window leaves the active one alone. */
export function closeWindow(
  list: PmWindow[],
  id: string,
  activeId: string,
): { windows: PmWindow[]; activeId: string } {
  const idx = list.findIndex((w) => w.id === id);
  if (idx === -1) return { windows: list, activeId };
  const rest = list.filter((w) => w.id !== id);
  if (rest.length === 0) {
    const fresh = newWindow();
    return { windows: [fresh], activeId: fresh.id };
  }
  const nextActive = id === activeId ? rest[Math.min(idx, rest.length - 1)].id : activeId;
  return { windows: rest, activeId: nextActive };
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

/** What a rail entry / tab strip calls the window: its name if given, else the
 *  labels of its repo tabs (resolved by the caller from the repos collection),
 *  else a placeholder for a fresh unscoped window. */
export function windowLabel(w: PmWindow, repoLabel: (id: number) => string | undefined): string {
  if (w.name) return w.name;
  const labels = w.repoIds.map((id) => repoLabel(id)).filter((s): s is string => !!s);
  if (labels.length > 0) return labels.join(" · ");
  return "new window";
}
