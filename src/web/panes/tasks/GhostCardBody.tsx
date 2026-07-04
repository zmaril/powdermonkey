import type { Phase } from "../../../server/schema.ts";
import { PhaseStatus } from "../../../shared/types.ts";
import type { Ghost } from "../../ghosts.ts";
import { PhaseList } from "../../plan-ui";
import { GhostCard } from "./GhostCard.tsx";

/** A proposed new task, rendered like a real card (same title font + phase list) but with
 *  a dashed border and the standard accept/reject strip — so it reads as a peer of the
 *  real cards while still being clearly not-yet-real. */
export function GhostCardBody({ ghost }: { ghost: Ghost }) {
  const ghostPhases = ghost.phases.map(
    (name, i) => ({ id: -(i + 1), name, status: PhaseStatus.Todo }) as unknown as Phase,
  );
  return (
    <GhostCard ghost={ghost} titleWeight={500} label="Proposed: new task">
      <PhaseList phases={ghostPhases} />
    </GhostCard>
  );
}
