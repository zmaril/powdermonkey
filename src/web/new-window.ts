import { useEffect } from "react";
import { useStore } from "./store.ts";

// The `?pick=1` boot flag: a webview booted with it comes up with the Blender-style
// repo picker open, SCOPED to its own window — the repos picked become that
// window's tabs. This is how "a new window opens with the picker"
// (vocabulary.md § Window) works in the native-window model: openNewWindow
// (window-bridge.ts) spawns the fresh OS window with the flag on its URL, and the
// arriving webview consumes it here, stripping it from the address bar (the
// `#w=<id>` hash survives) so a reload doesn't re-trigger it.
//
// The new-window chord itself is NOT here: Cmd/Ctrl-N is the platform layer's
// (window-bridge.ts, wired in App's useWindowKeybindings) — it spawns the real
// OS window; this module only handles what the spawned webview does on arrival.

/** The boot flag: present → open the picker on launch. */
export const PICK_PARAM = "pick";

/** Add the boot flag to a search string (for a spawn URL). Pure. */
export function withPickParam(search: string): string {
  const params = new URLSearchParams(search);
  params.set(PICK_PARAM, "1");
  return `?${params.toString()}`;
}

/** Strip the boot flag from `search` (for history.replaceState after consuming
 *  it). Returns the new search string, "" when nothing else remains. */
export function stripPickParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PICK_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Consume a `?pick=1` boot: open the picker once on mount — scoped to this
 *  webview's window, so the picks land as its tabs — and clean the URL. */
export function usePickerBootParam(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(PICK_PARAM) == null) return;
    const s = useStore.getState();
    s.openRepoPicker(s.activeWindowId);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${stripPickParam(window.location.search)}${window.location.hash}`,
    );
  }, []);
}
