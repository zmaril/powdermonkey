// Normalize what the operator types in the Browser pane's URL bar into something an
// iframe can load. The common case is a bare dev-server address — `localhost:3000`,
// `127.0.0.1:5173/preview` — so a value with no scheme gets `http://` (not https,
// since local dev servers rarely have TLS). An explicit scheme is left untouched.
// Empty / whitespace-only input normalizes to "" (nothing to load).
//
// Scheme detection requires `://` on purpose: a bare `localhost:3000` is a host:port,
// not a `localhost`-scheme URL, so the `:` alone mustn't count as a scheme.
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}
