// straitjacket-allow-file:prop-drilling  `label` + `badge` are presentational, set by the
// caller (GhostCardBody vs GhostHeader) and forwarded to the card — not shared state to lift.
import { Card, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { Ghost } from "../../ghosts.ts";
import { GHOST_BORDER } from "./constants.ts";
import { GhostStrip } from "./GhostStrip.tsx";
import { useProposalHighlighted } from "./new-proposal.ts";

/** A proposed new node, rendered as a dashed-teal card in its would-be after-state: its
 *  title (with an optional kind badge), optional body (a ghost task shows its description
 *  + phase list; a ghost goal/milestone header shows nothing), then the accept/reject
 *  footer. So every "not yet real" node reads like the real node it will become. */
export function GhostCard({
  ghost,
  titleWeight,
  label,
  badge,
  children,
}: {
  ghost: Ghost;
  titleWeight: number;
  label: string;
  /** An optional badge shown before the title (a task ghost's kind). */
  badge?: ReactNode;
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
      <Group gap="xs" wrap="nowrap" mb="snug" style={{ minWidth: 0 }}>
        {badge}
        <Text fw={titleWeight} truncate style={{ minWidth: 0 }}>
          {ghost.title}
        </Text>
      </Group>
      {children}
      <GhostStrip ghost={ghost} label={label} />
    </Card>
  );
}
