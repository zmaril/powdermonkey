import { Badge, Button, Card, Group, Text } from "@mantine/core";
import { IconArrowBackUp } from "@tabler/icons-react";
import type { Session } from "../../../server/schema.ts";
import { ackProgress } from "../../../shared/messages.ts";
import type { MailInfo } from "../../../shared/session-events.ts";
import { useSessionMessages } from "./useSessionMessages.ts";

/** An inbound worker→manager question rendered as a "needs a decision" card: visually
 *  distinct from the uniform feed row so it can't be scrolled past, carrying the worker's
 *  message and a Reply button that seeds the composer with `inReplyTo` = this message's id.
 *  The MailRef inlines no body (the text lives on the disponent Message row), so the card
 *  HYDRATES it off the read-only /messages route — degrading to the topic while the fetch
 *  is empty/pending, never blocking the feed render. When the question is a fan-out (its
 *  fanoutId spans several workers), a small "N of M acked" line rolls up how many have
 *  acknowledged. Reply only shows when a composer is mounted (`onReply` present) — a
 *  historical session's feed keeps the card read-only. */
export function MailCard({
  session,
  mail,
  onReply,
}: {
  session: Session;
  mail: MailInfo;
  onReply?: (mail: MailInfo) => void;
}) {
  // Poll the fan-out's Messages: one call serves both the body hydration (find this
  // message by id) and the ack-progress roll-up. Empty until the first response — the
  // body falls back to the ref's inlined text / topic in the meantime.
  const messages = useSessionMessages(session.id, mail.fanoutId);
  const hydrated = messages.find((m) => m.messageId === mail.messageId)?.body;
  const body =
    hydrated ||
    mail.body ||
    (mail.topic ? `topic: ${mail.topic}` : "The worker is asking for a decision.");
  // Only a genuine fan-out (more than one recipient) is worth a progress line; a lone
  // message would just read "1 / 1".
  const { acked, total } = ackProgress(messages);
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
        <Group gap="tight" wrap="nowrap" align="center">
          {total > 1 && (
            <Badge
              size="xs"
              color="grape"
              variant="light"
              title={`${acked} of ${total} fan-out recipients have acknowledged`}
            >
              {acked} / {total} acked
            </Badge>
          )}
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
      </Group>
      <Text size="xs" style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
        {body}
      </Text>
    </Card>
  );
}
