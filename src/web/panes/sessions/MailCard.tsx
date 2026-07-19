import { Badge, Button, Card, Group, Text } from "@mantine/core";
import { IconArrowBackUp } from "@tabler/icons-react";
import type { MailInfo } from "../../../shared/session-events.ts";

/** An inbound worker→manager question rendered as a "needs a decision" card: visually
 *  distinct from the uniform feed row so it can't be scrolled past, carrying the worker's
 *  message (or its topic when the ref inlines no body) and a Reply button that seeds the
 *  composer with `inReplyTo` = this message's id. Reply only shows when a composer is
 *  mounted (`onReply` present) — a historical session's feed keeps the card read-only. */
export function MailCard({
  mail,
  onReply,
}: {
  mail: MailInfo;
  onReply?: (mail: MailInfo) => void;
}) {
  const body =
    mail.body || (mail.topic ? `topic: ${mail.topic}` : "The worker is asking for a decision.");
  return (
    <Card
      withBorder
      radius="sm"
      padding="xs"
      bg="dark.6"
      style={{ borderColor: "var(--mantine-color-grape-6)" }}
    >
      <Group justify="space-between" wrap="nowrap" align="center" mb="tight">
        <Group gap="tight" wrap="nowrap">
          <Badge size="xs" color="grape" variant="filled">
            needs a decision
          </Badge>
          <Text size="xs" c="dimmed">
            worker → manager
          </Text>
        </Group>
        {onReply && (
          <Button
            size="compact-xs"
            variant="light"
            color="grape"
            leftSection={<IconArrowBackUp size={13} />}
            onClick={() => onReply(mail)}
            title="Reply to the worker — prefills the composer, threaded to this question"
          >
            Reply
          </Button>
        )}
      </Group>
      <Text size="xs" style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
        {body}
      </Text>
    </Card>
  );
}
