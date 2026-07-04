import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Group, Stack, Title } from "@mantine/core";
import { useState } from "react";
import type { Milestone, Task } from "../../../server/schema.ts";
import { ProposalOp, VocabKind } from "../../../shared/types.ts";
import { type EntityEdit, entityKey, type GroupedGhosts, taskProposalProps } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { useStore } from "../../store.ts";
import { BacklogCard } from "./BacklogCard.tsx";
import { CardEditor } from "./CardEditor.tsx";
import { Caret } from "./Caret.tsx";
import { DragHandle } from "./DragHandle.tsx";
import { useReveal } from "./new-task.ts";
import { EditStrips } from "./proposal-strips.tsx";
import { cId, mId, tId } from "./reorder.ts";
import { SortableCard } from "./SortableCard.tsx";
import type { Selection } from "./types.ts";

/** A milestone and its backlog cards. The header drag-handle reorders the milestone within
 *  its goal; each card drags to reorder within the milestone or move to another. Pending
 *  proposal changes show in place: edits on the milestone itself (rename / delete) as
 *  strips on the header, new-task ghosts after the real cards, and per-task / per-phase
 *  changes on each card. Cards render in `position` order (the drag order) — see GoalGroup.
 *  The sortable card list drives its own motion through dnd-kit, so it doesn't use the
 *  shared list animation (the two would fight over the same DOM during a drag). */
export function MilestoneGroup({
  milestone,
  tasks,
  idx,
  selection,
  ghosts,
  edits,
}: {
  milestone: Milestone;
  tasks: Task[];
  idx: Indexes;
  selection: Selection;
  ghosts: GroupedGhosts;
  edits: Map<string, EntityEdit[]>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const { createTaskWithPhases } = useStore();
  const requestReveal = useReveal((s) => s.requestReveal);
  // The milestone is itself sortable within its goal's SortableContext (see GoalGroup).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mId(milestone.id),
    data: { type: VocabKind.Milestone },
  });
  // A droppable task area so a task can be dropped into this milestone even when it shows
  // no backlog cards.
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: cId(milestone.id) });
  const milestoneEdits = edits.get(entityKey(VocabKind.Milestone, milestone.id)) ?? [];
  const archiveProposed = milestoneEdits.some((e) => e.op === ProposalOp.Archive);
  const taskGhosts = ghosts.tasksByMilestone.get(milestone.id) ?? [];

  return (
    <Stack
      ref={setNodeRef}
      gap="xs"
      ml="lg"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <Group gap="snug" wrap="nowrap" align="center" data-pm-reveal={`m${milestone.id}`}>
        <DragHandle {...attributes} {...listeners} />
        <Caret
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          label={collapsed ? "Expand milestone" : "Collapse milestone"}
        />
        <IdTag prefix="m" id={milestone.id} />
        <Title
          order={5}
          c={archiveProposed ? "dimmed" : undefined}
          td={archiveProposed ? "line-through" : undefined}
        >
          {milestone.title}
        </Title>
      </Group>
      <EditStrips edits={milestoneEdits} />
      {!collapsed && (
        <Stack gap="xs">
          <SortableContext
            items={tasks.map((t) => tId(t.id))}
            strategy={verticalListSortingStrategy}
          >
            <Stack
              ref={dropRef}
              gap="xs"
              style={{
                minHeight: "var(--mantine-spacing-xs)",
                borderRadius: "var(--mantine-radius-sm)",
                outline: isOver ? "1px dashed var(--pm-accent)" : undefined,
              }}
            >
              {tasks.map((t) => (
                <SortableCard
                  key={t.id}
                  task={t}
                  selection={selection}
                  {...taskProposalProps(t, idx, ghosts, edits)}
                />
              ))}
            </Stack>
          </SortableContext>
          {taskGhosts.map((g) => (
            <BacklogCard key={`p${g.proposalId}-${g.changeIndex}`} ghost={g} />
          ))}
          {adding ? (
            <CardEditor
              onCreate={async (title, names, kind, description) => {
                const id = await createTaskWithPhases(milestone.id, title, names, tasks.length, {
                  kind,
                  description: description ?? undefined,
                });
                // Only a task YOU just added here earns an auto-scroll-into-view.
                if (id != null) requestReveal(id);
              }}
              onDone={() => setAdding(false)}
            />
          ) : (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setAdding(true)}
            >
              + Add task
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}
