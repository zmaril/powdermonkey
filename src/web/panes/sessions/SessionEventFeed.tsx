import { Badge, Box, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconArrowBackUp } from "@tabler/icons-react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import type { Session, SessionEvent } from "../../../server/schema.ts";
import {
  describeSessionEvent,
  MAIL_SENDER_WORKER,
  type MailInfo,
  parseMailEvent,
} from "../../../shared/session-events.ts";
import { sessionEventsCollection } from "../../collections.ts";

/** The live event feed for a disponent-managed (Remote) session — the read half of
 *  Slice 4. It mirrors the session_events synced collection, filtered to this session
 *  and ordered by disponent's own event idx, and renders each row through the shared
 *  `describeSessionEvent` (the single source of display truth). A scraped terminal
 *  frame gets a monospace, whitespace-preserving block; everything else is a compact
 *  icon · label · text line. An inbound worker→manager `mail` event breaks out of the
 *  uniform row into a "needs a decision" card with a Reply affordance (see MailCard) so
 *  a worker's question reads as a decision the operator owes. Empty until the poller
 *  drains disponent's stream. `onReply` (when a live composer is mounted) seeds it. */
export function SessionEventFeed({
  session,
  onReply,
}: {
  session: Session;
  onReply?: (mail: MailInfo) => void;
}) {
  const all = useLiveQuery(() => sessionEventsCollection);
  const events = useMemo(
    () =>
      (all.data ?? [])
        .filter((e: SessionEvent) => e.sessionId === session.id)
        .sort((a: SessionEvent, b: SessionEvent) => a.idx - b.idx),
    [all.data, session.id],
  );

  if (events.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        no events yet
      </Text>
    );
  }

  return (
    <Box style={{ maxHeight: 240, overflowY: "auto" }}>
      <Stack gap="hair">
        {events.map((e) => {
          const mail = parseMailEvent(e);
          // A worker→manager mail is an escalation: the manager owes it a decision, so it
          // gets the actionable card. Any other mail (manager→worker, →user) is just a
          // message line on the uniform render below.
          if (mail && mail.sender === MAIL_SENDER_WORKER) {
            return <MailCard key={e.id} mail={mail} onReply={onReply} />;
          }
          const d = describeSessionEvent(e);
          return (
            <Group key={e.id} gap="tight" wrap="nowrap" align="flex-start">
              <Text size="xs" c="dimmed" span title={d.label} style={{ flexShrink: 0 }}>
                {d.icon}
              </Text>
              {d.mono ? (
                <Text
                  size="xs"
                  ff="monospace"
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0 }}
                >
                  {d.text}
                </Text>
              ) : (
                <Text size="xs" style={{ minWidth: 0, wordBreak: "break-word" }}>
                  <Text size="xs" c="dimmed" span mr="tight">
                    {d.label}
                  </Text>
                  {d.text}
                </Text>
              )}
            </Group>
          );
        })}
      </Stack>
    </Box>
  );
}

/** An inbound worker→manager question rendered as a "needs a decision" card: visually
 *  distinct from the uniform row so it can't be scrolled past, carrying the worker's
 *  message (or its topic when the ref inlines no body) and a Reply button that seeds the
 *  composer with `inReplyTo` = this message's id. Reply only shows when a composer is
 *  mounted (`onReply` present) — a historical session's feed keeps the card read-only. */
function MailCard({ mail, onReply }: { mail: MailInfo; onReply?: (mail: MailInfo) => void }) {
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
