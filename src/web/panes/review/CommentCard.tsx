import { Anchor, Box, Group, Text } from "@mantine/core";
import type { ReviewComment } from "../../../server/pr-review.ts";

export function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <Box
      px="sm"
      py={6}
      style={{ borderLeft: "2px solid #4c5568", background: "#202225", borderRadius: 4 }}
    >
      <Group gap={6} mb={2}>
        <Text size="xs" fw={700}>
          {comment.user}
        </Text>
        {comment.url && (
          <Anchor href={comment.url} target="_blank" size="xs" c="dimmed">
            ↗
          </Anchor>
        )}
      </Group>
      <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
        {comment.body}
      </Text>
    </Box>
  );
}
