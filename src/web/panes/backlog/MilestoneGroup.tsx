import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Button, Group, Stack, Title } from "@mantine/core";
import { useRef, useState } from "react";
import type { Milestone, Task } from "../../../server/schema.ts";
import { Decision, ProposalOp, VocabKind } from "../../../shared/types.ts";
import { type EntityEdit, type GroupedGhosts, editLabel, entityKey } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { useStore } from "../../store.ts";
import { BacklogCard } from "./BacklogCard.tsx";
import { CardEditor } from "./CardEditor.tsx";
import { Caret } from "./Caret.tsx";
import { ProposedStrip } from "./ProposedStrip.tsx";
import { ANIM_OPTS } from "./constants.ts";
import type { Selection } from "./types.ts";
import { useDecide } from "./useDecide.ts";

/** A milestone and its backlog cards, with a caret to collapse the lot. Pending proposal
 *  changes show in place: edits on the milestone itself (rename / delete) as strips on the
 *  header, new-task ghosts after the real cards, and per-task / per-phase changes on each
 *  card. */
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
  const { busy, decide } = useDecide();
  const [listRef, enableAnim] = useAutoAnimate(ANIM_OPTS);
  // Suspend the list animation while a card is being edited, so the card↔editor swap (and
  // the save back) is instant instead of morphing for 300ms. Re-enable a frame later so
  // the closing swap isn't animated either.
  const editingIds = useRef(new Set<number>());
  const setCardEditing = (id: number, on: boolean) => {
    if (on) {
      editingIds.current.add(id);
      enableAnim(false);
    } else {
      editingIds.current.delete(id);
      if (editingIds.current.size === 0) requestAnimationFrame(() => enableAnim(true));
    }
  };
  // Adding a task opens the same editor in the list — suspend the animation for it too,
  // via a sentinel id (real task ids are positive), so "+ Add task" → editor → save is
  // instant, not a 300ms morph.
  const ADDING = -1;
  const startAdding = () => {
    setCardEditing(ADDING, true);
    setAdding(true);
  };
  const stopAdding = () => {
    setCardEditing(ADDING, false);
    setAdding(false);
  };
  const milestoneEdits = edits.get(entityKey(VocabKind.Milestone, milestone.id)) ?? [];
  const archiveProposed = milestoneEdits.some((e) => e.op === ProposalOp.Archive);
  const taskGhosts = ghosts.tasksByMilestone.get(milestone.id) ?? [];

  return (
    <Stack gap="xs" ml={20}>
      <Group gap={6} wrap="nowrap" align="center">
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
      {milestoneEdits.map((e) => (
        <ProposedStrip
          key={`p${e.proposalId}-${e.changeIndex}`}
          label={editLabel(e)}
          hint={`From proposal P${e.proposalId}: ${e.proposalTitle}`}
          busy={busy}
          onAccept={() => decide(e.proposalId, e.changeIndex, Decision.Accept)}
          onReject={() => decide(e.proposalId, e.changeIndex, Decision.Reject)}
        />
      ))}
      {!collapsed && (
        <div ref={listRef} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tasks.map((t) => {
            const taskPhases = idx.phasesByTask.get(t.id) ?? [];
            return (
              <BacklogCard
                key={t.id}
                task={t}
                phases={taskPhases}
                selection={selection}
                edits={edits.get(entityKey(VocabKind.Task, t.id))}
                phaseGhosts={ghosts.phasesByTask.get(t.id)}
                phaseEdits={taskPhases.flatMap(
                  (p) => edits.get(entityKey(VocabKind.Phase, p.id)) ?? [],
                )}
                onEditingChange={(on) => setCardEditing(t.id, on)}
              />
            );
          })}
          {taskGhosts.map((g) => (
            <BacklogCard key={`p${g.proposalId}-${g.changeIndex}`} ghost={g} />
          ))}
          {adding ? (
            <CardEditor
              onCreate={(title, names) =>
                createTaskWithPhases(milestone.id, title, names, tasks.length)
              }
              onDone={stopAdding}
            />
          ) : (
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: "flex-start" }}
              onClick={startAdding}
            >
              + Add task
            </Button>
          )}
        </div>
      )}
    </Stack>
  );
}
