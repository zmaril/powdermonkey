// Electric-blue glow on a selected card / the batch bar, so the live selection pops.
export const SELECTED_SHADOW =
  "0 0 0 2px var(--mantine-color-blue-5), 0 0 16px 2px var(--pm-selection-glow)";

// The list add/remove/reorder animation lives in use-list-animation.ts now (keyed off
// the motion setting), so its options no longer live here.

// Proposal-review accents — the teal that marks a "ghost" (proposed) node's dashed
// border and the teal "Proposed: …" strip label. Both are scheme-aware via CSS
// light-dark(): a darker teal on light themes (so it reads on a white/cream card) and a
// lighter teal on dark themes — a single fixed shade can't clear contrast on both. They
// resolve off the element's color-scheme, which applyThemeVars (themes.ts) sets to the
// active theme's scheme, so the teal re-skins with the theme instead of washing out.
export const GHOST_BORDER_COLOR =
  "light-dark(var(--mantine-color-teal-7), var(--mantine-color-teal-5))";
export const PROPOSED_TEXT_COLOR =
  "light-dark(var(--mantine-color-teal-8), var(--mantine-color-teal-3))";

// The dashed teal edge on a ghost (proposed) card — the goal/milestone/task-ghost
// blocks all share it, so it lives with the color it's built from.
export const GHOST_BORDER = `1px dashed ${GHOST_BORDER_COLOR}`;
