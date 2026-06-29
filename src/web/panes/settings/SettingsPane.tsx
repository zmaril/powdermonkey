import { Divider, Group, Stack, Text } from "@mantine/core";
import { CommandRow } from "./CommandRow.tsx";
import { NotifyControl } from "./NotifyControl.tsx";

// The Settings pane: cross-cutting controls that aren't tied to a particular task —
// desktop notifications and the tmux "attach" command. Opened from the top bar like
// any other pane.
export function SettingsPane() {
  return (
    <div
      style={{ height: "100%", background: "#1a1b1e", display: "flex", flexDirection: "column" }}
    >
      <Group px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          SETTINGS
        </Text>
      </Group>
      <Stack gap="lg" px="md" pb="md" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Notifications
          </Text>
          <NotifyControl />
        </Stack>
        <Divider />
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Attach
          </Text>
          <Text size="xs" c="dimmed">
            Open the tmux dashboard in your own terminal — one pane per live session, plus the
            server. The browser shell shows one agent at a time; this watches the whole machine.
          </Text>
          <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
          <CommandRow cmd="bun run attach" hint="from a checkout" />
        </Stack>
      </Stack>
    </div>
  );
}
