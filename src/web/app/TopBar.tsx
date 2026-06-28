import { Button, Group, Text, Title } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { tasksCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { AttachButton } from "./AttachButton.tsx";
import { NotifyButton } from "./NotifyButton.tsx";

// Slim global toolbar: the app title, the cross-cutting actions (Shell / Scratch /
// Reconcile), and the error banner. Lives above the dockview so it's always visible
// regardless of which panel is focused.
export function TopBar() {
  const { error, reconcile, openTerminal, openNotes } = useStore();
  // "loading" until the first collection snapshot lands.
  const loading = useLiveQuery(() => tasksCollection).isLoading;
  return (
    <div style={{ flex: "0 0 auto", borderBottom: "1px solid #2c2e33", background: "#141517" }}>
      <Group justify="space-between" px="md" py={6} wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Title order={5}>PowderMonkey</Title>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
          {error && (
            <Text size="xs" c="red" truncate maw={420} title={error}>
              {error}
            </Text>
          )}
        </Group>
        <Group gap={6} wrap="nowrap">
          <NotifyButton />
          <Button size="compact-xs" variant="default" onClick={() => openTerminal("")}>
            Shell
          </Button>
          <AttachButton />
          <Button size="compact-xs" variant="default" onClick={openNotes}>
            Scratch
          </Button>
          <Button size="compact-xs" variant="default" onClick={reconcile}>
            Reconcile
          </Button>
        </Group>
      </Group>
    </div>
  );
}
