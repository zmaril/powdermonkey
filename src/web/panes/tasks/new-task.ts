import { createContext, type RefObject, useContext, useEffect } from "react";
import { create } from "zustand";
import {
  addHighlights,
  useOffscreenJump,
  useSeenHighlight,
  useSeenObserver,
} from "./seen-reveal.ts";

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

// Cards carry their task id on `data-pm-card` — the handle the seen-reveal engine observes.
const TASK_ATTR = "data-pm-card";

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
 *   1. Detect new tasks off the synced collection: diff the full live task-id set (`allIds`)
 *      against what we've already seen, and highlight any task that's newly appeared —
 *      wherever it came from (your "+ Add task", a worker, an accepted proposal). Detection
 *      alone never scrolls; that's the local/remote split — only a task YOU added (the reveal
 *      queue) yanks your scroll, so a task that arrives from elsewhere lights up and gets the
 *      indicator without moving you. (The seen-set diff + prune live in useSeenHighlight,
 *      shared with the proposal reveal.)
 *
 *   2. Auto-scroll locally-added tasks: drain the reveal queue, scrolling each queued card
 *      into view the moment it mounts. `idsKey` (a stable digest of the rendered task ids)
 *      is a retry trigger — the create POST returns the id before the insert reaches the
 *      collection, so the card usually isn't in the DOM on the first drain.
 *
 *   3. Highlight new cards until seen: a glowing ring stays on each new card until it has
 *      actually been on screen, cleared by an IntersectionObserver (useSeenObserver).
 *      `present` is the set of currently-rendered (backlog) task ids, used both to gate
 *      detection to cards that actually render and to drop a highlight whose card left the
 *      backlog (launched / removed) before it was ever seen.
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
  const [highlighted, setHighlighted] = useSeenHighlight(idsKey, allIds, present);

  // Drain the reveal queue: mark each locally-added task as highlighted (even one that's
  // already on screen still glows), then scroll it in and drop it from the queue once its
  // card exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a retry trigger, not read here — a queued reveal re-attempts the moment its card mounts (idsKey changes).
  useEffect(() => {
    if (queue.length === 0) return;
    setHighlighted((prev) => addHighlights(prev, queue));
    for (const id of queue) if (revealCard(id)) consumeReveal(id);
  }, [queue, idsKey, revealCard, consumeReveal, setHighlighted]);

  // Clear each highlight once its card has dwelt on screen, tracking its off-screen spot.
  const spots = useSeenObserver(scrollRef, TASK_ATTR, highlighted, setHighlighted, idsKey);
  const { hasAbove, hasBelow, jumpAbove, jumpBelow } = useOffscreenJump(
    scrollRef,
    TASK_ATTR,
    highlighted,
    spots,
    revealCard,
  );

  return { highlighted, hasAbove, hasBelow, jumpAbove, jumpBelow };
}
