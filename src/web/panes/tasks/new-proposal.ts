import { createContext, type RefObject, useContext } from "react";
import { useSeenHighlight, useSeenObserver } from "./seen-reveal.ts";

// The "a new proposal just landed" affordances for the Tasks pane — the proposal-side twin
// of new-task.ts, built on the same seen-reveal engine. A pending proposal projects onto the
// plan as ghost cards (a proposed new node) and edit strips (a proposed change on an existing
// node), scattered wherever each piece belongs. When one arrives while you weren't looking,
// those pieces should catch the eye until you've seen them — the same "new, not yet seen"
// glow real cards get, keyed on the PROPOSAL id (a change-set can render several pieces, all
// glowing together) rather than a task id.
//
// Unlike tasks there's no "locally added" reveal queue — you don't author proposals from this
// UI, so nothing here ever yanks your scroll; a new proposal only ever lights up in place.

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

// Ghost cards and edit strips carry their proposal id on `data-pm-proposal` — the handle the
// seen-reveal engine observes to clear the glow once a piece has been on screen.
const PROPOSAL_ATTR = "data-pm-proposal";

export type NewProposalTracking = {
  highlighted: ReadonlySet<number>;
};

/** Drive the Tasks pane's new-proposal glow. Two jobs, both on the shared seen-reveal engine:
 *
 *   1. Detect newly-arrived pending proposals off the synced collection (useSeenHighlight):
 *      diff the live pending-proposal set (`allIds`) against what we've already seen, gated
 *      to the ones that render a piece right now (`present` = renderedProposalIds). The
 *      proposals already pending on load are adopted as seen and never light up — only ones
 *      that appear AFTER are "new". `idsKey` (a digest of `present`) re-fires the diff, and
 *      `ready` (the collection's first snapshot) lets a board that loads with no pending
 *      proposals seed an empty seen-set and still light up its first arrival.
 *
 *   2. Glow each new proposal's pieces until seen (useSeenObserver): a ring stays on every
 *      ghost card / edit strip carrying the proposal's id until one of them has actually been
 *      on screen, cleared by an IntersectionObserver dwell.
 *
 *  Returns the live highlight set for the pane to provide over context. */
export function useNewProposalReveal(
  scrollRef: RefObject<HTMLDivElement | null>,
  idsKey: string,
  allIds: Set<number>,
  present: Set<number>,
  ready: boolean,
): NewProposalTracking {
  const [highlighted, setHighlighted] = useSeenHighlight(idsKey, allIds, present, ready);
  useSeenObserver(scrollRef, PROPOSAL_ATTR, highlighted, setHighlighted, idsKey);
  return { highlighted };
}
