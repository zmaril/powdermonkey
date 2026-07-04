import { Decision } from "../../../shared/types.ts";
import { type EntityEdit, editLabel } from "../../ghosts.ts";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { hintFor } from "./strip-helpers.ts";
import { useDecide } from "./useDecide.ts";

/** Edits on a node itself (rename / delete) — the strips on a goal or milestone header.
 *  Owns one useDecide() for the whole group, so callers don't repeat the accept/reject
 *  wiring. */
export function EditStrips({ edits }: { edits: EntityEdit[] }) {
  const { busy, decide } = useDecide();
  return (
    <>
      {edits.map((e) => (
        <ProposedStrip
          key={`p${e.proposalId}-${e.changeIndex}`}
          label={editLabel(e)}
          hint={hintFor(e.proposalId, e.proposalTitle)}
          busy={busy}
          onAccept={() => decide(e.proposalId, e.changeIndex, Decision.Accept)}
          onReject={() => decide(e.proposalId, e.changeIndex, Decision.Reject)}
          proposalId={e.proposalId}
        />
      ))}
    </>
  );
}
