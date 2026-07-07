import type { ReactNode } from "react";
import { PROPOSED_HIGHLIGHT_BG, PROPOSED_TEXT_COLOR } from "./constants.ts";

/** Proposed (added / rewritten) content in the inline review preview: teal text in a teal
 *  wash, so it reads as the incoming value. `block` pads it as its own line (a
 *  description); inline hugs the text (a title, a phase name). Never truncated — a change
 *  you're about to accept must be fully legible. */
export function Added({ children, block = false }: { children: ReactNode; block?: boolean }) {
  return (
    <span
      style={{
        background: PROPOSED_HIGHLIGHT_BG,
        color: PROPOSED_TEXT_COLOR,
        borderRadius: 3,
        padding: block ? "2px 6px" : "0 3px",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
      }}
    >
      {children}
    </span>
  );
}
