import { Button, Group, Text } from "@mantine/core";
import { GHOST_BORDER_COLOR, PROPOSED_TEXT_COLOR } from "./constants.ts";
import { useProposalHighlighted } from "./new-proposal.ts";

/** The standard proposal-review strip at the bottom of a card: a "Proposed: …" label on
 *  the left, accept (✓) / reject (✗) on the right. Shared by ghost cards (a proposed new
 *  task) and real cards with proposed edits (rename / delete / move), so every proposal
 *  reads and acts the same way wherever it lands. When `proposalId` is set the strip carries
 *  the new-proposal handle and glows while that proposal is freshly-arrived and unseen — the
 *  edit-strip twin of the ghost card's glow. (Ghost cards glow on the card itself, so their
 *  inner strip leaves `proposalId` unset to avoid doubling the ring.) */
export function ProposedStrip({
  label,
  hint,
  busy,
  onAccept,
  onReject,
  proposalId,
}: {
  label: string;
  hint?: string;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  proposalId?: number;
}) {
  const highlight = useProposalHighlighted(proposalId ?? -1);
  return (
    <Group
      gap="xs"
      wrap="nowrap"
      mt="cozy"
      data-pm-proposal={proposalId}
      className={proposalId != null && highlight ? "pm-new-card" : undefined}
      style={{ borderTop: `1px dashed ${GHOST_BORDER_COLOR}`, paddingTop: 8 }}
    >
      {/* Wrap (don't truncate): a proposed change must be fully legible before you accept
          it — a one-line ellipsis hid everything past the title (kind / description). */}
      <Text
        size="xs"
        lineClamp={3}
        style={{ flex: 1, minWidth: 0, color: PROPOSED_TEXT_COLOR, overflowWrap: "anywhere" }}
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
