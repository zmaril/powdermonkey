import { Card, Checkbox, Group, Text } from "@mantine/core";
import type { Phase, Task } from "../../../server/schema.ts";
import { IdTag, LaunchActions, PhaseList, StarToggle, TaskBadges, TaskLinks } from "../../plan-ui";
import type { Selection } from "./types.ts";

/** One backlog task card: a select checkbox + star, id + title + status, its phase
 *  checklist, and the single-task launch actions. Checking several cards reveals
 *  the batch bar that launches them together. */
export function BacklogCard({
  task,
  phases,
  selection,
}: {
  task: Task;
  phases: Phase[];
  selection: Selection;
}) {
  const checked = selection.selected.has(task.id);
  return (
    <Card withBorder radius="md" padding="sm" bg={checked ? "dark.5" : undefined}>
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Checkbox
            size="xs"
            checked={checked}
            onChange={() => selection.toggle(task.id)}
            aria-label={`Select ${task.title}`}
          />
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          <Text fw={500} truncate>
            {task.title}
          </Text>
        </Group>
        <TaskBadges task={task} />
      </Group>
      <PhaseList phases={phases} />
      <Group gap="xs" mt={10} justify="space-between">
        <LaunchActions taskId={task.id} />
        <TaskLinks task={task} />
      </Group>
    </Card>
  );
}
