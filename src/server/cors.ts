import { Elysia } from "elysia";

// Permissive CORS so a client served from a *different* origin can call the REST
// API: a packaged desktop client (a Tauri webview ships its own UI bundle and
// talks to a remote supervisor) or a plain browser pointed at this box over
// Tailscale. Same-origin use (the browser served by the supervisor itself) never
// triggers CORS, so this is inert for the existing localhost web path.
//
// `*` is deliberate. There is no auth and no cookies — access is gated at the
// network layer (Tailscale/SSH tunnel), per design.md's "single operator, no
// security model" — so reflecting any origin adds no exposure: anything that can
// reach the port could already curl it. The WebSocket routes (/pty, /sync) are
// exempt from CORS by the browser and need nothing here.
const HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export const cors = new Elysia({ name: "cors" }).onRequest(({ request, set }) => {
  Object.assign(set.headers, HEADERS);
  // Preflight: no route handles OPTIONS, so answer it here. Returning a Response
  // from onRequest short-circuits the rest of the lifecycle.
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
});
