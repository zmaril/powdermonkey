// Which entity the middle "work" pane is showing, as an Effect tagged enum, kept
// in sync with the browser URL so every view is deep-linkable and back/forward
// works. Chat lives permanently in the right pane, so it's not a view kind here.
//
//   None       -> /
//   Scratchpad -> /scratchpad
//   Workspace    -> /workspace/:id
//   Goal       -> /goal/:id
//   Task       -> /task/:id
import { Data } from "effect";
import { useEffect } from "react";
import { create } from "zustand";

export type View = Data.TaggedEnum<{
  None: {};
  Scratchpad: {};
  Workspaces: {};
  Workspace: { readonly id: string };
  Goal: { readonly id: string };
  Task: { readonly id: string };
}>;
export const View = Data.taggedEnum<View>();

// View -> URL path.
export function pathForView(v: View): string {
  return View.$match(v, {
    None: () => "/",
    Scratchpad: () => "/scratchpad",
    Workspaces: () => "/workspaces",
    Workspace: ({ id }) => `/workspace/${encodeURIComponent(id)}`,
    Goal: ({ id }) => `/goal/${encodeURIComponent(id)}`,
    Task: ({ id }) => `/task/${encodeURIComponent(id)}`,
  });
}

// URL path -> View (the inverse; unknown paths fall back to None).
export function viewFromPath(path: string): View {
  const m = path.match(/^\/(workspace|goal|task)\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[2]);
    if (m[1] === "workspace") return View.Workspace({ id });
    if (m[1] === "goal") return View.Goal({ id });
    return View.Task({ id });
  }
  if (path === "/scratchpad") return View.Scratchpad();
  if (path === "/workspaces") return View.Workspaces();
  return View.None();
}

const initialView = (): View =>
  typeof window !== "undefined" ? viewFromPath(window.location.pathname) : View.None();

interface ViewStore {
  view: View;
  setView: (v: View) => void;
  // Set from a browser navigation (popstate); updates state WITHOUT pushing a
  // new history entry, so back/forward don't pile up duplicates.
  syncFromUrl: (v: View) => void;
}

const pushPath = (view: View) => {
  if (typeof window !== "undefined") {
    const path = pathForView(view);
    if (path !== window.location.pathname) window.history.pushState(null, "", path);
  }
};

export const useView = create<ViewStore>((set) => ({
  view: initialView(),
  setView: (view) => {
    set({ view });
    pushPath(view);
  },
  syncFromUrl: (view) => set({ view }),
}));

// Mount once (in the app shell): reflect back/forward navigation into the store.
export function useViewUrlSync(): void {
  const syncFromUrl = useView((s) => s.syncFromUrl);
  useEffect(() => {
    const onPop = () => syncFromUrl(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [syncFromUrl]);
}
