// Tool-UI for the supervisor's `propose_scratchpad` call: a Mantine card showing
// the proposed note (append) or full rewrite (replace). Approve applies it.

import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";

interface SpArgs {
  mode?: "append" | "replace";
  content?: string;
}

export const ProposeScratchpadToolUI = makeAssistantToolUI<SpArgs, unknown>({
  toolName: "propose_scratchpad",
  render: ({ args }) => {
    const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
    const mode = args.mode === "replace" ? "replace" : "append";
    const content = args.content ?? "";

    const apply = async () => {
      setState("working");
      try {
        let next = content;
        if (mode === "append") {
          const cur = (await fetch("/api/scratchpad").then((r) => r.json())).content ?? "";
          next = cur ? `${cur}\n\n${content}` : content;
        }
        await fetch("/api/scratchpad", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: next }),
        });
        setState("done");
      } catch {
        setState("error");
      }
    };

    return (
      <Card
        withBorder
        radius="md"
        mt="xs"
        maw="92%"
        bg="dark.7"
        style={{ borderColor: "var(--mantine-color-orange-9)" }}
      >
        <Stack gap="xs">
          <Badge color="orange" variant="light" size="sm">
            scratchpad · {mode}
          </Badge>
          <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }} lineClamp={8}>
            {content}
          </Text>
          {state === "idle" && (
            <Group gap="xs" mt={4}>
              <Button size="xs" color="orange" onClick={apply}>
                {mode === "append" ? "Add to scratchpad" : "Replace scratchpad"}
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => setState("done")}>
                Dismiss
              </Button>
            </Group>
          )}
          {state === "working" && (
            <Text size="xs" c="dimmed">
              Saving…
            </Text>
          )}
          {state === "done" && (
            <Text size="xs" c="teal">
              ✓ Scratchpad updated.
            </Text>
          )}
          {state === "error" && (
            <Text size="xs" c="red">
              Failed to update.
            </Text>
          )}
        </Stack>
      </Card>
    );
  },
});
