import { Button, Card, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Task } from "../../../server/schema.ts";
import { ProposalOp } from "../../../shared/types.ts";
import { type Ghost, taskProposalProps } from "../../ghosts.ts";
import { IdTag, KindBadge, PhaseList, RepoBadge, StarToggle, useRepo } from "../../plan-ui";
import { useBoardData } from "./board-data-context.ts";
import { CardEditor } from "./CardEditor.tsx";
import { SELECTED_SHADOW } from "./constants.ts";
import { GhostCardBody } from "./GhostCardBody.tsx";
import { useHighlighted } from "./new-task.ts";
import { useSelection } from "./selection-context.ts";
import { TaskActions } from "./TaskActions.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { TaskProposalStrips } from "./TaskProposalStrips.tsx";
import { isTerminal } from "./task-status.ts";

/** One backlog card. A real task: star + id + title with an Edit button top-right (the
 *  one way to edit — it opens the whole card as a craft block), its phases, and the
 *  launch/close action bar at the bottom. Shift-click selects; pending proposal changes on
 *  it or its phases show as "Proposed: …" strips. When `ghost` is set it's a PROPOSED new
 *  task instead (see GhostCardBody). */
export function BacklogCard({
  task,
  ghost,
  onEditingChange,
  handle,
}: {
  task?: Task;
  ghost?: Ghost;
  /** Told when this card enters/leaves edit mode, so the list can suspend its animation
   *  (the card<->editor swap shouldn't morph for 300ms — editing should feel instant). */
  onEditingChange?: (editing: boolean) => void;
  /** Drag handle (⠿) rendered at the head of the card, when the card is sortable. */
  handle?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  // Glows while this is a freshly-added task you haven't seen on screen yet (-1 never
  // matches, for the ghost / no-task render paths below). Hook stays above the early returns.
  const highlight = useHighlighted(task?.id ?? -1);
  // The task's repo identity (color + icon); undefined for repo-less tasks.
  const repo = useRepo(task?.repoId);
  // Multi-select state comes from context (provided at the TasksPane root), so the
  // goal/milestone/sortable layers don't thread it down.
  const selection = useSelection();
  // The board-wide maps this card's proposal data is derived from (see BoardDataContext),
  // read from context so the layers above don't thread it down.
  const { idx, ghosts, edits } = useBoardData();
  const setEdit = (on: boolean) => {
    onEditingChange?.(on);
    setEditing(on);
  };

  if (ghost) return <GhostCardBody ghost={ghost} />;

  if (!task) return null;
  // This task's phases + the pending edits on it, derived from the board maps.
  const { phases, edits: taskEdits = [] } = taskProposalProps(task, idx, ghosts, edits);
  if (editing) return <CardEditor task={task} phases={phases} onDone={() => setEdit(false)} />;
  const checked = selection.selected.has(task.id);
  const archiveProposed = taskEdits.some((e) => e.op === ProposalOp.Archive);
  // Terminal / archived → show the outcome cluster (badge + reopen + links) instead of
  // the launch actions; the old Archive pane, folded into the card.
  const terminal = isTerminal(task);
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-pm-card={task.id}
      data-pm-reveal={`t${task.id}`}
      className={highlight ? "pm-new-card" : undefined}
      bg={checked ? "dark.5" : undefined}
      style={{ boxShadow: checked ? SELECTED_SHADOW : undefined }}
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
      <Group justify="space-between" wrap="nowrap" mb="snug">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          {handle}
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          <KindBadge kind={task.kind} />
          <Text
            fw={500}
            size="md"
            truncate
            c={archiveProposed ? "dimmed" : undefined}
            td={archiveProposed ? "line-through" : undefined}
          >
            {task.title}
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          {/* Icon-only on the card: the color ring + glyph identify the repo without the
              name text crowding the title row (name shows on hover, and in full elsewhere). */}
          {repo && <RepoBadge repo={repo} showName={false} />}
          <Button
            size="compact-xs"
            variant="default"
            title="Edit title + phases together"
            style={{ flexShrink: 0 }}
            onClick={(e) => {
              e.stopPropagation();
              setEdit(true);
            }}
          >
            ✎ Edit
          </Button>
        </Group>
      </Group>
      {/* Free-form context, kept visually apart from the phases below — the
          description is the narrative, the phases are the pure work steps. */}
      {task.description && (
        <Text
          size="sm"
          c="dimmed"
          lineClamp={3}
          mb="snug"
          td={archiveProposed ? "line-through" : undefined}
          style={{ whiteSpace: "pre-wrap" }}
        >
          {task.description}
        </Text>
      )}
      {/* A proposed delete strikes the whole task — title and every phase. */}
      <PhaseList phases={phases} struck={archiveProposed} />
      {!selection.active && (
        <Group justify="flex-end" mt="cozy">
          {terminal ? <TaskOutcome task={task} /> : <TaskActions ids={[task.id]} />}
        </Group>
      )}
      <TaskProposalStrips task={task} showConflict />
    </Card>
  );
}
