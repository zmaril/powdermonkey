// straitjacket-allow-file:prop-drilling  `label` is a presentational string set by the
// caller (GhostCardBody's "Proposed: new task" vs GhostHeader's ghostLabel), not shared
// state that could be lifted into a store/context.
import { Group, Text } from "@mantine/core";
import { ProposalOp } from "../../../shared/types.ts";
import type { Ghost } from "../../ghosts.ts";
import { GHOST_BORDER_COLOR, PROPOSED_TEXT_COLOR } from "./constants.ts";
import { DecideControls } from "./DecideControls.tsx";
import { changeRef } from "./preview.ts";

/** The footer under a ghost (proposed new) node: a small "new …" caption on the left,
 *  the standard accept/reject on the right — the same DecideControls the edit previews
 *  use, so a create decides like every other change. The card body above already shows
 *  the node as it WILL be (its title, kind, description, phases). */
export function GhostStrip({ ghost, label }: { ghost: Ghost; label: string }) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="xs"
      mt="cozy"
      style={{ borderTop: `1px dashed ${GHOST_BORDER_COLOR}`, paddingTop: 8 }}
    >
      <Text size="xs" style={{ color: PROPOSED_TEXT_COLOR }}>
        {label}
      </Text>
      {/* glow off: the ghost card itself carries the proposal handle + glow (GhostCard). */}
      <DecideControls changes={[changeRef(ghost, ProposalOp.Create)]} glow={false} />
    </Group>
  );
}
