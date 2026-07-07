// Shared time formatting for the panes. One home for the "how long ago" math so
// every stamp in the UI reads the same way.

/** Compact relative time ("5m ago", "2d ago"). Accepts an ISO string or a Date
 *  (synced rows deliver timestamps as strings over JSON, server types say Date —
 *  both land here). Null on missing/bad input. */
export function timeAgo(at: string | Date | null): string | null {
  if (!at) return null;
  const then = new Date(at).getTime();
  if (Number.isNaN(then)) return null;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The exact wall-clock moment behind a relative stamp — what a hover reveals. */
export function exactTime(at: string | Date): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
