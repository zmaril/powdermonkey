import { Group, Progress, Text, Tooltip } from "@mantine/core";
import type { UsageWindow } from "../../../server/claude-usage.ts";

// One Claude usage window for the status bar — label · used-meter · percent, with the
// reset time on hover.

/** Compact "resets in 2h" for a window's reset time. Directional opposite of
 *  WorkerCard's `timeAgo` (that's past, this is future). Falsy/bad input → "soon". */
function resetsIn(iso: string | null): string {
  if (!iso) return "soon";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "soon";
  const s = Math.max(0, Math.round((then - Date.now()) / 1000));
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** Meter colour from the server-provided severity — subdued until the operator is
 *  actually close to a cap. Unknown severities read as normal. */
function severityColor(severity: string): string {
  if (severity === "warning") return "yellow";
  if (severity === "critical" || severity === "exceeded") return "red";
  return "blue";
}

export function UsageMeter({ window }: { window: UsageWindow }) {
  return (
    <Tooltip label={`${window.label} resets ${resetsIn(window.resetsAt)}`} withArrow>
      <Group gap="snug" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed">
          {window.label}
        </Text>
        <Progress
          value={window.percent}
          size="sm"
          radius="sm"
          w={64}
          color={severityColor(window.severity)}
        />
        <Text size="xs">{window.percent}%</Text>
      </Group>
    </Tooltip>
  );
}
