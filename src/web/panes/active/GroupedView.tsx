import { Box, Group, Stack, Text, Title } from "@mantine/core";
import type { Goal, Milestone } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { starFirst } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { WorkerCard } from "./WorkerCard.tsx";
import { type SessionGrouping, groupBySession } from "./grouping.ts";

export function GroupedView({ activeIds, idx }: { activeIds: Set<number>; idx: Indexes }) {
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; groups: SessionGrouping[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const tasks = starFirst(
        (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => activeIds.has(t.id)),
      );
      if (tasks.length > 0)
        sections.push({ goal, milestone: m, groups: groupBySession(tasks, idx) });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, groups }) => (
        <Box key={milestone.id}>
          <Group gap="snug" wrap="nowrap" align="baseline">
            <IdTag prefix="g" id={goal.id} />
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {goal.title}
            </Text>
          </Group>
          <Group gap="cozy" wrap="nowrap" align="baseline" mb="snug">
            <IdTag prefix="m" id={milestone.id} />
            <Title order={5}>{milestone.title}</Title>
          </Group>
          <Stack gap="xs">
            {groups.map((g) => (
              <WorkerCard
                key={g.session.id}
                session={g.session}
                tasks={g.tasks}
                idx={idx}
                showContext={false}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
