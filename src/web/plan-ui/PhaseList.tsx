import { List, Text, ThemeIcon } from "@mantine/core";
import type { Phase } from "../../server/schema.ts";
import { PhaseStatus } from "../../shared/types.ts";

export function PhaseList({ phases }: { phases: Phase[] }) {
  return (
    <List spacing={2} size="sm" center>
      {phases.map((p) => (
        <List.Item
          key={p.id}
          icon={
            <ThemeIcon
              color={p.status === PhaseStatus.Done ? "green" : "gray"}
              size={16}
              radius="xl"
            >
              <Text size="9px">{p.status === PhaseStatus.Done ? "✓" : "·"}</Text>
            </ThemeIcon>
          }
        >
          <Text
            size="sm"
            c={p.status === PhaseStatus.Done ? "dimmed" : undefined}
            td={p.status === PhaseStatus.Done ? "line-through" : undefined}
          >
            {p.name}{" "}
            <Text span c="dimmed" size="xs">
              #{p.id}
            </Text>
          </Text>
        </List.Item>
      ))}
    </List>
  );
}
