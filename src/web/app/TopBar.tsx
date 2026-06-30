import { Divider, Group, Text, Title } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { tasksCollection } from "../collections.ts";
import { useStore } from "../store.ts";
import { PaneButton } from "./PaneButton.tsx";

// Slim global toolbar: the app title, the error banner, and a launcher for every
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
          <PaneButton label="Active" onClick={() => openPane("active")} />
          <PaneButton label="Backlog" onClick={() => openPane("backlog")} />
          <PaneButton
            label="Archive"
            onClick={
              () => openPane("archive") /* lint-allow-string: pane id, not ProposalOp.Archive */
            }
          />
          <Divider orientation="vertical" />
          <PaneButton label="Shell" onClick={() => openTerminal("")} />
          <PaneButton label="Browser" onClick={() => openBrowser()} />
          <PaneButton label="Scratch" onClick={() => openPane("scratch")} />
          <Divider orientation="vertical" />
          <PaneButton label="Settings" onClick={() => openPane("settings")} />
          <PaneButton label="About" onClick={() => openPane("about")} />
          <PaneButton label="Help" onClick={() => openPane("help")} />
        </Group>
      </Group>
    </div>
  );
}
