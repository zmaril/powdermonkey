import { Box, Checkbox, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import {
  IdTag,
  LaunchActions,
  ProgressPill,
  StarToggle,
  TaskBadges,
  TaskLinks,
} from "../../plan-ui";
import type { Selection } from "./types.ts";

/** One dense backlog row for the flat view: select · star · id · title · context, a
 *  progress pill and status badges, with the launch actions below. Mirrors the
 *  Active flat row so the two panes read the same. */
export function BacklogRow({
  task,
  idx,
  context,
  selection,
}: {
  task: Task;
  idx: Indexes;
  context?: string;
  selection: Selection;
}) {
  const phases = idx.phasesByTask.get(task.id) ?? [];
  const checked = selection.selected.has(task.id);
  return (
    <Box
      px="sm"
      py={8}
      style={{ borderBottom: "1px solid #2c2e33", background: checked ? "#25262b" : undefined }}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Checkbox
          size="xs"
          checked={checked}
          onChange={() => selection.toggle(task.id)}
          aria-label={`Select ${task.title}`}
        />
        <StarToggle task={task} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <IdTag prefix="t" id={task.id} />
            <Text size="sm" fw={500} truncate>
              {task.title}
            </Text>
          </Group>
          {context && (
            <Text size="xs" c="dimmed" truncate>
              {context}
            </Text>
          )}
        </Box>
        {phases.length > 0 && <ProgressPill phases={phases} />}
        <TaskBadges task={task} />
      </Group>
      <Group gap="xs" wrap="wrap" justify="flex-end" mt={6}>
        <LaunchActions taskId={task.id} />
        <TaskLinks task={task} />
      </Group>
    </Box>
  );
}
