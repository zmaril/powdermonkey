import { Anchor, Box, Button, Group, Stack, Textarea } from "@mantine/core";
import { useState } from "react";
import type { ReviewComment } from "../../../server/pr-review.ts";
import { CommentCard } from "./CommentCard.tsx";

/** One anchored thread: the root comment, its replies, and a reply composer. */
export function Thread({
  roots,
  repliesByParent,
  onReply,
  posting,
}: {
  roots: ReviewComment[];
  repliesByParent: Map<number, ReviewComment[]>;
  onReply: (inReplyTo: number, body: string) => Promise<void>;
  posting: boolean;
}) {
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <Stack gap="snug" px="md" py="snug" style={{ background: "var(--pm-surface)" }}>
      {roots.map((root) => {
        const replies = repliesByParent.get(root.id) ?? [];
        return (
          <Stack key={root.id} gap="tight">
            <CommentCard comment={root} />
            {replies.map((r) => (
              <Box key={r.id} pl="md">
                <CommentCard comment={r} />
              </Box>
            ))}
            {replyTo === root.id ? (
              <Box pl="md">
                <Textarea
                  autosize
                  minRows={2}
                  size="xs"
                  placeholder="Reply…"
                  value={draft}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                />
                <Group gap="snug" mt="tight">
                  <Button
                    size="compact-xs"
                    loading={posting}
                    disabled={!draft.trim()}
                    onClick={async () => {
                      await onReply(root.id, draft);
                      setDraft("");
                      setReplyTo(null);
                    }}
                  >
                    Reply
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => setReplyTo(null)}
                  >
                    Cancel
                  </Button>
                </Group>
              </Box>
            ) : (
              <Anchor component="button" size="xs" c="dimmed" onClick={() => setReplyTo(root.id)}>
                ↳ reply
              </Anchor>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
