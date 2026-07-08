import { Badge, Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { type Ghost, taskProposalProps } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag, ProgressPill, RepoBadge, StarToggle, useRepo } from "../../plan-ui";
import { useBoardData } from "./board-data-context.ts";
import { GHOST_BORDER_COLOR, SELECTED_SHADOW } from "./constants.ts";
import { DecideControls } from "./DecideControls.tsx";
import { GhostStrip } from "./GhostStrip.tsx";
import { KindDiff } from "./KindDiff.tsx";
import { useHighlighted } from "./new-task.ts";
import { PreviewPhaseList } from "./PreviewPhaseList.tsx";
import { previewPhases, taskPreview } from "./preview.ts";
import { Rename } from "./Rename.tsx";
import { shiftSelectHandlers, useSelection } from "./selection-context.ts";
import { TaskActions } from "./TaskActions.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { isTerminal } from "./task-status.ts";

const ROW_BORDER = "1px solid var(--pm-hairline)";
const GHOST_BORDER = `2px solid ${GHOST_BORDER_COLOR}`;

/** One dense backlog row for the flat view: star · id · title · context on the left, the
 *  same actions on the right. Pending proposal changes render in place as the row's
 *  proposed after-state — title old → new, kind retagged, a proposed delete striking it —
 *  with per-change accept/reject; any phase-level changes show as diff rows below. When
 *  `ghost` is set it's a proposed new task row instead (teal-edged, with accept/reject).
 *  Shift-click selects; selected rows get the glow. */
export function BacklogRow({
  task,
  idx,
  context,
  ghost,
}: {
  task?: Task;
  idx: Indexes;
  context?: string;
  ghost?: Ghost;
}) {
  // Glows while this is a freshly-added task you haven't seen yet (-1 never matches, for the
  // ghost render path below). Hook stays above the early returns.
  const highlight = useHighlighted(task?.id ?? -1);
  // The task's repo identity (color + icon); undefined for repo-less tasks.
  const repo = useRepo(task?.repoId);
  // Multi-select state comes from context (provided at the TasksPane root).
  const selection = useSelection();
  // The board-wide maps this row's phases + proposal edits derive from (see BoardDataContext).
  const { ghosts, edits } = useBoardData();

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
  // This row's phases + every pending change on the task and its phases.
  const {
    phases,
    edits: taskEdits = [],
    phaseGhosts = [],
    phaseEdits,
  } = taskProposalProps(task, idx, ghosts, edits);
  const preview = taskPreview(task, taskEdits);
  // Only the changed phases surface in the dense row (the full checklist lives on the card).
  const changedPhases = previewPhases(phases, phaseEdits, phaseGhosts).filter((r) => r.change);
  const checked = selection.selected.has(task.id);
  const struck = preview.archived;
  // A finished / won't-do / archived task shows its outcome (badge + reopen + links) in
  // place of the launch actions — the old Archive row, folded in.
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
      {...shiftSelectHandlers(selection, task.id)}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <StarToggle task={task} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="snug" wrap="nowrap">
            <IdTag prefix="t" id={task.id} />
            {struck ? null : (
              <KindDiff
                before={preview.kind.before}
                after={preview.kind.after}
                changed={preview.kind.changed}
              />
            )}
            <Text
              size="sm"
              fw={500}
              truncate={!preview.title.changed}
              c={struck ? "dimmed" : undefined}
              td={struck ? "line-through" : undefined}
              style={{ minWidth: 0 }}
            >
              {!struck && preview.title.changed ? (
                <Rename before={preview.title.before} after={preview.title.after} />
              ) : (
                task.title
              )}
            </Text>
            {preview.reordered && !struck && (
              <Badge color="teal" variant="light" style={{ flexShrink: 0 }}>
                ↕ moved
              </Badge>
            )}
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
      {/* Phase-level changes as diff rows, and the task-level accept/reject beneath. */}
      {changedPhases.length > 0 && (
        <Box mt="tight">
          <PreviewPhaseList rows={changedPhases} />
        </Box>
      )}
      {preview.changes.length > 0 && (
        <Group justify="flex-end" mt="tight">
          <DecideControls changes={preview.changes} compact />
        </Group>
      )}
    </Box>
  );
}
