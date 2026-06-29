import { Anchor, Box, Group, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import type { AgentStatus } from "../../server/events.ts";

/** The agent's own narrative: the one-line summary (and `next`) always, with the full
 *  sticky-comment body one click away — the human-readable glance at what the agent
 *  thinks is happening, not just the parsed fields. Renders nothing until the worker
 *  has posted something. */
export function AgentNarrative({ agent }: { agent: AgentStatus }) {
  const [open, setOpen] = useState(false);
  if (!agent.summary && !agent.next && !agent.body) return null;
  const hasBody = agent.body.trim().length > 0;
  return (
    <Box pl={16}>
      <Group gap={6} wrap="nowrap" align="baseline">
        <Box style={{ flex: 1, minWidth: 0 }}>
          {agent.summary && (
            <Text size="xs" c="dimmed" title={agent.summary} truncate={!open}>
              {agent.summary}
            </Text>
          )}
          {agent.next && (
            <Text size="xs" c="dimmed" title={agent.next} truncate={!open}>
              → next: {agent.next}
            </Text>
          )}
        </Box>
        {agent.sessionUrl && (
          <Anchor
            href={agent.sessionUrl}
            target="_blank"
            size="xs"
            fw={500}
            style={{ flex: "0 0 auto" }}
            title="The cloud session that authored this status"
          >
            session ↗
          </Anchor>
        )}
        {hasBody && (
          <UnstyledButton onClick={() => setOpen((o) => !o)} style={{ flex: "0 0 auto" }}>
            <Text size="xs" c="blue.4">
              {open ? "hide" : "details"}
            </Text>
          </UnstyledButton>
        )}
      </Group>
      {open && hasBody && (
        <Box
          mt={4}
          p={8}
          style={{ border: "1px solid #2c2e33", borderRadius: 4, background: "#141517" }}
        >
          <Text
            size="xs"
            c="dimmed"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}
          >
            {agent.body}
          </Text>
        </Box>
      )}
    </Box>
  );
}
