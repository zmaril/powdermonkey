import { Box, Text } from "@mantine/core";
import type { IDockviewPanelProps } from "dockview-react";
import { Markdown } from "../../markdown.tsx";
import { useReviewCtx } from "./context.ts";

/** Dockview panel: the PR title + description (the first column). */
export function DescriptionPanel(_props: IDockviewPanelProps) {
  const { review } = useReviewCtx();
  return (
    <Box
      style={{ height: "100%", overflowY: "auto", background: "var(--pm-pane-bg)" }}
      px="md"
      py="xs"
    >
      <Box style={{ fontWeight: 600, fontSize: "0.9375rem", color: "var(--pm-text)" }}>
        <Markdown source={review.title} inline />
      </Box>
      <Text size="xs" c="dimmed" mt="hair" mb="xs">
        #{review.number} · {review.state}
      </Text>
      {review.body ? (
        <Markdown source={review.body} />
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          No description.
        </Text>
      )}
    </Box>
  );
}
