import { Group, Progress, Text } from "@mantine/core";
import type { Phase } from "../../server/schema.ts";
import { rollup } from "../progress.ts";

/** Compact done/total pill — for the dense rows where a full bar is too heavy. */
export function ProgressPill({ phases }: { phases: Phase[] }) {
  const { done, total, pct } = rollup(phases);
  return (
    <Group gap={6} wrap="nowrap" w={96}>
      <Progress value={pct} size="sm" radius="sm" style={{ flex: 1 }} />
      <Text size="xs" c="dimmed" w={34} ta="right" ff="monospace">
        {done}/{total}
      </Text>
    </Group>
  );
}
