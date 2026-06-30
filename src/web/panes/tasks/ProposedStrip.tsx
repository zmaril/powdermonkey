import { Button, Group, Text } from "@mantine/core";
import { GHOST_BORDER_COLOR, PROPOSED_TEXT_COLOR } from "./constants.ts";

/** The standard proposal-review strip at the bottom of a card: a "Proposed: …" label on
 *  the left, accept (✓) / reject (✗) on the right. Shared by ghost cards (a proposed new
 *  task) and real cards with proposed edits (rename / delete / move), so every proposal
 *  reads and acts the same way wherever it lands. */
export function ProposedStrip({
  label,
  hint,
  busy,
  onAccept,
  onReject,
}: {
  label: string;
  hint?: string;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      mt="cozy"
      style={{ borderTop: `1px dashed ${GHOST_BORDER_COLOR}`, paddingTop: 8 }}
    >
      <Text
        size="xs"
        truncate
        style={{ flex: 1, minWidth: 0, color: PROPOSED_TEXT_COLOR }}
        title={hint}
      >
        {label}
      </Text>
      <Button
        size="compact-xs"
        variant="filled"
        color="teal"
        loading={busy}
        title="Accept"
        onClick={onAccept}
      >
        ✓
      </Button>
      <Button
        size="compact-xs"
        variant="filled"
        color="red"
        disabled={busy}
        title="Reject"
        onClick={onReject}
      >
        ✗
      </Button>
    </Group>
  );
}
