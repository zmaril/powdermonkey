import { Button, Popover, Stack, Text } from "@mantine/core";
import { CommandRow } from "./CommandRow.tsx";

// "Attach" → a popover with the terminal command that opens the tmux dashboard
// (one pane per session + the server). The browser shell shows one agent at a
// time; this is how you watch the whole machine from your own terminal.
export function AttachButton() {
  return (
    <Popover width={300} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Button size="compact-xs" variant="default">
          Attach
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={8}>
          <Text size="xs" c="dimmed">
            Open the tmux dashboard in your terminal — one pane per live session, plus the server:
          </Text>
          <CommandRow cmd="powdermonkey attach" hint="installed globally (npm i -g powdermonkey)" />
          <CommandRow cmd="bun run attach" hint="from a checkout" />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
