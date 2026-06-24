// Message rendering: user messages in a subtle bubble, assistant/supervisor
// messages as full-width markdown via Streamdown (with shiki code highlighting),
// styled for the dark theme in markdown.css.

import {
  MessagePrimitive,
  type TextMessagePartComponent,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { Box, Paper, Text } from "@mantine/core";
import { code } from "./code-plugin.ts";

const UserText: TextMessagePartComponent = ({ text }) => (
  <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>
    {text}
  </Text>
);

const StreamdownText = () => (
  <StreamdownTextPrimitive plugins={{ code }} shikiTheme={["github-dark", "github-dark"]} />
);

function UserMessage() {
  return (
    <MessagePrimitive.Root>
      <Box style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <Paper bg="dark.5" px="md" py="sm" radius="lg" maw="80%">
          <MessagePrimitive.Parts components={{ Text: UserText }} />
        </Paper>
      </Box>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root>
      <Box mb="xl" className="pm-markdown">
        <MessagePrimitive.Parts components={{ Text: StreamdownText }} />
      </Box>
    </MessagePrimitive.Root>
  );
}

export function MessageList() {
  return <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />;
}
