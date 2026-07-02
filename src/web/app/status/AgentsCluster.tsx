import { Box, Group, Text } from "@mantine/core";

// The agents-running half of the status bar: a status dot + count, dimmed when
// nothing's running.

export function AgentsCluster({ running }: { running: number }) {
  const live = running > 0;
  return (
    <Group gap="snug" wrap="nowrap" align="center">
      <Box
        w={8}
        h={8}
        style={{
          borderRadius: "50%",
          background: live ? "var(--pm-accent)" : "var(--pm-dim-text)",
        }}
      />
      <Text size="xs" c={live ? undefined : "dimmed"}>
        {live ? `${running} agent${running === 1 ? "" : "s"} running` : "no agents running"}
      </Text>
    </Group>
  );
}
