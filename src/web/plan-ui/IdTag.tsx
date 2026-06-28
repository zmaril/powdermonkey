import { Text } from "@mantine/core";

/** A small monospace id chip (g1 / m6 / t110 / p41) so the operator can reference
 *  any entity by id. `flexShrink: 0` keeps it visible when a title truncates. */
export function IdTag({ prefix, id }: { prefix: string; id: number }) {
  return (
    <Text span c="dimmed" size="xs" ff="monospace" style={{ flexShrink: 0 }}>
      {prefix}
      {id}
    </Text>
  );
}
