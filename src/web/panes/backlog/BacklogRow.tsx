import { Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { IdTag, ProgressPill, StarToggle } from "../../plan-ui";
import { TaskActions } from "./TaskActions.tsx";
import { SELECTED_SHADOW } from "./constants.ts";
import type { Selection } from "./types.ts";

/** One dense backlog row for the flat view: star · id · title · context on the left,
 *  the same actions on the right. Shift-click selects; selected rows get the glow. */
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
      data-pm-card={task.id}
      style={{
        borderBottom: "1px solid #2c2e33",
        background: checked ? "#25262b" : undefined,
        boxShadow: checked ? SELECTED_SHADOW : undefined,
      }}
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
      <Group gap="sm" wrap="nowrap" align="center">
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
        {!selection.active && <TaskActions ids={[task.id]} />}
      </Group>
    </Box>
  );
}
