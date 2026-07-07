import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// The shared engine behind BOTH "a new thing just landed" reveals — new tasks (new-task.ts)
// and new proposals (new-proposal.ts). The two differ only in what they key on (a task-card
// id vs a proposal id) and which DOM handle carries it (`data-pm-card` vs `data-pm-proposal`);
// the mechanics — a seen-set diff off the synced collection, a glow that clears once the
// element has dwelt on screen, and an off-screen jump indicator — are identical, so they live
// here once. Each reveal wraps these with its own ids, attribute, and any extra behavior
// (new-task adds a locally-added auto-scroll queue on top; proposals need none).

/** Where a highlighted element sits relative to the scroll viewport — drives the off-screen
 *  indicator (an "above" element → a top arrow, a "below" element → a bottom arrow). */
export type Spot = "above" | "in" | "below";

/** `prev` with `ids` folded in, allocating a new Set only when something was actually added
 *  (else `prev` unchanged, so a no-op setState skips the re-render). Shared by every path
 *  that lights ids up — the seen-set diff here and new-task's locally-added reveal queue. */
export function addHighlights(
  prev: ReadonlySet<number>,
  ids: Iterable<number>,
): ReadonlySet<number> {
  let next: Set<number> | null = null;
  for (const id of ids)
    if (!prev.has(id)) {
      next ??= new Set(prev);
      next.add(id);
    }
  return next ?? prev;
}

/** Detect newly-arrived ids off the synced collection, and prune stale highlights.
 *
 *   • `allIds` — the full live id set (every task / every pending proposal).
 *   • `present` — the subset that renders an element right now; detection gates to these
 *     (only a rendered thing can glow) and a highlight is pruned once its id leaves.
 *   • `idsKey` — a stable digest of `present`; it changes exactly when the rendered set
 *     does, which is when the diff and the prune re-run.
 *   • `ready` — true once the backing collection has delivered its first snapshot. The set
 *     is adopted as seen the moment EITHER it's non-empty OR `ready` is true, so a surface
 *     that loads empty (the common case for proposals — no pending ones on load) still seeds
 *     an empty seen-set and lights up the FIRST arrival, instead of swallowing it as the
 *     initial set. A surface that always loads populated (tasks) can leave `ready` false and
 *     seed on the first non-empty snapshot, unchanged.
 *
 *  Until seeded, `seen` is null; the set present at seed time is adopted as already-known and
 *  never lights up — only ids that appear AFTER are "new". Returns the live highlight set +
 *  its setter, which the caller's observer clears through. */
export function useSeenHighlight(
  idsKey: string,
  allIds: Set<number>,
  present: Set<number>,
  ready = false,
): [ReadonlySet<number>, Dispatch<SetStateAction<ReadonlySet<number>>>] {
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(() => new Set());

  // Read the live sets through refs so the id-keyed effects fire off idsKey (which changes
  // only when the rendered set does) instead of re-running on every render.
  const presentRef = useRef(present);
  presentRef.current = present;
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;

  const seenRef = useRef<Set<number> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: allIds/present are read via refs; idsKey (or ready flipping) is exactly when the rendered set changed or the collection loaded.
  useEffect(() => {
    const all = allIdsRef.current;
    const seen = seenRef.current;
    if (seen === null) {
      // Seed the moment the set is non-empty OR the collection is ready — so an empty-on-load
      // surface still adopts an empty seen-set and lights up its first arrival.
      if (all.size > 0 || ready) seenRef.current = new Set(all);
      return;
    }
    const known = presentRef.current;
    const fresh: number[] = [];
    for (const id of all) if (!seen.has(id) && known.has(id)) fresh.push(id);
    seenRef.current = new Set(all);
    if (fresh.length === 0) return;
    setHighlighted((prev) => addHighlights(prev, fresh));
  }, [idsKey, ready]);

  // Drop highlights whose element is no longer present (launched / accepted / rejected /
  // filtered away) before it was ever seen, so a glow can't get stranded in the set forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: present is read via a ref; idsKey changing is exactly when the rendered set changed.
  useEffect(() => {
    setHighlighted((prev) => {
      let next: Set<number> | null = null;
      for (const id of prev)
        if (!presentRef.current.has(id)) {
          next ??= new Set(prev);
          next.delete(id);
        }
      return next ?? prev;
    });
  }, [idsKey]);

  return [highlighted, setHighlighted];
}

// How long a highlighted element must sit on screen before its glow clears — long enough to
// register as "seen" without lingering. Restarts if it scrolls back off before it elapses.
const SEEN_DWELL_MS = 1100;

/** Clear each highlight once its element has actually been on screen, and track where the
 *  still-glowing off-screen ones sit (for the jump indicator). `attr` is the data attribute
 *  that carries the id (`data-pm-card` / `data-pm-proposal`); an id's representative element
 *  is the first `[attr="<id>"]` under the scroller. An intersecting element starts a short
 *  dwell and clears the glow if still on screen when it elapses; scrolling it off cancels the
 *  dwell so it restarts on re-entry. Returns each highlighted id's above/in/below spot. */
export function useSeenObserver(
  scrollRef: RefObject<HTMLElement | null>,
  attr: string,
  highlighted: ReadonlySet<number>,
  setHighlighted: Dispatch<SetStateAction<ReadonlySet<number>>>,
  idsKey: string,
): ReadonlyMap<number, Spot> {
  const [spots, setSpots] = useState<ReadonlyMap<number, Spot>>(() => new Map());
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
          const id = Number((e.target as HTMLElement).getAttribute(attr));
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
      const node = scroller.querySelector<HTMLElement>(`[${attr}="${id}"]`);
      if (node) io.observe(node);
    }
    return () => {
      io.disconnect();
      for (const t of liveTimers.values()) clearTimeout(t);
      liveTimers.clear();
    };
  }, [highlightedKey, idsKey, scrollRef, attr, setHighlighted]);

  return spots;
}

/** The off-screen indicator state + jump handlers for a highlight set. `hasAbove`/`hasBelow`
 *  count only ids STILL glowing (a spot for a since-cleared highlight is stale), so the
 *  arrows appear exactly while a new element sits off-screen that way. `jumpAbove`/`jumpBelow`
 *  scroll to the nearest such element, measured against the live viewport at click time (not
 *  the observer's last-known spots) so they land on the closest one even after intervening
 *  scrolls. `reveal(id)` performs the actual scroll (each caller re-anchors after it). */
export function useOffscreenJump(
  scrollRef: RefObject<HTMLElement | null>,
  attr: string,
  highlighted: ReadonlySet<number>,
  spots: ReadonlyMap<number, Spot>,
  reveal: (id: number) => boolean,
): { hasAbove: boolean; hasBelow: boolean; jumpAbove: () => void; jumpBelow: () => void } {
  let hasAbove = false;
  let hasBelow = false;
  for (const id of highlighted) {
    const spot = spots.get(id);
    if (spot === "above") hasAbove = true;
    else if (spot === "below") hasBelow = true;
  }

  const jump = useCallback(
    (dir: "up" | "down") => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const sRect = scroller.getBoundingClientRect();
      let bestId: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const id of highlighted) {
        const node = scroller.querySelector<HTMLElement>(`[${attr}="${id}"]`);
        if (!node) continue;
        const r = node.getBoundingClientRect();
        const dist =
          dir === "up"
            ? sRect.top - r.bottom // element fully above the top edge
            : r.top - sRect.bottom; // element fully below the bottom edge
        if (dist > 0 && dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (bestId != null) reveal(bestId);
    },
    [highlighted, attr, reveal, scrollRef],
  );

  const jumpAbove = useCallback(() => jump("up"), [jump]);
  const jumpBelow = useCallback(() => jump("down"), [jump]);
  return { hasAbove, hasBelow, jumpAbove, jumpBelow };
}
