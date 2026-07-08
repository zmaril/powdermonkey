import { Group, Stack, Text } from "@mantine/core";
import { PaneShell } from "./PaneShell.tsx";

// One pane type, described in a line. Keeps the Help pane's list declarative.
const PANES: { name: string; blurb: string }[] = [
  { name: "Active", blurb: "Live monitor of running sessions — status, actions, what needs you." },
  { name: "Backlog", blurb: "Launchpad: pick tasks and start them local or dispatch them remote." },
  { name: "Archive", blurb: "The book of work — finished and cancelled tasks." },
  { name: "Shell", blurb: "A live terminal — the supervisor, or attached to a session's agent." },
  { name: "Browser", blurb: "Load a dev server / preview in an iframe without leaving the app." },
  { name: "Scratch", blurb: "A notepad the supervisor reads when you say “check @notes”." },
  { name: "Settings", blurb: "Desktop notifications and the tmux attach command." },
  { name: "About", blurb: "What PowderMonkey is." },
];

// The Help pane: how the pane system works and what each pane is for. Opened from
// the top bar like any other pane.
export function HelpPane() {
  return (
    <PaneShell title="HELP" bodyGap="lg" bodyMaxWidth={620}>
      <Stack gap="snug">
        <Text size="sm" fw={600}>
          The pane system
        </Text>
        <Text size="sm" c="dimmed">
          Click a button in the top bar to open (or focus) that pane — it appears in the current
          group below. Drag a tab to move or split it, and close a pane with its ×. Your layout is
          remembered across reloads, and the top bar can always bring a closed pane back. Shell and
          Browser open a fresh pane each time; the rest have a single instance.
        </Text>
      </Stack>
      <Stack gap="snug">
        <Text size="sm" fw={600}>
          The panes
        </Text>
        <Stack gap="cozy">
          {PANES.map((p) => (
            <Group key={p.name} gap="cozy" wrap="nowrap" align="baseline">
              <Text size="sm" fw={600} style={{ flex: "0 0 76px" }}>
                {p.name}
              </Text>
              <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                {p.blurb}
              </Text>
            </Group>
          ))}
        </Stack>
      </Stack>
    </PaneShell>
  );
}
