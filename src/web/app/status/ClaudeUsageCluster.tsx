import { Group, Text, Tooltip } from "@mantine/core";
import type { ClaudeUsage } from "../../../server/claude-usage.ts";
import { UsageMeter } from "./UsageMeter.tsx";

// The Claude-usage half of the status bar: the session (rolling 5-hour) and weekly
// windows as used-meters, or a dim note while loading / when there's no reading.

export function ClaudeUsageCluster({ usage }: { usage: ClaudeUsage | null }) {
  if (!usage) {
    return (
      <Text size="xs" c="dimmed">
        Claude usage…
      </Text>
    );
  }
  if (!usage.available) {
    return (
      <Tooltip label={usage.reason ?? "no reading"} withArrow>
        <Text size="xs" c="dimmed">
          Claude usage unavailable
        </Text>
      </Tooltip>
    );
  }
  // Lead with the two windows the operator watches — the rolling session cap and the
  // weekly cap — falling back to whatever the endpoint returned if those aren't named.
  const primary = usage.windows.filter((w) => w.key === "session" || w.key === "weekly_all");
  const windows = primary.length > 0 ? primary : usage.windows.slice(0, 2);
  if (windows.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Claude usage: no limits
      </Text>
    );
  }
  return (
    <Group gap="md" wrap="nowrap">
      {windows.map((w) => (
        <UsageMeter key={w.key} window={w} />
      ))}
    </Group>
  );
}
