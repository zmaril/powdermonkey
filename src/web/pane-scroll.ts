import type { DockviewPanelApi } from "dockview-react";
import {
  type RefObject,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

// Per-pane scroll offsets, persisted so coming back lands where you were instead of
// the top — both across a refresh (including the disconnect→reload recovery, which
// is a full window.location.reload) and across a pane/tab switch. Kept in its own
// localStorage key, not the zustand layout blob, so a scroll burst never re-serializes
// the (large) dock layout on every frame. Mirrors the direct-localStorage style the
// review pane already uses for its viewed-files set.
const KEY = "pm-pane-scroll";

// In-memory mirror of the persisted map. Scroll fires far faster than we need to
// touch disk, so reads/writes go through here and a coalesced flush lands it in
// localStorage. Loaded lazily, once.
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function flush(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? {}));
  } catch {}
}

function getScroll(paneId: string): number {
  return load()[paneId] ?? 0;
}

function setScroll(paneId: string, top: number): void {
  load()[paneId] = top;
  // Coalesce: persist at most once every 250ms during a scroll burst.
  if (flushTimer == null) flushTimer = setTimeout(flush, 250);
}

/** Record a pane's scroll offset from outside the hook (e.g. a reveal that positions the
 *  pane on a specific entity), so a later tab-away/return restores to it. */
export function setPaneScroll(paneId: string, top: number): void {
  setScroll(paneId, top);
}

// Panes currently being positioned by a reveal (reveal.ts). While a pane is in this set
// its saved-offset restore yields — otherwise a reveal that focuses a hidden pane would
// fight the restore, which forces the pane back to its old offset for up to ~1.5s.
const revealing = new Set<string>();

export function beginReveal(paneId: string): void {
  revealing.add(paneId);
}

export function endReveal(paneId: string): void {
  revealing.delete(paneId);
}

// A reload kicked off from JS (the disconnect→reload recovery) or a plain refresh
// can fire before a pending coalesced flush — write through synchronously as the
// page goes away so the last scroll position is never lost.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

// Wire a pane's scroll container: persist its offset as you scroll, and restore the
// saved offset on first mount (refresh) and — when an `api` is supplied — whenever
// dockview re-shows the pane (a tab switch under the default 'onlyWhenVisible'
// renderer detaches the pane's DOM, resetting scrollTop, while keeping the React
// component mounted, so mount alone never fires again).
export function usePaneScroll(
  paneId: string,
  api?: DockviewPanelApi,
): { ref: RefObject<HTMLDivElement | null>; onScroll: (e: UIEvent<HTMLElement>) => void } {
  const ref = useRef<HTMLDivElement | null>(null);
  // false while a restore is in flight, so our own scrollTop writes aren't mistaken
  // for the operator scrolling and don't overwrite the saved offset.
  const saving = useRef(false);
  const rafRef = useRef(0);

  const restore = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const el = ref.current;
    if (!el) return;
    // A reveal is positioning this pane — don't fight it by re-applying the old offset.
    // Re-enable persistence so the operator's subsequent scrolling still saves.
    if (revealing.has(paneId)) {
      saving.current = true;
      return;
    }
    saving.current = false;
    const target = getScroll(paneId);
    if (target <= 0) {
      saving.current = true;
      return;
    }
    // Live-synced content streams in and entrance animations settle over the first
    // frames after a refresh, so the pane's height keeps changing — and a saved
    // offset re-applied onto a transient, mid-load layout locks onto the wrong
    // content (and scroll-anchoring then re-persists that drifted value). So hold the
    // offset each frame until the content height has stopped changing (and we've
    // actually reached it) before trusting the position and re-enabling persistence.
    // A short cap bounds the wait so we never fight the operator on now-shorter content.
    const startedAt = performance.now();
    let lastHeight = -1;
    let stableFrames = 0;
    const tick = () => {
      const node = ref.current;
      if (!node) return;
      node.scrollTop = target;
      if (node.scrollHeight === lastHeight) stableFrames++;
      else {
        stableFrames = 0;
        lastHeight = node.scrollHeight;
      }
      const settled = Math.abs(node.scrollTop - target) <= 1 && stableFrames >= 3;
      if (settled || performance.now() - startedAt > 1500) {
        node.scrollTop = target;
        saving.current = true;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick(); // first pass synchronous → no flash when the content is already tall enough
  }, [paneId]);

  // Refresh / fresh open: restore once the element is in the DOM.
  useLayoutEffect(() => {
    restore();
    return () => cancelAnimationFrame(rafRef.current);
  }, [restore]);

  // Tab switch: restore each time dockview re-shows the pane; flush as it hides so
  // the offset is on disk before the DOM detaches.
  useEffect(() => {
    if (!api) return;
    const sub = api.onDidVisibilityChange((e) => {
      if (e.isVisible) restore();
      else flush();
    });
    return () => sub.dispose();
  }, [api, restore]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLElement>) => {
      if (!saving.current) return;
      setScroll(paneId, e.currentTarget.scrollTop);
    },
    [paneId],
  );

  return { ref, onScroll };
}
