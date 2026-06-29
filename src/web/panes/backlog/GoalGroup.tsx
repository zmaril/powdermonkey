import { Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { Goal } from "../../../server/schema.ts";
import { type Indexes, starFirst } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { Caret } from "./Caret.tsx";
import { MilestoneGroup } from "./MilestoneGroup.tsx";
import type { Selection } from "./types.ts";

/** A goal and its milestones. A caret collapses the whole goal. Milestones with no
 *  backlog tasks are skipped; a goal with no remaining backlog renders nothing. */
export function GoalGroup({
  goal,
  idx,
  backlog,
  selection,
}: {
  goal: Goal;
  idx: Indexes;
  backlog: Set<number>;
  selection: Selection;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const milestones = (idx.milestonesByGoal.get(goal.id) ?? [])
    .map((m) => ({
      m,
      tasks: starFirst((idx.tasksByMilestone.get(m.id) ?? []).filter((t) => backlog.has(t.id))),
    }))
    .filter(({ tasks }) => tasks.length > 0);

  if (milestones.length === 0) return null;

  return (
    <Stack gap="md">
      <div>
        <Group gap={8} wrap="nowrap" align="center">
          <Caret
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
            label={collapsed ? "Expand goal" : "Collapse goal"}
          />
          <IdTag prefix="g" id={goal.id} />
          <Title order={3}>{goal.title}</Title>
        </Group>
        {!collapsed && goal.objective && (
          <Text c="dimmed" size="sm" mt={4} ml={26}>
            {goal.objective}
          </Text>
        )}
      </div>

      {!collapsed &&
        milestones.map(({ m, tasks }) => (
          <MilestoneGroup key={m.id} milestone={m} tasks={tasks} idx={idx} selection={selection} />
        ))}
    </Stack>
  );
}
