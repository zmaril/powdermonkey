import { Button, Card, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState } from "react";
import type { Phase, Task } from "../../../server/schema.ts";
import { Decision, ProposalOp, TaskStatus } from "../../../shared/types.ts";
import { type EntityEdit, type Ghost, editLabel } from "../../ghosts.ts";
import { IdTag, PhaseList, StarToggle } from "../../plan-ui";
import { CardEditor } from "./CardEditor.tsx";
import { GhostCardBody } from "./GhostCardBody.tsx";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { TaskActions } from "./TaskActions.tsx";
import { TaskOutcome } from "./TaskOutcome.tsx";
import { SELECTED_SHADOW } from "./constants.ts";
import type { Selection } from "./types.ts";
import { useDecide } from "./useDecide.ts";

/** How a proposed edit on one of a task's phases reads — with the phase's own name. */
function phaseEditLabel(e: EntityEdit, phases: Phase[]): string {
  const name = phases.find((p) => p.id === e.id)?.name ?? "this phase"; // lint-allow-string: display fallback, not the VocabKind
  if (e.op === ProposalOp.Archive) return `Proposed: delete phase "${name}"`;
  if (e.op === ProposalOp.Update) return `Proposed: rename phase → "${e.newTitle ?? ""}"`;
  return editLabel(e);
}

/** One backlog card. A real task: star + id + title with an Edit button top-right (the
 *  one way to edit — it opens the whole card as a craft block), its phases, and the
 *  launch/close action bar at the bottom. Shift-click selects; pending proposal changes on
 *  it or its phases show as "Proposed: …" strips. When `ghost` is set it's a PROPOSED new
 *  task instead (see GhostCardBody). */
export function BacklogCard({
  task,
  phases = [],
  selection,
  ghost,
  edits = [],
  phaseGhosts = [],
  phaseEdits = [],
  onEditingChange,
}: {
  task?: Task;
  phases?: Phase[];
  selection?: Selection;
  ghost?: Ghost;
  edits?: EntityEdit[];
  phaseGhosts?: Ghost[];
  phaseEdits?: EntityEdit[];
  /** Told when this card enters/leaves edit mode, so the list can suspend its animation
   *  (the card<->editor swap shouldn't morph for 300ms — editing should feel instant). */
  onEditingChange?: (editing: boolean) => void;
}) {
  const { busy, conflict, decide } = useDecide();
  const [editing, setEditing] = useState(false);
  const setEdit = (on: boolean) => {
    onEditingChange?.(on);
    setEditing(on);
  };

  if (ghost) return <GhostCardBody ghost={ghost} />;

  if (!task || !selection) return null;
  if (editing) return <CardEditor task={task} phases={phases} onDone={() => setEdit(false)} />;
  const checked = selection.selected.has(task.id);
  const archiveProposed = edits.some((e) => e.op === ProposalOp.Archive);
  // Terminal / archived → show the outcome cluster (badge + reopen + links) instead of
  // the launch actions; the old Archive pane, folded into the card.
  const terminal =
    task.status === TaskStatus.Merged ||
    task.status === TaskStatus.Cancelled ||
    task.archivedAt != null;
  const proposed = (key: string, label: string, hint: string, proposalId: number, ix: number) => (
    <ProposedStrip
      key={key}
      label={label}
      hint={hint}
      busy={busy}
      onAccept={() => decide(proposalId, ix, Decision.Accept)}
      onReject={() => decide(proposalId, ix, Decision.Reject)}
    />
  );
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-pm-card={task.id}
      data-pm-reveal={`t${task.id}`}
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
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
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
      {/* A proposed delete strikes the whole task — title and every phase. */}
      <PhaseList phases={phases} struck={archiveProposed} />
      {!selection.active && (
        <Group justify="flex-end" mt="cozy">
          {terminal ? <TaskOutcome task={task} /> : <TaskActions ids={[task.id]} />}
        </Group>
      )}
      {edits.map((e) =>
        proposed(
          `p${e.proposalId}-${e.changeIndex}`,
          editLabel(e),
          `From proposal P${e.proposalId}: ${e.proposalTitle}`,
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {phaseGhosts.map((g) =>
        proposed(
          `p${g.proposalId}-${g.changeIndex}`,
          `Proposed: add phase "${g.title}"`,
          `From proposal P${g.proposalId}: ${g.proposalTitle}`,
          g.proposalId,
          g.changeIndex,
        ),
      )}
      {phaseEdits.map((e) =>
        proposed(
          `p${e.proposalId}-${e.changeIndex}`,
          phaseEditLabel(e, phases),
          `From proposal P${e.proposalId}: ${e.proposalTitle}`,
          e.proposalId,
          e.changeIndex,
        ),
      )}
      {conflict && (
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
    </Card>
  );
}
