import { Button, Group, Text } from "@mantine/core";

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
      mt={8}
      style={{ borderTop: "1px dashed var(--mantine-color-teal-7)", paddingTop: 8 }}
    >
      <Text size="xs" c="teal.3" truncate style={{ flex: 1, minWidth: 0 }} title={hint}>
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
