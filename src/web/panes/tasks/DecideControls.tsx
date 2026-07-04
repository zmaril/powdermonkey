import { Button, Group, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Decision, ProposalOp } from "../../../shared/types.ts";
import { PROPOSED_TEXT_COLOR } from "./constants.ts";
import type { ChangeRef } from "./preview.ts";
import { useDecide } from "./useDecide.ts";

// The one short verb naming what a change does — shown only when a node carries more than
// one pending change, to tell the accept/reject pairs apart (a lone change needs no label:
// the highlighted diff above already says what it is).
const OP_VERB: Record<ProposalOp, string> = {
  [ProposalOp.Create]: "add",
  [ProposalOp.Update]: "edit",
  [ProposalOp.Archive]: "delete",
  [ProposalOp.Reorder]: "move",
};

// The accept / reject pair as data, so the two buttons render from one template (accept
// carries the busy spinner; reject just locks out while a decision is in flight).
const DECISIONS = [
  {
    decision: Decision.Accept,
    symbol: "✓",
    color: "teal",
    variant: "light",
    title: "Accept this change",
  },
  {
    decision: Decision.Reject,
    symbol: "✗",
    color: "red",
    variant: "subtle",
    title: "Reject this change",
  },
] as const;

/** The accept (✓) / reject (✗) control that rides on the inline preview — the card body
 *  above already shows WHAT the change does (the highlighted after-state), so this is just
 *  the decision. One pair per pending change (so each is accepted/rejected on its own),
 *  labeled by op only when there's more than one to keep apart. Owns one useDecide() for
 *  the group; surfaces a decide() conflict inline when `showConflict`. */
export function DecideControls({
  changes,
  showConflict = false,
  compact = false,
}: {
  changes: ChangeRef[];
  showConflict?: boolean;
  /** Tighter buttons for a dense spot (a phase row); default is the card-footer size. */
  compact?: boolean;
}) {
  const { busy, conflict, decide } = useDecide();
  if (changes.length === 0) return null;
  const labeled = changes.length > 1;
  const size = compact ? "compact-xs" : "compact-sm";
  return (
    <Group gap="xs" wrap="wrap">
      {changes.map((c) => (
        <Tooltip
          key={`p${c.proposalId}-${c.changeIndex}`}
          label={`From proposal P${c.proposalId}: ${c.proposalTitle}`}
          withArrow
          openDelay={300}
        >
          <Group gap="tight" wrap="nowrap">
            {labeled && (
              <Text size="xs" style={{ color: PROPOSED_TEXT_COLOR }}>
                {OP_VERB[c.op]}
              </Text>
            )}
            {DECISIONS.map((d) => (
              <Button
                key={d.decision}
                size={size}
                variant={d.variant}
                color={d.color}
                loading={busy && d.decision === Decision.Accept}
                disabled={busy && d.decision !== Decision.Accept}
                title={d.title}
                onClick={() => decide(c.proposalId, c.changeIndex, d.decision)}
              >
                {d.symbol}
              </Button>
            ))}
          </Group>
        </Tooltip>
      ))}
      {showConflict && conflict && (
        <Group
          gap="tight"
          wrap="nowrap"
          style={{
            color: "light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))",
          }}
        >
          <IconAlertTriangle size={14} style={{ flexShrink: 0 }} />
          <Text size="xs">{conflict}</Text>
        </Group>
      )}
    </Group>
  );
}
