import { Text } from "@mantine/core";
import { Added } from "./Added.tsx";
import { PROPOSED_TEXT_COLOR } from "./constants.ts";
import type { ProseDiff } from "./preview.ts";
import { Removed } from "./Removed.tsx";

/** The task description / goal objective in its after-state: the incoming text in a teal
 *  wash when added or rewritten, the old text struck when cleared, plain when unchanged.
 *  Never clamped — a proposed rewrite must be readable in full before you accept it.
 *  Renders nothing when there's no text and no change, so the layout doesn't reserve a gap.
 *  `spacing` sets which side carries the gutter (a card's description sits above its
 *  phases → `mb`; a goal's objective sits below its title → `mt`). */
export function ProsePreview({
  diff,
  archived = false,
  size = "sm",
  spacing,
}: {
  diff: ProseDiff | undefined;
  archived?: boolean;
  size?: string;
  spacing?: { mt?: string; mb?: string };
}) {
  if (!diff) return null;
  const gap = { mt: spacing?.mt, mb: spacing?.mb };
  if (archived) {
    return diff.before ? (
      <Text {...gap} size={size} c="dimmed" td="line-through" style={{ whiteSpace: "pre-wrap" }}>
        {diff.before}
      </Text>
    ) : null;
  }
  if (diff.state === "same") {
    return diff.after ? (
      <Text {...gap} size={size} c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
        {diff.after}
      </Text>
    ) : null;
  }
  if (diff.state === "cleared") {
    return (
      <Text {...gap} size={size} style={{ whiteSpace: "pre-wrap" }}>
        <Removed>{diff.before}</Removed>
        <Text component="span" size="xs" style={{ color: PROPOSED_TEXT_COLOR, marginLeft: 6 }}>
          (cleared)
        </Text>
      </Text>
    );
  }
  // added / edited — highlight the incoming text as its own block.
  return (
    <Text {...gap} size={size} style={{ whiteSpace: "pre-wrap" }}>
      <Added block>{diff.after}</Added>
    </Text>
  );
}
