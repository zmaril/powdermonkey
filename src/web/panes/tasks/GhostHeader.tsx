import { Card, Text } from "@mantine/core";
import { Decision } from "../../../shared/types.ts";
import { type Ghost, ghostLabel } from "../../ghosts.ts";
import { GHOST_BORDER_COLOR } from "./constants.ts";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { useDecide } from "./useDecide.ts";

const GHOST_BORDER = `1px dashed ${GHOST_BORDER_COLOR}`;

/** A proposed new milestone or goal — a dashed block with its title and the standard
 *  accept/reject strip, matching the ghost task cards. Any child tasks/phases the create
 *  also proposes ride along when it's accepted. */
export function GhostHeader({ ghost }: { ghost: Ghost }) {
  const { busy, decide } = useDecide();
  return (
    <Card withBorder radius="md" padding="sm" style={{ border: GHOST_BORDER }}>
      <Text fw={600} truncate mb="snug">
        {ghost.title}
      </Text>
      <ProposedStrip
        label={ghostLabel(ghost)}
        hint={`From proposal P${ghost.proposalId}: ${ghost.proposalTitle}`}
        busy={busy}
        onAccept={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Accept)}
        onReject={() => decide(ghost.proposalId, ghost.changeIndex, Decision.Reject)}
      />
    </Card>
  );
}
