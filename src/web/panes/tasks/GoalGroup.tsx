import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { Goal, Milestone, Task } from "../../../server/schema.ts";
import { ProposalOp, VocabKind } from "../../../shared/types.ts";
import { type EntityEdit, entityKey, type GroupedGhosts } from "../../ghosts.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { Caret } from "./Caret.tsx";
import { GhostHeader } from "./GhostHeader.tsx";
import { MilestoneGroup } from "./MilestoneGroup.tsx";
import { EditStrips } from "./proposal-strips.tsx";
import { mId, type Reorder } from "./reorder.ts";
import type { Selection } from "./types.ts";

/** A goal and its milestones. A caret collapses the whole goal. Edits on the goal itself
 *  (rename / delete) show as strips on its header; proposed new milestones render as ghost
 *  blocks. A milestone shows when it has backlog tasks, task-ghosts, or its own edits; a
 *  goal with nothing to show renders nothing. */
export function GoalGroup({
  goal,
  idx,
  backlog,
  selection,
  ghosts,
  edits,
  reorder,
}: {
  goal: Goal;
  idx: Indexes;
  backlog: Set<number>;
  selection: Selection;
  ghosts: GroupedGhosts;
  edits: Map<string, EntityEdit[]>;
  reorder: Reorder;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const goalEdits = edits.get(entityKey(VocabKind.Goal, goal.id)) ?? [];
  const goalArchive = goalEdits.some((e) => e.op === ProposalOp.Archive);
  const ghostMilestones = ghosts.milestonesByGoal.get(goal.id) ?? [];

  // Order milestones (and each milestone's tasks) by the live drag order — pure
  // `position` order, not star-first, so a drag maps one-to-one onto stored positions.
  // (Stars still float tasks to the top of the flat launch list; here they're a marker.)
  const milestones = reorder
    .milestoneOrder(goal.id)
    .map((id) => idx.milestoneById.get(id))
    .filter((m): m is Milestone => m != null)
    .map((m) => ({
      m,
      tasks: reorder
        .taskOrder(m.id)
        .filter((id) => backlog.has(id))
        .map((id) => reorder.taskById(id))
        .filter((t): t is Task => t != null),
    }))
    .filter(
      ({ m, tasks }) =>
        tasks.length > 0 ||
        // An EMPTY milestone (no tasks at all — e.g. one you just created) shows, so it
        // doesn't vanish the moment it's accepted; a DRAINED one (had tasks, now all
        // done) stays hidden — that's the graveyard we prune.
        (idx.tasksByMilestone.get(m.id)?.length ?? 0) === 0 ||
        (ghosts.tasksByMilestone.get(m.id)?.length ?? 0) > 0 ||
        (edits.get(entityKey(VocabKind.Milestone, m.id))?.length ?? 0) > 0,
    );

  if (milestones.length === 0 && ghostMilestones.length === 0 && goalEdits.length === 0) {
    return null;
  }

  return (
    <Stack gap="md">
      <div data-pm-reveal={`g${goal.id}`}>
        <Group gap="cozy" wrap="nowrap" align="center">
          <Caret
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            label={collapsed ? "Expand goal" : "Collapse goal"}
          />
          <IdTag prefix="g" id={goal.id} />
          <Title
            order={3}
            c={goalArchive ? "dimmed" : undefined}
            td={goalArchive ? "line-through" : undefined}
          >
            {goal.title}
          </Title>
        </Group>
        {!collapsed && goal.objective && (
          <Text
            c="dimmed"
            size="sm"
            mt="tight"
            ml={26} // lint-allow-spacing: alignment offset under the caret + id, not a density step
          >
            {goal.objective}
          </Text>
        )}
        <EditStrips edits={goalEdits} />
      </div>

      {!collapsed && (
        <SortableContext
          items={milestones.map(({ m }) => mId(m.id))}
          strategy={verticalListSortingStrategy}
        >
          {milestones.map(({ m, tasks }) => (
            <MilestoneGroup
              key={m.id}
              milestone={m}
              tasks={tasks}
              idx={idx}
              selection={selection}
              ghosts={ghosts}
              edits={edits}
            />
          ))}
        </SortableContext>
      )}
      {!collapsed &&
        ghostMilestones.map((g) => (
          <div key={`p${g.proposalId}-${g.changeIndex}`} style={{ marginLeft: 20 }}>
            <GhostHeader ghost={g} />
          </div>
        ))}
    </Stack>
  );
}
