import { useStore } from "./store.ts";
import { planBoot, windowWithId } from "./windows.ts";

// The platform layer for real native windows (docs/windows.md). Each PM window is a
// real OS window: on the desktop a Tauri v2 WebviewWindow, in the browser a separate
// window/tab. This module is the ONLY place that touches the platform — the store
// stays pure state and App just wires the keybindings to these calls. `@tauri-apps/api`
// is imported *dynamically*, and only when isDesktop(), so the browser bundle never
// loads it and a plain web build never touches Tauri.

/** True when running inside the Tauri desktop shell — v2 injects
 *  `__TAURI_INTERNALS__` onto the webview's window. The browser fallback path keys
 *  off the negative. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** This webview's PM window id, read from the `#w=<id>` URL hash. Null when the hash
 *  is absent — the primary boot webview, which adopts/mints a window instead of
 *  being told which one it is. */
export function hashWindowId(): string | null {
  const m = window.location.hash.match(/^#w=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** The app URL for a given window id: this same document with a `#w=<id>` hash. Used
 *  both as a browser `window.open` target and as a Tauri WebviewWindow url. */
export function windowUrl(id: string): string {
  return `${window.location.pathname}${window.location.search}#w=${encodeURIComponent(id)}`;
}

/** A Tauri window label for a PM window id. Labels must be unique per app and match
 *  Tauri's charset (`[a-zA-Z0-9-/:_]`); our ids are UUIDs (hex + dashes), so a `pm-`
 *  prefix is a legal, collision-free label. */
export function windowLabel(id: string): string {
  return `pm-${id}`;
}

/** Spawn a real native window showing PM window `id`. Desktop → a Tauri WebviewWindow
 *  (its own OS window + webview); browser → `window.open` (a separate OS window that
 *  carries the scope in its `#w=<id>` hash). The caller registers the window in the
 *  shared store *first*, so the new webview finds itself in the registry on boot. */
export async function spawnWindow(id: string): Promise<void> {
  if (isDesktop()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(windowLabel(id), {
      url: windowUrl(id),
      title: "PowderMonkey",
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
    });
  } else {
    // A new browser window (not a background tab) — the desktop-window analog. Popup
    // blockers allow this because it's a direct response to the user's click/shortcut.
    window.open(windowUrl(id), "_blank");
  }
}

/** Open a brand-new window: mint a fresh unscoped PM window, register it in the shared
 *  store, then spawn its OS window. New windows always open unscoped — you scope them
 *  afterward from the repo tab strip. This webview keeps showing its own window; the
 *  new scope lives in the new OS window. Wired to `Cmd/Ctrl-N` and the "New window"
 *  button. */
export async function openNewWindow(): Promise<void> {
  const id = useStore.getState().createWindow();
  await spawnWindow(id);
}

/** Bind THIS webview to its PM window, synchronously, before React mounts (so the dock
 *  restores the right layout on its first `onReady`). If the URL carries `#w=<id>`,
 *  that window is this webview's; otherwise this is the primary boot webview, which
 *  adopts the first registered window (or mints one). Either way we stamp the hash so
 *  the reconnect→reload recovery comes back on the same window.
 *
 *  The store's `windows` registry has already rehydrated from localStorage at this
 *  point (zustand `persist` is synchronous for localStorage), so the lookup sees the
 *  real registry — shared across every native window / browser tab on the origin. */
export function bootWindow(): void {
  const s = useStore.getState();
  const hashId = hashWindowId();
  const win = hashId
    ? (s.windows.find((w) => w.id === hashId) ?? windowWithId(hashId))
    : planBoot(s.windows).adopt;
  s.adoptWindow(win);
  history.replaceState(null, "", windowUrl(win.id));
}
