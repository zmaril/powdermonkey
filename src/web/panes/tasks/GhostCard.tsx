// straitjacket-allow-file:prop-drilling  `label` is a presentational string set by the
// caller (GhostCardBody vs GhostHeader), forwarded to the strip — not shared state to lift.
import { Card, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { Ghost } from "../../ghosts.ts";
import { GHOST_BORDER } from "./constants.ts";
import { GhostStrip } from "./GhostStrip.tsx";
import { useProposalHighlighted } from "./new-proposal.ts";

/** A proposed new node, rendered as a dashed-teal card: its title, optional body (a
 *  ghost task shows its phase list; a ghost goal/milestone header shows nothing), then
 *  the standard accept/reject strip. So every "not yet real" node reads the same. */
export function GhostCard({
  ghost,
  titleWeight,
  label,
  children,
}: {
  ghost: Ghost;
  titleWeight: number;
  label: string;
  children?: ReactNode;
}) {
  // Glows while this proposal is freshly-arrived and not yet seen on screen. The whole ghost
  // card carries the proposal handle + the glow (its inner accept/reject strip doesn't
  // double up); the seen-reveal observer clears it once the card has dwelt in view.
  const highlight = useProposalHighlighted(ghost.proposalId);
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-pm-proposal={ghost.proposalId}
      className={highlight ? "pm-new-card" : undefined}
      style={{ border: GHOST_BORDER }}
    >
      <Text fw={titleWeight} truncate mb="snug">
        {ghost.title}
      </Text>
      {children}
      <GhostStrip ghost={ghost} label={label} />
    </Card>
  );
}
