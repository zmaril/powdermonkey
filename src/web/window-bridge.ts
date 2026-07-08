import { withPickParam } from "./new-window.ts";
import { useStore } from "./store.ts";
import { type PmWindow, planBoot, windowWithId } from "./windows.ts";

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
 *  both as a browser `window.open` target and as a Tauri WebviewWindow url. `pick`
 *  stamps the `?pick=1` boot flag, so the arriving webview opens the repo picker
 *  scoped to its window (new-window.ts). */
export function windowUrl(id: string, opts: { pick?: boolean } = {}): string {
  const search = opts.pick ? withPickParam(window.location.search) : window.location.search;
  return `${window.location.pathname}${search}#w=${encodeURIComponent(id)}`;
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
export async function spawnWindow(id: string, opts: { pick?: boolean } = {}): Promise<void> {
  if (isDesktop()) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = new WebviewWindow(windowLabel(id), {
      url: windowUrl(id, opts),
      title: "PowderMonkey",
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
    });
    // A native window can fail to open (bad URL, OS refusal); surface it instead of
    // silently discarding the handle.
    win.once("tauri://error", (e) => console.error(`window ${id} failed to spawn`, e.payload));
  } else {
    // A new browser window (not a background tab) — the desktop-window analog. Popup
    // blockers allow this because it's a direct response to the user's click/shortcut.
    window.open(windowUrl(id, opts), "_blank");
  }
}

/** Open a brand-new window: mint a fresh unscoped PM window, register it in the shared
 *  store, then spawn its OS window with the picker boot flag — the new window opens
 *  onto the Blender-style picker, scoped to itself, so it starts by choosing its repos
 *  (vocabulary.md § Window; skip/close it and the window is simply unscoped). This
 *  webview keeps showing its own window; the new scope lives in the new OS window.
 *  Wired to `Cmd/Ctrl-N` and the "New window" button. */
export async function openNewWindow(): Promise<void> {
  const id = useStore.getState().createWindow();
  await spawnWindow(id, { pick: true });
}

/** Close THIS window: on the desktop, ask Tauri to close the OS window (which fires
 *  onCloseRequested → the registry cleanup registered in initDesktopWindow, so a
 *  closed window isn't reopened next launch); in the browser, drop it from the registry
 *  and close the tab. Wired to `Cmd/Ctrl-W` (desktop) and the native close button. */
export async function closeCurrentWindow(): Promise<void> {
  if (isDesktop()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } else {
    useStore.getState().removeWindow(useStore.getState().activeWindowId);
    // Only script-opened windows can be closed by script; the primary tab won't, and
    // that's fine — its native Cmd-W closes it, and browser session-restore reopens it.
    window.close();
  }
}

/** Bind THIS webview to its PM window, synchronously, before React mounts (so the dock
 *  restores the right layout on its first `onReady`). If the URL carries `#w=<id>`,
 *  that window is this webview's; otherwise this is the *primary* boot webview, which
 *  adopts the first registered window (or mints one) and — on the desktop — reopens the
 *  rest of the set. Either way we stamp the hash so the reconnect→reload recovery comes
 *  back on the same window.
 *
 *  The store's `windows` registry has already rehydrated from localStorage at this
 *  point (zustand `persist` is synchronous for localStorage), so the lookup sees the
 *  real registry — shared across every native window / browser tab on the origin. */
export function bootWindow(): void {
  const s = useStore.getState();
  const hashId = hashWindowId();
  // A hash means this webview was told which window it is (spawned / reopened /
  // bookmarked) — show that one, and nothing to fan out. No hash means the primary
  // boot webview — adopt the first registered window (or mint one) and reopen the rest.
  const { win, spawn } = hashId
    ? { win: s.windows.find((w) => w.id === hashId) ?? windowWithId(hashId), spawn: [] }
    : ((p) => ({ win: p.adopt, spawn: p.spawn }))(planBoot(s.windows));
  s.adoptWindow(win);
  history.replaceState(null, "", windowUrl(win.id));
  // The desktop side (register the close→cleanup hook, and fan the rest of the set
  // back out on a primary relaunch) is async; fire and forget after the sync bind.
  if (isDesktop()) void initDesktopWindow(spawn);
}

/** Desktop-only window wiring, run once per webview after bootWindow's sync bind:
 *  1. Drop this window from the registry when it's genuinely closed (the native close
 *     button OR Cmd/Ctrl-W). Tauri's onCloseRequested fires on close, not on reload,
 *     so a reload keeps the window and a real close disposes it — Firefox-style.
 *  2. On the primary boot webview (no `#w=` hash), reopen the rest of the registry as
 *     their own OS windows, so relaunch restores the whole set you had open. A window
 *     spawned here boots WITH a hash, so it never fans out again — no recursion. */
async function initDesktopWindow(spawn: PmWindow[]): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().onCloseRequested(() => {
    useStore.getState().removeWindow(useStore.getState().activeWindowId);
  });
  for (const w of spawn) await spawnWindow(w.id);
}
