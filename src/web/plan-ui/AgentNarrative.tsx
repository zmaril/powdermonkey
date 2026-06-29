import { Anchor, Box, Group, Text, UnstyledButton } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
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
    <Box pl="md">
      <Group gap="snug" wrap="nowrap" align="baseline">
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
            style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 3 }}
            title="The cloud session that authored this status"
          >
            session <IconExternalLink size={13} />
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
          mt="tight"
          p="cozy"
          style={{
            border: "1px solid var(--pm-hairline)",
            borderRadius: 4,
            background: "var(--pm-page-bg)",
          }}
        >
          <Text
            size="xs"
            c="dimmed"
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--mantine-font-family-monospace)",
            }}
          >
            {agent.body}
          </Text>
        </Box>
      )}
    </Box>
  );
}
