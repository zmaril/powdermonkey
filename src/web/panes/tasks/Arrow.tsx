import { Text } from "@mantine/core";
import { PROPOSED_TEXT_COLOR } from "./constants.ts";

/** The teal → connector between an old value and its replacement in the review preview. */
export function Arrow() {
  return (
    <Text component="span" size="xs" style={{ color: PROPOSED_TEXT_COLOR, marginInline: 4 }}>
      →
    </Text>
  );
}
