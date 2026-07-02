import { Badge, Group, Text, Tooltip } from "@mantine/core";
import type { ClaudeUsage } from "../../shared/types.ts";
import { WindowMeter } from "./WindowMeter.tsx";

/** The "Claude usage / limits" half of the global bar. Shows the plan tier (from the
 *  credentials, almost always known) plus a live meter per rate-limit window when the
 *  usage endpoint answered; degrades to a dimmed "usage unavailable" (reason in a
 *  tooltip) when the numbers can't be read — the vocabulary's "as the data is
 *  available". Renders a neutral placeholder until the first poll lands. */
export function UsageMeter({ usage }: { usage: ClaudeUsage | null }) {
  if (!usage) {
    return (
      <Text size="xs" c="dimmed">
        usage…
      </Text>
    );
  }
  const live = usage.available && usage.windows.length > 0;
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      {usage.subscriptionType && (
        <Tooltip label={usage.rateLimitTier ?? "Claude plan"} withArrow>
          <Badge size="xs" variant="light" radius="sm">
            {usage.subscriptionType}
          </Badge>
        </Tooltip>
      )}
      {live ? (
        usage.windows.map((w) => <WindowMeter key={w.label} window={w} />)
      ) : (
        <Tooltip label={usage.reason ?? "usage unavailable"} withArrow>
          <Text size="xs" c="dimmed">
            usage unavailable
          </Text>
        </Tooltip>
      )}
    </Group>
  );
}
