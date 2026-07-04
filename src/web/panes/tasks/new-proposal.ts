import { createContext, useContext, useEffect, useRef, useState } from "react";

// The "a new proposal just landed" affordances for the Tasks pane — the proposal-side twin
// of new-task.ts. A pending proposal projects onto the plan as ghost cards (a proposed new
// node) and edit strips (a proposed change on an existing node), scattered wherever each
// piece belongs. When one arrives while you weren't looking, those pieces should catch the
// eye until you've seen them — the same "new, not yet seen" glow real cards get, keyed on
// the PROPOSAL id (a change-set can render several pieces, all glowing together) rather than
// a task id.
//
// Detection mirrors useNewTaskReveal exactly: diff the live proposal-id set against what
// we've already seen and light up whatever appeared AFTER load. Unlike tasks there's no
// "locally added" reveal queue — you don't author proposals from this UI, so nothing here
// ever yanks your scroll; a new proposal only ever lights up in place.

// ── Highlight context ────────────────────────────────────────────────────────
// The ids of pending proposals currently glowing as "new, not yet seen". The Tasks pane owns
// the set (it runs the diff and the IntersectionObserver that clears each once its piece has
// been on screen) and provides it here; every ghost card / edit strip reads its own
// proposal's membership to render the glow, so the highlight never has to be threaded down
// the goal/milestone/task layers.
const ProposalHighlightContext = createContext<ReadonlySet<number>>(new Set());
export const ProposalHighlightProvider = ProposalHighlightContext.Provider;
export const useProposalHighlighted = (proposalId: number): boolean =>
  useContext(ProposalHighlightContext).has(proposalId);

export type NewProposalTracking = {
  highlighted: ReadonlySet<number>;
};

/** Detect newly-arrived pending proposals off the synced collection.
 *
 *   • `allIds` — every pending proposal id (the full surface, live off the collection).
 *   • `present` — the proposal ids that render at least one piece on the board right now
 *     (renderedProposalIds). Detection is gated to these, so a proposal only lights up when
 *     it has an element to glow — exactly as the new-task glow gates to rendered cards.
 *   • `idsKey` — a stable digest of `present`; it changes precisely when the rendered
 *     proposal set does (a proposal lands/leaves, a filter shifts), which is when detection
 *     and the prune should re-run.
 *
 *  `seen` is null until the first snapshot, so the proposals already pending on load are
 *  adopted as already-known and never light up — only ones that appear AFTER are "new". */
export function useNewProposalReveal(
  idsKey: string,
  allIds: Set<number>,
  present: Set<number>,
): NewProposalTracking {
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(() => new Set());

  // Read the live sets through refs so the id-keyed effects fire off idsKey (which changes
  // only when the rendered set does) instead of re-running on every render.
  const presentRef = useRef(present);
  presentRef.current = present;
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;

  // Diff the live proposal set against what we've already seen. The initial set is adopted
  // as seen (never glows); anything that appears later and renders a piece is highlighted.
  const seenRef = useRef<Set<number> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: allIds/present are read via refs; idsKey changing is exactly when the rendered proposal set changed.
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
      let next: Set<number> | null = null;
      for (const id of fresh)
        if (!prev.has(id)) {
          next ??= new Set(prev);
          next.add(id);
        }
      return next ?? prev;
    });
  }, [idsKey]);

  // Drop a highlight whose proposal no longer renders a piece — it was approved, rejected,
  // or otherwise dropped out before it was ever seen — so a glow can't get stranded forever.
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

  return { highlighted };
}
