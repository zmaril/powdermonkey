import { Anchor, Box, Group, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import type { ReviewComment } from "../../../server/pr-review.ts";
import { openExternal } from "../../open-external.ts";

export function CommentCard({ comment }: { comment: ReviewComment }) {
  return (
    <Box
      px="sm"
      py="snug"
      style={{
        borderLeft: "2px solid var(--pm-hairline)",
        background: "var(--pm-surface)",
        borderRadius: 4,
      }}
    >
      <Group gap="snug" mb="hair">
        <Text size="xs" fw={700}>
          {comment.user}
        </Text>
        {comment.url && (
          <Anchor
            href={comment.url}
            target="_blank"
            onClick={(e) => {
              e.preventDefault();
              openExternal(comment.url);
            }}
            c="dimmed"
            style={{ display: "inline-flex", lineHeight: 1 }}
          >
            <IconExternalLink size={13} />
          </Anchor>
        )}
      </Group>
      <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
        {comment.body}
      </Text>
    </Box>
  );
}
