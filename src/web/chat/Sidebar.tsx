// Left sidebar: navigation + attention. Logo, "Needs reviews" (the Inbox), the
// workspace tabs, the Goals ▸ task tree, and the user footer. The chat (New
// chat + Recents + conversation) lives in the right pane.

import { Avatar, Box, Group, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import { Logo } from "../Logo.tsx";
import { Archived, GoalsTree, Inbox } from "./Nav.tsx";
import { useView, View } from "./view.ts";

export function LeftSidebar() {
  const setView = useView((s) => s.setView);
  return (
    <Stack h="100%" gap={0} py="xs">
      <Group px="sm" pb="sm" gap="xs">
        <Logo size={22} />
        <Text fw={700} size="lg" style={{ fontFamily: "Georgia, serif" }}>
          PowderMonkey
        </Text>
      </Group>

      <Box px="xs" pb="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <NavLink
          label="Scratchpad"
          leftSection={<Text span>✎</Text>}
          onClick={() => setView(View.Scratchpad())}
        />
        <NavLink
          label="Workspaces"
          leftSection={<Text span>▦</Text>}
          onClick={() => setView(View.Workspaces())}
        />
      </Box>
      <ScrollArea style={{ flex: 1 }} scrollbarSize={6}>
        <Box pt="xs">
          <Inbox />
        </Box>
        <Box pt="md" pb="md">
          <GoalsTree />
        </Box>
        <Box pb="md">
          <Archived />
        </Box>
      </ScrollArea>

      <Group
        px="sm"
        pt="sm"
        gap="xs"
        style={{ borderTop: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Avatar color="orange" radius="xl" size="sm">
          Z
        </Avatar>
        <Box>
          <Text size="sm" fw={600}>
            Zack
          </Text>
          <Text size="xs" c="dimmed">
            Max plan
          </Text>
        </Box>
      </Group>
    </Stack>
  );
}
