import { Badge, Box, Group, Text } from "@mantine/core";
import type { Task } from "../../../server/schema.ts";
import { TaskStatus } from "../../../shared/types.ts";
import { CompleteTaskControl, IdTag, STATUS_COLOR, TaskLinks } from "../../plan-ui";

/** One read-only archived/finished task row. */
export function ArchiveRow({ task, context }: { task: Task; context?: string }) {
  // Merged (finished) and cancelled (won't-do) are terminal *states* we name
  // outright; anything else with archived_at set is just "archived" (filed away).
  const merged = task.status === TaskStatus.Merged;
  const cancelled = task.status === TaskStatus.Cancelled;
  const terminal = merged || cancelled;
  const icon = merged ? "✅" : cancelled ? "🚫" : "🗄️";
  // hover tooltip text, not the TaskStatus value
  const stateLabel = merged ? "merged" : cancelled ? "cancelled" : "archived"; // lint-allow-string: tooltip
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="sm"
      py={6}
      style={{ borderBottom: "1px solid #2c2e33", minHeight: 38 }}
    >
      <Text size="sm" title={stateLabel}>
        {icon}
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
      <Badge size="sm" variant="light" color={terminal ? STATUS_COLOR[task.status] : "gray"}>
        {terminal ? task.status : "archived"}
      </Badge>
      {/* Override decisions show a provenance chip + reopen; reconciled ones render
          nothing here (they belong to main). */}
      {terminal && <CompleteTaskControl task={task} />}
      <TaskLinks task={task} />
    </Group>
  );
}
