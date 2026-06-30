import { Card, Text } from "@mantine/core";
import type { Phase } from "../../../server/schema.ts";
import { Decision, PhaseStatus } from "../../../shared/types.ts";
import type { Ghost } from "../../ghosts.ts";
import { PhaseList } from "../../plan-ui";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { GHOST_BORDER_COLOR } from "./constants.ts";
import { useDecide } from "./useDecide.ts";

const GHOST_BORDER = `1px dashed ${GHOST_BORDER_COLOR}`;

/** A proposed new task, rendered like a real card (same title font + phase list) but with
 *  a dashed border and the standard accept/reject strip — so it reads as a peer of the
 *  real cards while still being clearly not-yet-real. */
export function GhostCardBody({ ghost }: { ghost: Ghost }) {
  const { busy, decide } = useDecide();
  const ghostPhases = ghost.phases.map(
    (name, i) => ({ id: -(i + 1), name, status: PhaseStatus.Todo }) as unknown as Phase,
  );
  return (
    <Card withBorder radius="md" padding="sm" style={{ border: GHOST_BORDER }}>
      <Text fw={500} truncate mb="snug">
        {ghost.title}
      </Text>
      <PhaseList phases={ghostPhases} />
      <ProposedStrip
        label="Proposed: new task"
        hint={`From proposal P${ghost.proposalId}: ${ghost.proposalTitle}`}
        busy={busy}
        onAccept={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Accept)}
        onReject={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Reject)}
      />
    </Card>
  );
}
