import { Added } from "./Added.tsx";
import { Arrow } from "./Arrow.tsx";
import { Removed } from "./Removed.tsx";

/** A rename, said in full: old (struck) → new (highlighted). Inline, wrapping — never
 *  clipped, so both the before and after are legible before you decide. */
export function Rename({ before, after }: { before: string; after: string }) {
  return (
    <span style={{ overflowWrap: "anywhere" }}>
      <Removed>{before}</Removed>
      <Arrow />
      <Added>{after}</Added>
    </span>
  );
}
