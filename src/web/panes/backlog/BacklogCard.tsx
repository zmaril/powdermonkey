import { Card, Group, Text } from "@mantine/core";
import type { Phase, Task } from "../../../server/schema.ts";
import { IdTag, PhaseList, StarToggle } from "../../plan-ui";
import { TaskActions } from "./TaskActions.tsx";
import { SELECTED_SHADOW } from "./constants.ts";
import type { Selection } from "./types.ts";

/** One backlog task card. Star + id + title on the left, actions on the right (hidden
 *  while a selection is live, so the batch bar owns them). Shift-click anywhere selects
 *  it (mousedown preventDefault stops the stray text-highlight); selected cards get an
 *  electric-blue glow. */
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
    <Card
      withBorder
      radius="md"
      padding="sm"
      data-pm-card={task.id}
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
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          <Text fw={500} truncate>
            {task.title}
          </Text>
        </Group>
        {!selection.active && <TaskActions ids={[task.id]} />}
      </Group>
      <PhaseList phases={phases} />
    </Card>
  );
}
