import { Card, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { Ghost } from "../../ghosts.ts";
import { GHOST_BORDER } from "./constants.ts";
import { GhostStrip } from "./GhostStrip.tsx";

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
  return (
    <Card withBorder radius="md" padding="sm" style={{ border: GHOST_BORDER }}>
      <Text fw={titleWeight} truncate mb="snug">
        {ghost.title}
      </Text>
      {children}
      <GhostStrip ghost={ghost} label={label} />
    </Card>
  );
}
