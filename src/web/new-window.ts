import { useEffect } from "react";
import { useStore } from "./store.ts";

// The `?pick=1` boot flag: an app URL carrying it comes up with the Blender-style
// repo picker open, then strips the flag from the address bar (preserving the
// `#w=<id>` window hash) so a reload doesn't re-trigger it. This is how a window
// can be spawned *onto* the picker (vocabulary.md § Window: a new window opens
// with the picker), and doubles as a plain deep-link into "add repos".
//
// The new-window chord itself is NOT here: Cmd/Ctrl-N is the platform layer's
// (window-bridge.ts, wired in App's useWindowKeybindings) — it spawns the real
// OS window; this module only handles what the spawned webview does on arrival.

/** The boot flag: present → open the picker on launch. */
export const PICK_PARAM = "pick";

/** Strip the boot flag from `search` (for history.replaceState after consuming
 *  it). Returns the new search string, "" when nothing else remains. */
export function stripPickParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(PICK_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Consume a `?pick=1` boot: open the picker once on mount and clean the URL. */
export function usePickerBootParam(): void {
  const openRepoPicker = useStore((s) => s.openRepoPicker);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get(PICK_PARAM) == null) return;
    openRepoPicker();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${stripPickParam(window.location.search)}${window.location.hash}`,
    );
  }, [openRepoPicker]);
}
