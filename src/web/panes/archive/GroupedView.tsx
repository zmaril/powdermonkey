import { Box, Group, Stack, Text, Title } from "@mantine/core";
import type { Goal, Milestone, Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag } from "../../plan-ui";
import { ArchiveRow } from "./ArchiveRow.tsx";

export function GroupedView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  const inArchive = new Set(tasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; tasks: Task[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const ts = (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => inArchive.has(t.id));
      if (ts.length > 0) sections.push({ goal, milestone: m, tasks: ts });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, tasks: ts }) => (
        <Box key={milestone.id}>
          <Group gap={6} wrap="nowrap" align="baseline">
            <IdTag prefix="g" id={goal.id} />
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {goal.title}
            </Text>
          </Group>
          <Group gap={8} wrap="nowrap" align="baseline" mb={4}>
            <IdTag prefix="m" id={milestone.id} />
            <Title order={5}>{milestone.title}</Title>
          </Group>
          <Stack gap={0}>
            {ts.map((t) => (
              <ArchiveRow key={t.id} task={t} />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
