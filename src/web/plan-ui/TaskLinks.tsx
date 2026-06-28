import { Anchor, Group } from "@mantine/core";
import type { Task } from "../../server/schema.ts";

export function TaskLinks({ task }: { task: Task }) {
  return (
    <Group gap="md">
      {task.sessionUrl && (
        <Anchor href={task.sessionUrl} target="_blank" size="sm">
          session ↗
        </Anchor>
      )}
      {task.prUrl && (
        <Anchor href={task.prUrl} target="_blank" size="sm">
          PR ↗
        </Anchor>
      )}
    </Group>
  );
}
