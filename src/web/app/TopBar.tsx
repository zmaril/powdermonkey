import { Divider, Group, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { tasksCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { PaneButton } from "./PaneButton.tsx";

// Slim global toolbar: the wordmark, the error banner, and a launcher for every
// pane type. Click one and the pane appears (or comes forward) below — singletons
// focus their one instance, Shell/Browser open a fresh one each time. Lives above
// the dockview so it's always reachable regardless of which panel is focused.
export function TopBar() {
  const openPane = useStore((s) => s.openPane);
  const openTerminal = useStore((s) => s.openTerminal);
  const openBrowser = useStore((s) => s.openBrowser);
  const error = useStore((s) => s.error);
  // "loading" until the first collection snapshot lands.
  const loading = useLiveQuery(() => tasksCollection).isLoading;
  return (
    <div
      style={{
        flex: "0 0 auto",
        borderBottom: "1px solid var(--pm-hairline)",
        background: "var(--pm-tab-strip)",
      }}
    >
      <Group justify="space-between" px="md" py="cozy" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" align="baseline">
          <Text fw={650} size="md" style={{ letterSpacing: "-0.01em" }}>
            PowderMonkey
          </Text>
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
        <Group gap="hair" wrap="nowrap">
          <PaneButton label="Sessions" onClick={() => openPane("sessions")} />
          <PaneButton label="Tasks" onClick={() => openPane("tasks")} />
          <Divider orientation="vertical" my="tight" />
          <PaneButton label="Shell" onClick={() => openTerminal("")} />
          <PaneButton label="Browser" onClick={() => openBrowser()} />
          <PaneButton label="Scratch" onClick={() => openPane("scratch")} />
          <Divider orientation="vertical" my="tight" />
          <PaneButton label="Settings" onClick={() => openPane("settings")} />
          <PaneButton label="About" onClick={() => openPane("about")} />
          <PaneButton label="Help" onClick={() => openPane("help")} />
        </Group>
      </Group>
    </div>
  );
}
