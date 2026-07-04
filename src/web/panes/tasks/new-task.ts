import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

// Shared state for the "a new task just landed" affordances in the Tasks pane.  Two concerns,
// kept apart on purpose:
//
//  • The *reveal queue* — task ids the operator just created from the "+ Add task" editor.
//    The create POST returns the new id; we queue it here so the Tasks pane can scroll
//    that card into view the moment it mounts (the card only appears once the insert
//    streams back over /sync). This is the ONE signal that marks a task as one YOU added
//    locally — the thing that earns an auto-scroll. A task that shows up from anywhere else
//    (a worker, an accepted proposal) never enters this queue, so it never yanks your
//    scroll.
//
// Module-level (a tiny zustand store) so the create action — deep inside MilestoneGroup —
// and the Tasks pane that does the scrolling can share it without threading props through
// the whole tree, mirroring how pane-scroll.ts keeps cross-cutting scroll state.

type RevealState = {
  // FIFO of locally-added task ids still waiting for their card to mount + scroll.
  queue: number[];
  // Queue a freshly-created task for auto-scroll. Idempotent — a re-request is a no-op.
  requestReveal: (taskId: number) => void;
  // Drop an id once its card has been found and scrolled (or it's no longer relevant).
  consumeReveal: (taskId: number) => void;
};

export const useReveal = create<RevealState>((set) => ({
  queue: [],
  requestReveal: (taskId) =>
    set((s) => (s.queue.includes(taskId) ? s : { queue: [...s.queue, taskId] })),
  consumeReveal: (taskId) =>
    set((s) => (s.queue.includes(taskId) ? { queue: s.queue.filter((id) => id !== taskId) } : s)),
}));

// ── Highlight context ────────────────────────────────────────────────────────
// The ids of cards currently glowing as "new, not yet seen". The Tasks pane owns the
// set (it adds new tasks and runs the IntersectionObserver that clears each once it's been
// on screen) and provides it here; every card reads its own membership to render the glow,
// so the highlight never has to be threaded as a prop down the goal/milestone/flat layers.
const HighlightContext = createContext<ReadonlySet<number>>(new Set());
export const HighlightProvider = HighlightContext.Provider;
export const useHighlighted = (taskId: number): boolean => useContext(HighlightContext).has(taskId);

// How long a new card must sit on screen before its glow clears — long enough to register
// as "seen" without lingering. Restarts if the card scrolls back off before it elapses.
const SEEN_DWELL_MS = 1100;

// Where a highlighted card sits relative to the scroll viewport — drives the off-screen
// indicator (an "above" card → a top arrow, a "below" card → a bottom arrow).
type Spot = "above" | "in" | "below";

export type NewTaskTracking = {
  highlighted: ReadonlySet<number>;
  // True when at least one still-glowing card is off-screen in that direction.
  hasAbove: boolean;
  hasBelow: boolean;
  // Scroll to the nearest off-screen new card in that direction.
  jumpAbove: () => void;
  jumpBelow: () => void;
};

/** Drive the Tasks pane's new-task affordances. Three jobs:
 *
 *   1. Detect new tasks off the synced collection (PHASE 871): diff the full live task-id
 *      set (`allIds`) against what we've already seen, and highlight any task that's newly
 *      appeared — wherever it came from (your "+ Add task", a worker, an accepted proposal).
 *      Detection alone never scrolls; that's the local/remote split — only a task YOU added
 *      (the reveal queue) yanks your scroll, so a task that arrives from elsewhere lights up
 *      and gets the indicator without moving you.
 *
 *   2. Auto-scroll locally-added tasks: drain the reveal queue, scrolling each queued card
 *      into view the moment it mounts. `idsKey` (a stable digest of the rendered task ids)
 *      is a retry trigger — the create POST returns the id before the insert reaches the
 *      collection, so the card usually isn't in the DOM on the first drain.
 *
 *   3. Highlight new cards until seen: a glowing ring stays on each new card until it has
 *      actually been on screen, cleared by an IntersectionObserver. `present` is the set of
 *      currently-rendered (backlog) task ids, used both to gate detection to cards that
 *      actually render and to drop a highlight whose card left the backlog (launched /
 *      removed) before it was ever seen.
 *
 *  Returns the live highlight set + off-screen-indicator state for the pane. */
export function useNewTaskReveal(
  scrollRef: RefObject<HTMLDivElement | null>,
  idsKey: string,
  allIds: Set<number>,
  present: Set<number>,
  revealCard: (taskId: number) => boolean,
): NewTaskTracking {
  const queue = useReveal((s) => s.queue);
  const consumeReveal = useReveal((s) => s.consumeReveal);
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(() => new Set());
  // Each highlighted card's spot relative to the viewport, kept current by the same
  // IntersectionObserver that clears the glow (it fires exactly on the in/out crossings the
  // indicator cares about). Stale entries for cleared highlights are simply ignored below.
  const [spots, setSpots] = useState<ReadonlyMap<number, Spot>>(() => new Map());

  // Read the live sets through refs so the id-keyed effects below can fire off idsKey (which
  // changes only when the rendered set does) instead of re-running on every render.
  const presentRef = useRef(present);
  presentRef.current = present;
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;

  // Detect new tasks off the synced collection. `seen` is null until the first non-empty
  // snapshot, so the existing backlog on load (or a freshly-POSTed plan) is adopted as
  // already-known and never lights up — only tasks that appear AFTER are "new".
  const seenRef = useRef<Set<number> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: allIds/present are read via refs; idsKey changing is exactly when the live task set changed.
  useEffect(() => {
    const all = allIdsRef.current;
    const seen = seenRef.current;
    if (seen === null) {
      if (all.size > 0) seenRef.current = new Set(all); // adopt the initial set as seen
      return;
    }
    const known = presentRef.current;
    const fresh: number[] = [];
    for (const id of all) if (!seen.has(id) && known.has(id)) fresh.push(id);
    seenRef.current = new Set(all);
    if (fresh.length === 0) return;
    setHighlighted((prev) => {
      let next = prev;
      for (const id of fresh)
        if (!next.has(id)) {
          if (next === prev) next = new Set(prev);
          next.add(id);
        }
      return next;
    });
  }, [idsKey]);

  // Drain the reveal queue: mark each locally-added task as highlighted (even one that's
  // already on screen still glows), then scroll it in and drop it from the queue once its
  // card exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a retry trigger, not read here — a queued reveal re-attempts the moment its card mounts (idsKey changes).
  useEffect(() => {
    if (queue.length === 0) return;
    setHighlighted((prev) => {
      let next = prev;
      for (const id of queue)
        if (!next.has(id)) {
          if (next === prev) next = new Set(prev);
          next.add(id);
        }
      return next;
    });
    for (const id of queue) if (revealCard(id)) consumeReveal(id);
  }, [queue, idsKey, revealCard, consumeReveal]);

  // Drop highlights whose card is no longer in the backlog (e.g. just launched), so a glow
  // that never got seen can't get stranded in the set forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: present is read via a ref; idsKey changing is exactly when the rendered set changed.
  useEffect(() => {
    setHighlighted((prev) => {
      let next = prev;
      for (const id of prev)
        if (!presentRef.current.has(id)) {
          if (next === prev) next = new Set(prev);
          next.delete(id);
        }
      return next;
    });
  }, [idsKey]);

  // Clear each highlight once its card has actually been on screen. The observer watches the
  // highlighted cards against the scroll viewport; an intersecting card starts a short dwell,
  // and if it's still on screen when the dwell elapses the glow clears. Scrolling it away
  // before then cancels the dwell so it restarts next time it enters.
  const highlightedKey = [...highlighted].sort((a, b) => a - b).join(",");
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: highlightedKey/idsKey capture the observable set + DOM; `highlighted` itself is read live and would only churn the observer.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || highlighted.size === 0) return;
    const liveTimers = timers.current;
    const cancel = (id: number) => {
      const t = liveTimers.get(id);
      if (t != null) {
        clearTimeout(t);
        liveTimers.delete(id);
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        const nextSpots = new Map<number, Spot>();
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.pmCard);
          if (!id) continue;
          // Classify above/in/below for the off-screen indicator.
          const root = e.rootBounds;
          nextSpots.set(
            id,
            e.isIntersecting
              ? "in"
              : root && e.boundingClientRect.top >= root.bottom
                ? "below"
                : "above",
          );
          if (e.isIntersecting) {
            if (!liveTimers.has(id))
              liveTimers.set(
                id,
                setTimeout(() => {
                  liveTimers.delete(id);
                  setHighlighted((prev) => {
                    if (!prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                }, SEEN_DWELL_MS),
              );
          } else {
            cancel(id);
          }
        }
        setSpots((prev) => {
          const merged = new Map(prev);
          for (const [id, spot] of nextSpots) merged.set(id, spot);
          return merged;
        });
      },
      { root: scroller, threshold: 0 },
    );
    for (const id of highlighted) {
      const node = scroller.querySelector<HTMLElement>(`[data-pm-card="${id}"]`);
      if (node) io.observe(node);
    }
    return () => {
      io.disconnect();
      for (const t of liveTimers.values()) clearTimeout(t);
      liveTimers.clear();
    };
  }, [highlightedKey, idsKey, scrollRef]);

  // The indicator only counts cards still glowing (a spot for a since-cleared highlight is
  // stale). Scanning the highlighted set keeps it honest without pruning the spots map.
  let hasAbove = false;
  let hasBelow = false;
  for (const id of highlighted) {
    const spot = spots.get(id);
    if (spot === "above") hasAbove = true;
    else if (spot === "below") hasBelow = true;
  }

  // Jump to the nearest off-screen new card in a direction. Measured against the live
  // viewport at click time (via getBoundingClientRect) rather than the observer's
  // last-known spots, so it lands on the closest one even after intervening scrolls.
  const jump = useCallback(
    (dir: "up" | "down") => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const sRect = scroller.getBoundingClientRect();
      let bestId: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const id of highlighted) {
        const node = scroller.querySelector<HTMLElement>(`[data-pm-card="${id}"]`);
        if (!node) continue;
        const r = node.getBoundingClientRect();
        const dist =
          dir === "up"
            ? sRect.top - r.bottom // card fully above the top edge
            : r.top - sRect.bottom; // card fully below the bottom edge
        if (dist > 0 && dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (bestId != null) revealCard(bestId);
    },
    [highlighted, revealCard, scrollRef],
  );

  const jumpAbove = useCallback(() => jump("up"), [jump]);
  const jumpBelow = useCallback(() => jump("down"), [jump]);

  return { highlighted, hasAbove, hasBelow, jumpAbove, jumpBelow };
}
