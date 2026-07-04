import { Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import type { Phase, Task } from "../../../server/schema.ts";
import { Decision, ProposalOp } from "../../../shared/types.ts";
import { type EntityEdit, editLabel, taskProposalProps } from "../../ghosts.ts";
import { useBoardData } from "./board-data-context.ts";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { hintFor } from "./strip-helpers.ts";
import { useDecide } from "./useDecide.ts";

/** How a proposed edit on one of a task's phases reads — with the phase's own name. */
function phaseEditLabel(e: EntityEdit, phases: Phase[]): string {
  const name = phases.find((p) => p.id === e.id)?.name ?? "this phase"; // lint-allow-string: display fallback, not the VocabKind
  if (e.op === ProposalOp.Archive) return `Proposed: delete phase "${name}"`;
  if (e.op === ProposalOp.Update) return `Proposed: rename phase → "${e.newTitle ?? ""}"`;
  return editLabel(e);
}

/** Every pending change on a task and its phases, as a run of strips: edits on the task
 *  (rename / delete), proposed new phases, and edits on existing phases. `showConflict`
 *  surfaces a decide() conflict inline (the card wants it; the dense row doesn't). Owns
 *  one useDecide() for the whole group. */
export function TaskProposalStrips({
  task,
  showConflict = false,
}: {
  task: Task;
  showConflict?: boolean;
}) {
  // The task's proposal render data (its phases, edits on the task, proposed new phases, and
  // edits on its phases) is derived from the board-wide maps in context, so the card/row
  // conduits above don't thread it down.
  const { idx, ghosts, edits } = useBoardData();
  const {
    phases,
    edits: taskEdits = [],
    phaseGhosts = [],
    phaseEdits,
  } = taskProposalProps(task, idx, ghosts, edits);
  const { busy, conflict, decide } = useDecide();
  const strip = (key: string, label: string, hint: string, proposalId: number, ix: number) => (
    <ProposedStrip
      key={key}
      label={label}
      hint={hint}
      busy={busy}
      onAccept={() => decide(proposalId, ix, Decision.Accept)}
      onReject={() => decide(proposalId, ix, Decision.Reject)}
      proposalId={proposalId}
    />
  );
  return (
    <>
      {taskEdits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          editLabel(e),
          hintFor(e.proposalId, e.proposalTitle),
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {phaseGhosts.map((g) =>
        strip(
          `p${g.proposalId}-${g.changeIndex}`,
          `Proposed: add phase "${g.title}"`,
          hintFor(g.proposalId, g.proposalTitle),
          g.proposalId,
          g.changeIndex,
        ),
      )}
      {phaseEdits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          phaseEditLabel(e, phases),
          hintFor(e.proposalId, e.proposalTitle),
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {showConflict && conflict && (
        <Group
          mt="snug"
          gap="tight"
          wrap="nowrap"
          // Scheme-aware so the warning reads on a light card too (orange.4 is a pale
          // tint that washes out on white); darker orange on light, the tint on dark.
          style={{
            color: "light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))",
          }}
        >
          <IconAlertTriangle size={14} style={{ flexShrink: 0 }} />
          <Text size="xs">{conflict}</Text>
        </Group>
      )}
    </>
  );
}
