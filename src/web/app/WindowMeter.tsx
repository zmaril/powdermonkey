import { Group, Progress, Text, Tooltip } from "@mantine/core";
import type { UsageWindow } from "../../shared/types.ts";

// Fixed widths for the meter + its percent readout, so the windows line up in a tidy
// column rather than jittering with the number. Widths are layout dimensions, not
// spacing tokens (cf. ProgressPill), so they're plain px.
const METER_W = 44;
const PCT_W = 34;

/** Meter colour by how much of the window is spent: calm until it's nearly gone, then
 *  warn, then alarm — so a near-empty cap catches the eye without a number-read. Named
 *  Mantine palette colours (theme-driven), never raw hex. */
function meterColor(utilization: number): string {
  if (utilization >= 0.9) return "red";
  if (utilization >= 0.75) return "yellow";
  return "blue";
}

/** One rate-limit window as a labelled meter + percent, with the reset time in a
 *  tooltip. `utilization` is a 0..1 fraction; Mantine's Progress wants 0..100. */
export function WindowMeter({ window }: { window: UsageWindow }) {
  const pct = Math.round(window.utilization * 100);
  const reset = window.resetsAt
    ? `resets ${new Date(window.resetsAt).toLocaleString()}`
    : "no reset time";
  return (
    <Tooltip label={`${window.label} · ${pct}% used · ${reset}`} withArrow>
      <Group gap="tight" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed" ff="monospace">
          {window.label}
        </Text>
        <Progress
          value={window.utilization * 100}
          color={meterColor(window.utilization)}
          size="sm"
          radius="sm"
          w={METER_W}
        />
        <Text size="xs" ff="monospace" w={PCT_W} ta="right">
          {pct}%
        </Text>
      </Group>
    </Tooltip>
  );
}
