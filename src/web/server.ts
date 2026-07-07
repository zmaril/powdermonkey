// Which PowderMonkey supervisor this client talks to.
//
// The web bundle the supervisor serves to itself is *same-origin*: the base is
// empty and every helper falls back to window.location, so the existing
// browser-at-localhost path is unchanged. A packaged desktop client (a Tauri
// webview) loads this same bundle from its own asset origin and has no server of
// its own, so it sets a base here — the URL of whichever supervisor the operator
// picked. Cross-origin calls are covered by the server's permissive CORS (the
// supervisor sits behind Tailscale/SSH; there is no auth — see src/server/cors.ts).
//
// A base is a full, scheme-qualified origin: "http://pm.my-tailnet.ts.net:4500".
// The scheme is load-bearing — Eden's treaty prepends https:// to any bare host
// that isn't localhost, which would break a plain-http Tailscale server — so we
// always carry and validate the scheme.
//
// Read synchronously from localStorage (not the zustand store): client.ts builds
// the Eden treaty at module load and collections.ts opens its sync sockets on
// first import, both before React mounts, so the base must be available eagerly.

const KEY = "pm-server-base";

// The conventional local supervisor address (README default, matches PM_URL). Used as
// the desktop shell's default, since it has no same-origin server of its own.
const DESKTOP_DEFAULT = "http://localhost:4500";

let cached: string | null = null;

/** True when this bundle is running inside the Tauri desktop shell rather than a
 *  browser. The webview loads from Tauri's own asset origin — `tauri://localhost` on
 *  macOS/iOS, `http://tauri.localhost` on Windows/Linux — none of which serves a
 *  supervisor, and Tauri always injects `__TAURI_INTERNALS__`. */
export function isDesktop(): boolean {
  try {
    return (
      window.location.protocol === "tauri:" ||
      window.location.hostname === "tauri.localhost" ||
      "__TAURI_INTERNALS__" in window
    );
  } catch {
    return false;
  }
}

/** The origin used when no explicit server is configured. In a browser that's the
 *  supervisor that served the bundle (same origin); in the desktop shell there is no
 *  such server (the origin is `tauri://…`), so fall back to the local supervisor. */
export function defaultOrigin(): string {
  return isDesktop() ? DESKTOP_DEFAULT : window.location.origin;
}

/** The configured base origin, or "" for same-origin (the supervisor serving us). */
export function getServerBase(): string {
  if (cached != null) return cached;
  try {
    cached = window.localStorage.getItem(KEY) ?? "";
  } catch {
    cached = "";
  }
  return cached;
}

/** Normalize a user-entered server URL to a bare origin, or null if unusable.
 *  Adds http:// when no scheme is given (Tailscale/LAN servers are plain http),
 *  and strips any path/trailing slash so it's a clean origin. */
export function normalizeServerBase(input: string): string | null {
  const raw = input.trim();
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.origin;
  } catch {
    return null;
  }
}

/** Set (or clear, with "") the active server and persist it. Caller reloads so the
 *  module-level singletons (treaty, sync sockets) rebuild against the new base. */
export function setServerBase(base: string): void {
  cached = base;
  try {
    if (base) window.localStorage.setItem(KEY, base);
    else window.localStorage.removeItem(KEY);
  } catch {}
}

/** The HTTP origin for REST calls — full scheme-qualified URL, fed to Eden's
 *  treaty and to bare fetch()es. Falls back to defaultOrigin() (same origin in a
 *  browser, the local supervisor in the desktop shell) when unset. */
export function httpOrigin(): string {
  return getServerBase() || defaultOrigin();
}

/** Absolute URL for a server path (e.g. "/upload", "/health") for fetch(). */
export function apiUrl(path: string): string {
  return `${httpOrigin()}${path}`;
}

/** ws:// or wss:// URL for a server path (e.g. "/pty?session=1"), scheme derived
 *  from the active origin's scheme (http→ws, https→wss). */
export function wsUrl(path: string): string {
  const u = new URL(httpOrigin());
  const proto = u.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${u.host}${path}`;
}

/** True when pointed at a remote supervisor (not the one serving this bundle). */
export function isRemote(): boolean {
  return getServerBase() !== "";
}

// ── Saved servers ──────────────────────────────────────────────────────────────
// A named list the operator builds up (their laptop, a cloud box, …) so a desktop
// client can switch between supervisors without retyping URLs. Not perf-critical —
// only the *active* base must be read eagerly — so plain localStorage JSON is fine.

const LIST_KEY = "pm-servers";

export type SavedServer = { name: string; url: string };

export function getSavedServers(): SavedServer[] {
  try {
    const raw = window.localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((s) => s && typeof s.name === "string" && typeof s.url === "string");
  } catch {
    return [];
  }
}

export function setSavedServers(list: SavedServer[]): void {
  try {
    window.localStorage.setItem(LIST_KEY, JSON.stringify(list));
  } catch {}
}

/** Ping a server's /health to confirm it's reachable before switching to it. */
export async function probeServer(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
