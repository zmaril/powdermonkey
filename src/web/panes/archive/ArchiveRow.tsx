import { Badge, Box, Group, Text } from "@mantine/core";
import { IconArchive, IconBan, IconCircleCheck } from "@tabler/icons-react";
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
  const StateIcon = merged ? IconCircleCheck : cancelled ? IconBan : IconArchive;
  const iconColor = merged
    ? "var(--mantine-color-green-5)"
    : cancelled
      ? "var(--mantine-color-red-5)"
      : "var(--mantine-color-dimmed)";
  // hover tooltip text, not the TaskStatus value
  const stateLabel = merged ? "merged" : cancelled ? "cancelled" : "archived"; // lint-allow-string: tooltip
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="sm"
      py="snug"
      style={{ borderBottom: "1px solid var(--pm-hairline)", minHeight: 38 }}
    >
      <StateIcon size={16} title={stateLabel} color={iconColor} style={{ flexShrink: 0 }} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap="snug" wrap="nowrap">
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
