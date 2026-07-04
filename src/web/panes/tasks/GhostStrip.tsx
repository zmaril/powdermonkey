// straitjacket-allow-file:prop-drilling  `label` is a presentational string set by the
// caller (GhostCardBody's "Proposed: new task" vs GhostHeader's ghostLabel), not shared
// state that could be lifted into a store/context.
import { Decision } from "../../../shared/types.ts";
import type { Ghost } from "../../ghosts.ts";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { hintFor } from "./strip-helpers.ts";
import { useDecide } from "./useDecide.ts";

/** The single accept/reject strip under a ghost (proposed new) node. */
export function GhostStrip({ ghost, label }: { ghost: Ghost; label: string }) {
  const { busy, decide } = useDecide();
  return (
    <ProposedStrip
      label={label}
      hint={hintFor(ghost.proposalId, ghost.proposalTitle)}
      busy={busy}
      onAccept={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Accept)}
      onReject={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Reject)}
    />
  );
}
