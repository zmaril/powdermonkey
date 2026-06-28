import { Badge, Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { TaskStatus } from "../../../shared/types.ts";
import { IdTag, STATUS_COLOR, TaskLinks } from "../../plan-ui";

/** One read-only archived/finished task row. */
export function ArchiveRow({ task, context }: { task: Task; context?: string }) {
  const archived = task.archivedAt != null;
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="sm"
      py={6}
      style={{ borderBottom: "1px solid #2c2e33", minHeight: 38 }}
    >
      <Text size="sm" title={task.status === TaskStatus.Merged ? "merged" : "archived"}>
        {task.status === TaskStatus.Merged ? "✅" : "🗄️"}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <IdTag prefix="t" id={task.id} />
          <Text size="sm" fw={500} c="dimmed" truncate>
            {task.title}
          </Text>
        </Group>
        {context && (
          <Text size="xs" c="dimmed" truncate>
            {context}
          </Text>
        )}
      </Box>
      <Badge size="sm" variant="light" color={archived ? "gray" : STATUS_COLOR[task.status]}>
        {archived ? "archived" : task.status}
      </Badge>
      <TaskLinks task={task} />
    </Group>
  );
}
