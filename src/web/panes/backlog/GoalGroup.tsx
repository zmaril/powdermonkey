import { Group, Stack, Text, Title } from "@mantine/core";
import type { Goal } from "../../../server/schema.ts";
import { type Indexes, starFirst } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { BacklogCard } from "./BacklogCard.tsx";
import type { Selection } from "./types.ts";

/** A goal and its milestones, each milestone listing its backlog cards. Milestones
 *  with no backlog tasks are skipped; a goal with no remaining backlog renders
 *  nothing (its done work lives in the Archive pane). */
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
        <Group gap={8} wrap="nowrap" align="baseline">
          <IdTag prefix="g" id={goal.id} />
          <Title order={3}>{goal.title}</Title>
        </Group>
        {goal.objective && (
          <Text c="dimmed" size="sm" mt={4}>
            {goal.objective}
          </Text>
        )}
      </div>

      {milestones.map(({ m, tasks }) => (
        <Stack key={m.id} gap="xs">
          <Group gap={8} wrap="nowrap" align="baseline">
            <IdTag prefix="m" id={m.id} />
            <Title order={5}>{m.title}</Title>
          </Group>
          <Stack gap="xs">
            {tasks.map((t) => (
              <BacklogCard
                key={t.id}
                task={t}
                phases={idx.phasesByTask.get(t.id) ?? []}
                selection={selection}
              />
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
