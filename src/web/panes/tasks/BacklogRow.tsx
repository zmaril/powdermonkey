import { Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { ProposalOp } from "../../../shared/types.ts";
import type { EntityEdit, Ghost } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag, KindBadge, ProgressPill, RepoBadge, StarToggle, useRepo } from "../../plan-ui";
import { GHOST_BORDER_COLOR, SELECTED_SHADOW } from "./constants.ts";
import { useHighlighted } from "./new-task.ts";
import { GhostStrip, TaskProposalStrips } from "./proposal-strips.tsx";
import { TaskActions } from "./TaskActions.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { isTerminal } from "./task-status.ts";
import type { Selection } from "./types.ts";

const ROW_BORDER = "1px solid var(--pm-hairline)";
const GHOST_BORDER = `2px solid ${GHOST_BORDER_COLOR}`;

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
  // Glows while this is a freshly-added task you haven't seen yet (-1 never matches, for the
  // ghost render path below). Hook stays above the early returns.
  const highlight = useHighlighted(task?.id ?? -1);
  // The task's repo identity (color + icon); undefined for repo-less tasks.
  const repo = useRepo(task?.repoId);

  if (ghost) {
    return (
      <Box px="sm" py="cozy" style={{ borderBottom: ROW_BORDER, borderLeft: GHOST_BORDER }}>
        <Text size="sm" fw={500} truncate>
          {ghost.title}
        </Text>
        <GhostStrip ghost={ghost} label="Proposed: new task" />
      </Box>
    );
  }

  if (!task) return null;
  const phases = idx.phasesByTask.get(task.id) ?? [];
  const checked = selection.selected.has(task.id);
  const archiveProposed = edits.some((e) => e.op === ProposalOp.Archive);
  // A finished / won't-do / archived task shows its outcome (badge + reopen + links)
  // in place of the launch actions — the old Archive row, folded in.
  const terminal = isTerminal(task);
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
        {repo && <RepoBadge repo={repo} />}
        {phases.length > 0 && <ProgressPill phases={phases} />}
        {!selection.active &&
          (terminal ? <TaskOutcome task={task} /> : <TaskActions ids={[task.id]} />)}
      </Group>
      <TaskProposalStrips
        edits={edits}
        phaseGhosts={phaseGhosts}
        phaseEdits={phaseEdits}
        phases={phases}
      />
    </Box>
  );
}
