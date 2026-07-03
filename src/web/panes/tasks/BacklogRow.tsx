import { Box, Group, Text } from "@mantine/core";
import type { Phase, Task } from "../../../server/schema.ts";
import { Decision, ProposalOp, TaskStatus } from "../../../shared/types.ts";
import { type EntityEdit, type Ghost, editLabel } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag, KindBadge, ProgressPill, StarToggle } from "../../plan-ui";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { TaskActions } from "./TaskActions.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { GHOST_BORDER_COLOR, SELECTED_SHADOW } from "./constants.ts";
import { useHighlighted } from "./new-task.ts";
import type { Selection } from "./types.ts";
import { useDecide } from "./useDecide.ts";

const ROW_BORDER = "1px solid var(--pm-hairline)";
const GHOST_BORDER = `2px solid ${GHOST_BORDER_COLOR}`;

/** How a proposed edit on one of a task's phases reads — with the phase's own name. */
function phaseEditLabel(e: EntityEdit, phases: Phase[]): string {
  const name = phases.find((p) => p.id === e.id)?.name ?? "this phase"; // lint-allow-string: display fallback, not the VocabKind
  if (e.op === ProposalOp.Archive) return `Proposed: delete phase "${name}"`;
  if (e.op === ProposalOp.Update) return `Proposed: rename phase → "${e.newTitle ?? ""}"`;
  return editLabel(e);
}

/** One dense backlog row for the flat view: star · id · title · context on the left, the
 *  same actions on the right; pending proposal changes on it or its phases show as strips
 *  below. When `ghost` is set it's a proposed new task row instead (teal-edged, with the
 *  standard accept/reject strip). Shift-click selects; selected rows get the glow. */
export function BacklogRow({
  task,
  idx,
  context,
  selection,
  ghost,
  edits = [],
  phaseGhosts = [],
  phaseEdits = [],
}: {
  task?: Task;
  idx: Indexes;
  context?: string;
  selection: Selection;
  ghost?: Ghost;
  edits?: EntityEdit[];
  phaseGhosts?: Ghost[];
  phaseEdits?: EntityEdit[];
}) {
  const { busy, decide } = useDecide();
  // Glows while this is a freshly-added task you haven't seen yet (-1 never matches, for the
  // ghost render path below). Hook stays above the early returns.
  const highlight = useHighlighted(task?.id ?? -1);
  const strip = (key: string, label: string, hint: string, proposalId: number, ix: number) => (
    <ProposedStrip
      key={key}
      label={label}
      hint={hint}
      busy={busy}
      onAccept={() => decide(proposalId, ix, Decision.Accept)}
      onReject={() => decide(proposalId, ix, Decision.Reject)}
    />
  );

  if (ghost) {
    return (
      <Box px="sm" py="cozy" style={{ borderBottom: ROW_BORDER, borderLeft: GHOST_BORDER }}>
        <Text size="sm" fw={500} truncate>
          {ghost.title}
        </Text>
        {strip(
          "ghost",
          "Proposed: new task",
          `From proposal P${ghost.proposalId}: ${ghost.proposalTitle}`,
          ghost.proposalId,
          ghost.changeIndex,
        )}
      </Box>
    );
  }

  if (!task) return null;
  const phases = idx.phasesByTask.get(task.id) ?? [];
  const checked = selection.selected.has(task.id);
  const archiveProposed = edits.some((e) => e.op === ProposalOp.Archive);
  // A finished / won't-do / archived task shows its outcome (badge + reopen + links)
  // in place of the launch actions — the old Archive row, folded in.
  const terminal =
    task.status === TaskStatus.Merged ||
    task.status === TaskStatus.Cancelled ||
    task.archivedAt != null;
  return (
    <Box
      px="sm"
      py="cozy"
      data-pm-card={task.id}
      data-pm-reveal={`t${task.id}`}
      className={highlight ? "pm-new-card" : undefined}
      style={{
        borderBottom: "1px solid var(--pm-hairline)",
        background: checked ? "var(--pm-surface)" : undefined,
        boxShadow: checked ? SELECTED_SHADOW : undefined,
      }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          selection.toggle(task.id);
        }
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <StarToggle task={task} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="snug" wrap="nowrap">
            <IdTag prefix="t" id={task.id} />
            <KindBadge kind={task.kind} />
            <Text
              size="sm"
              fw={500}
              truncate
              c={archiveProposed ? "dimmed" : undefined}
              td={archiveProposed ? "line-through" : undefined}
            >
              {task.title}
            </Text>
          </Group>
          {context && (
            <Text size="xs" c="dimmed" truncate>
              {context}
            </Text>
          )}
        </Box>
        {phases.length > 0 && <ProgressPill phases={phases} />}
        {!selection.active &&
          (terminal ? <TaskOutcome task={task} /> : <TaskActions ids={[task.id]} />)}
      </Group>
      {edits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          editLabel(e),
          `From proposal P${e.proposalId}: ${e.proposalTitle}`,
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {phaseGhosts.map((g) =>
        strip(
          `p${g.proposalId}-${g.changeIndex}`,
          `Proposed: add phase "${g.title}"`,
          `From proposal P${g.proposalId}: ${g.proposalTitle}`,
          g.proposalId,
          g.changeIndex,
        ),
      )}
      {phaseEdits.map((e) =>
        strip(
          `p${e.proposalId}-${e.changeIndex}`,
          phaseEditLabel(e, phases),
          `From proposal P${e.proposalId}: ${e.proposalTitle}`,
          e.proposalId,
          e.changeIndex,
        ),
      )}
    </Box>
  );
}
