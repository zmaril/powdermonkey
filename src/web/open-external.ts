import { openUrl } from "@tauri-apps/plugin-opener";
import { isDesktop } from "./server.ts";

// Open a URL outside the app. In a browser this is just a new tab; in the Tauri
// desktop shell a plain `window.open` would load the page inside the app's own
// webview (there is no browser to hand it to), so we route through the opener
// plugin, which asks the OS to open it in the system default browser.
//
// Fire-and-forget: callers are click handlers (xterm link handler, Anchor
// onClick) that don't await anything. The desktop path is async (the plugin
// invoke returns a promise); if it ever rejects we fall back to `window.open`
// so the link still does *something* rather than silently dying.
export function openExternal(url: string): void {
  if (isDesktop()) {
    openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
