import { Anchor, Badge, Box, Group, Text } from "@mantine/core";
import type { DraftComment } from "./types.ts";

/** A drafted comment shown under its line before the review is submitted — a dashed
 *  amber card with a remove affordance, visually distinct from posted comments. */
export function PendingCard({ draft, onRemove }: { draft: DraftComment; onRemove: () => void }) {
  return (
    <Box px="md" py={6} style={{ background: "#1c1d20" }}>
      <Box
        px="sm"
        py={6}
        style={{ border: "1px dashed #b8893a", background: "#221d16", borderRadius: 4 }}
      >
        <Group justify="space-between" mb={2} wrap="nowrap">
          <Badge size="xs" variant="light" color="yellow">
            pending
          </Badge>
          <Anchor component="button" size="xs" c="dimmed" onClick={onRemove}>
            remove
          </Anchor>
        </Group>
        <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
          {draft.body}
        </Text>
      </Box>
    </Box>
  );
}
