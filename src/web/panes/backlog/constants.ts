// Electric-blue glow on a selected card / the batch bar, so the live selection pops.
export const SELECTED_SHADOW =
  "0 0 0 2px var(--mantine-color-blue-5), 0 0 16px 2px rgba(59,130,246,0.55)";

// List add/remove/reorder animation — auto-animate handles enter/leave/FLIP (and skips
// the initial mount), so launching a card eases it out and starring re-sorts smoothly
// without the hand-rolled jank. One gentle duration for the whole pane.
export const ANIM_OPTS = { duration: 300 } as const;
