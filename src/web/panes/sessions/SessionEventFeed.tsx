import { Box, Group, Stack, Text } from "@mantine/core";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import type { Session, SessionEvent } from "../../../server/schema.ts";
import { describeSessionEvent } from "../../../shared/session-events.ts";
import { sessionEventsCollection } from "../../collections.ts";

/** The live event feed for a disponent-managed (Remote) session — the read half of
 *  Slice 4. It mirrors the session_events synced collection, filtered to this session
 *  and ordered by disponent's own event idx, and renders each row through the shared
 *  `describeSessionEvent` (the single source of display truth). A scraped terminal
 *  frame gets a monospace, whitespace-preserving block; everything else is a compact
 *  icon · label · text line. Empty until the poller drains disponent's stream. */
export function SessionEventFeed({ session }: { session: Session }) {
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
