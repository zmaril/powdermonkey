import { Button, Card, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Task } from "../../../server/schema.ts";
import { type Ghost, taskProposalProps } from "../../ghosts.ts";
import { IdTag, KindBadge, PhaseList, RepoBadge, StarToggle, useRepo } from "../../plan-ui";
import { useBoardData } from "./board-data-context.ts";
import { CardEditor } from "./CardEditor.tsx";
import { SELECTED_SHADOW } from "./constants.ts";
import { DecideControls } from "./DecideControls.tsx";
import { GhostCardBody } from "./GhostCardBody.tsx";
import { KindDiff } from "./KindDiff.tsx";
import { useHighlighted } from "./new-task.ts";
import { PreviewPhaseList } from "./PreviewPhaseList.tsx";
import { ProsePreview } from "./ProsePreview.tsx";
import { previewPhases, taskPreview } from "./preview.ts";
import { Rename } from "./Rename.tsx";
import { shiftSelectHandlers, useSelection } from "./selection-context.ts";
import { TaskActions } from "./TaskActions.tsx";
import { TaskDiary } from "./TaskDiary.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { isTerminal } from "./task-status.ts";

/** One backlog card. A real task: star + id + title with an Edit button top-right (the
 *  one way to edit — it opens the whole card as a craft block), its phases, and the
 *  launch/close action bar at the bottom. Shift-click selects. Pending proposal changes on
 *  it or its phases render IN PLACE as the card's proposed after-state — a renamed title
 *  shown old → new, a retagged kind, an added/rewritten description, added/removed/renamed
 *  phases — each with its own accept/reject, instead of a strip describing the change.
 *  When `ghost` is set it's a PROPOSED new task instead (see GhostCardBody). */
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
  // This task's phases + every pending change on it and its phases, derived from the
  // board maps: task-level edits, proposed new phases, and edits on existing phases.
  const {
    phases,
    edits: taskEdits = [],
    phaseGhosts = [],
    phaseEdits,
  } = taskProposalProps(task, idx, ghosts, edits);
  if (editing) return <CardEditor task={task} phases={phases} onDone={() => setEdit(false)} />;
  const checked = selection.selected.has(task.id);

  // The card's proposed after-state: title / kind / description with pending edits applied,
  // the phase checklist with adds/removes/renames spliced in, and the change handles that
  // drive per-change accept/reject.
  const preview = taskPreview(task, taskEdits);
  const phaseRows = previewPhases(phases, phaseEdits, phaseGhosts);
  const struck = preview.archived; // a proposed delete strikes the whole task
  const dim = struck ? "dimmed" : undefined;
  const strike = struck ? "line-through" : undefined;
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
      {...shiftSelectHandlers(selection, task.id)}
    >
      <Group justify="space-between" wrap="nowrap" mb="snug" align="flex-start">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }} align="baseline">
          {handle}
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          {struck ? (
            <KindBadge kind={task.kind} />
          ) : (
            <KindDiff
              before={preview.kind.before}
              after={preview.kind.after}
              changed={preview.kind.changed}
            />
          )}
          <Text fw={500} size="md" c={dim} td={strike} style={{ minWidth: 0 }}>
            {!struck && preview.title.changed ? (
              <Rename before={preview.title.before} after={preview.title.after} />
            ) : (
              task.title
            )}
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
      {/* Free-form context, kept visually apart from the phases below — the description is
          the narrative, the phases are the pure work steps. Shown in its after-state. */}
      <ProsePreview diff={preview.description} archived={struck} spacing={{ mb: "snug" }} />

      {/* The phase checklist, previewed: renames old → new, adds highlighted, deletes
          struck — each with its own accept/reject. A proposed task-delete strikes it all. */}
      {struck ? <PhaseList phases={phases} struck /> : <PreviewPhaseList rows={phaseRows} />}
      {/* The task's diary: comments in time order, with the one-line composer below. */}
      <TaskDiary taskId={task.id} />
      {!selection.active && (
        <Group justify="flex-end" mt="cozy">
          {terminal ? <TaskOutcome task={task} /> : <TaskActions ids={[task.id]} />}
        </Group>
      )}
      {/* Card-level changes (edit / delete / move the task itself) decided here; phase-level
          changes carry their own controls inline on the checklist above. */}
      {preview.changes.length > 0 && (
        <Group justify="flex-end" mt="cozy">
          <DecideControls changes={preview.changes} showConflict />
        </Group>
      )}
    </Card>
  );
}
