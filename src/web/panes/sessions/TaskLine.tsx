import { Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { IdTag, StarToggle } from "../../plan-ui";

/** One task line inside a worker card's Tasks column: star · id · title · (context).
 *  Nothing session-level (kind/state/controls live in the header) and no PR — PRs
 *  get their own column on the right. */
export function TaskLine({ task, context }: { task: Task; context?: string }) {
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" data-pm-reveal={`t${task.id}`}>
      <StarToggle task={task} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap="snug" wrap="nowrap">
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
    </Group>
  );
}
