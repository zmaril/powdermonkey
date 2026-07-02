import { Group, Text } from "@mantine/core";

// The dot's fixed diameter — a decorative status glyph, not layout spacing, so it's a
// plain px dimension rather than a spacing token.
const DOT = 8;

/** The "agents running" half of the global bar: a status dot + live count. The dot
 *  reads busy (accent) vs. idle (dim) at a glance; the count is the number of live
 *  sessions across all repos (see runningAgentCount). */
export function AgentsBadge({ running }: { running: number }) {
  const busy = running > 0;
  return (
    <Group gap="snug" wrap="nowrap" align="center">
      <span
        aria-hidden
        style={{
          width: DOT,
          height: DOT,
          borderRadius: "50%",
          flex: "0 0 auto",
          background: busy ? "var(--pm-accent)" : "var(--pm-dim-text)",
        }}
      />
      <Text size="xs" fw={600} c={busy ? undefined : "dimmed"}>
        {running} running
      </Text>
    </Group>
  );
}
