import { type RefObject, useEffect, useRef, useState } from "react";

// Incremental windowing for a long flat list. The Sessions and Tasks panes can hold a
// lot of history (every landed/stopped session, every done/archived task), and rendering
// thousands of cards at once is what makes a pane janky — not the data, which is already
// fully live-synced through the TanStack DB collections. So we render only the first
// `limit` rows and grow the window by `step` whenever a sentinel near the bottom scrolls
// into view (an IntersectionObserver, rooted on the pane's scroll container). The full
// list stays in memory and live — windowing only bounds the DOM — so a delta that lands
// off-screen still updates the moment it scrolls into the window.
//
// `resetKey` snaps the window back to the first page when the list identity changes
// (a new filter, a flat/grouped switch), so narrowing the filter doesn't leave you
// scrolled into a now-short list.

export function useWindow(
  total: number,
  resetKey: unknown,
  rootRef?: RefObject<HTMLElement | null>,
  step = 50,
): { limit: number; hasMore: boolean; sentinelRef: RefObject<HTMLDivElement | null> } {
  const [limit, setLimit] = useState(step);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Back to the first page whenever the list identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger to snap back
  useEffect(() => setLimit(step), [resetKey, step]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => (l < total ? l + step : l));
      },
      // Root on the scroll container so it fires inside the pane; the margin prefetches
      // the next page before you hit the very bottom.
      { root: rootRef?.current ?? null, rootMargin: "400px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [total, step, rootRef]);

  const capped = Math.min(limit, total);
  return { limit: capped, hasMore: capped < total, sentinelRef: sentinel };
}
