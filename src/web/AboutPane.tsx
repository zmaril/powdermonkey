import { Anchor, Group, Stack, Text, Title } from "@mantine/core";

// The About pane: what PowderMonkey is, in a sentence or two. Opened from the top
// bar like any other pane.
export function AboutPane() {
  return (
    <div
      style={{ height: "100%", background: "#1a1b1e", display: "flex", flexDirection: "column" }}
    >
      <Group px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
          ABOUT
        </Text>
      </Group>
      <Stack
        gap="md"
        px="md"
        pb="md"
        maw={620}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <Title order={4}>PowderMonkey</Title>
        <Text size="sm" c="dimmed">
          A single-operator tool for long-term solo development — a thin "single pane of glass" over{" "}
          <Text span ff="monospace" size="sm">
            claude --remote
          </Text>{" "}
          and local git worktrees, for orchestrating many coding agents at once.
        </Text>
        <Text size="sm" c="dimmed">
          Work is tracked as Goals → Milestones → Tasks → Phases and run as Sessions (a local
          worktree on{" "}
          <Text span ff="monospace" size="sm">
            pm/task-&lt;id&gt;
          </Text>
          , or a remote cloud run). The supervisor owns the desired plan and never executes work
          itself; progress is read off{" "}
          <Text span ff="monospace" size="sm">
            main
          </Text>{" "}
          from{" "}
          <Text span ff="monospace" size="sm">
            PM-Phase:
          </Text>{" "}
          commit trailers, so nothing self-reports.
        </Text>
        <Text size="sm" c="dimmed">
          Built for one person, one workspace — useful over elegant, with a deliberately short shelf
          life. See{" "}
          <Anchor href="https://github.com/zmaril/powdermonkey" target="_blank" size="sm">
            github.com/zmaril/powdermonkey
          </Anchor>{" "}
          for the design notes.
        </Text>
      </Stack>
    </div>
  );
}
