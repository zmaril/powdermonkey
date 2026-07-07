import { createContext, type RefObject, useContext } from "react";
import { useOffscreenJump, useSeenHighlight, useSeenObserver } from "./seen-reveal.ts";

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
// The whole glowing set, for a spot that decides several proposals at once (the inline
// accept/reject controls, one ✓/✗ per change) and can't call the per-id hook in a loop.
export const useProposalHighlights = (): ReadonlySet<number> =>
  useContext(ProposalHighlightContext);

// Ghost cards and edit strips carry their proposal id on `data-pm-proposal` — the handle the
// seen-reveal engine observes to clear the glow once a piece has been on screen.
const PROPOSAL_ATTR = "data-pm-proposal";

export type NewProposalTracking = {
  highlighted: ReadonlySet<number>;
  // True when at least one still-glowing proposal piece is off-screen in that direction.
  hasAbove: boolean;
  hasBelow: boolean;
  // Scroll to the nearest off-screen new proposal in that direction.
  jumpAbove: () => void;
  jumpBelow: () => void;
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
 *   3. Point at the off-screen ones (useOffscreenJump): the up/down "New proposal" pill and
 *      its jump-to-nearest, so a glow that landed above/below the fold is still findable.
 *      `revealProposal` scrolls a proposal's first piece into view.
 *
 *  Returns the live highlight set (provided over context) + the off-screen-indicator state. */
export function useNewProposalReveal(
  scrollRef: RefObject<HTMLDivElement | null>,
  idsKey: string,
  allIds: Set<number>,
  present: Set<number>,
  ready: boolean,
  revealProposal: (proposalId: number) => boolean,
): NewProposalTracking {
  const [highlighted, setHighlighted] = useSeenHighlight(idsKey, allIds, present, ready);
  const spots = useSeenObserver(scrollRef, PROPOSAL_ATTR, highlighted, setHighlighted, idsKey);
  const { hasAbove, hasBelow, jumpAbove, jumpBelow } = useOffscreenJump(
    scrollRef,
    PROPOSAL_ATTR,
    highlighted,
    spots,
    revealProposal,
  );
  return { highlighted, hasAbove, hasBelow, jumpAbove, jumpBelow };
}
