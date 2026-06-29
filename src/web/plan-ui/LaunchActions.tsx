import { Button, Group } from "@mantine/core";
import { useStore } from "../store.ts";

/** Launch actions for a backlog task (no live session yet). */
export function LaunchActions({ taskId }: { taskId: number }) {
  const { startLocal, dispatch, pending } = useStore();
  const startingLocal = pending[`start-local:${taskId}`] ?? false;
  const dispatching = pending[`dispatch:${taskId}`] ?? false;
  // Disable both while either is in flight so a task can't be launched twice; the one
  // that was clicked carries the spinner so it's clear which action is working.
  const busy = startingLocal || dispatching;
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="compact-xs"
        variant="light"
        loading={startingLocal}
        disabled={busy}
        onClick={() => startLocal(taskId)}
      >
        Start local
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        loading={dispatching}
        disabled={busy}
        onClick={() => dispatch(taskId)}
      >
        Dispatch remote
      </Button>
    </Group>
  );
}
