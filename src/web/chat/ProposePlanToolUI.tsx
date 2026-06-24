// Tool-UI for the `propose_plan` tool call the assistant emits. Rendered inline
// in the chat as a Mantine card. Approve creates the goal on the board and kicks
// the supervisor — real PowderMonkey actions, visible live on the board.

import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { api } from "../client.ts";

interface PlanArgs {
  goalTitle: string;
  intent?: string;
}

export const ProposePlanToolUI = makeAssistantToolUI<PlanArgs, unknown>({
  toolName: "propose_plan",
  render: ({ args }) => {
    const [state, setState] = useState<"idle" | "working" | "done" | "rejected" | "error">("idle");
    const [err, setErr] = useState<string | null>(null);

    const approve = async () => {
      setState("working");
      try {
        const board = await api.api.board.get();
        const workspaceId = board.data?.workspaces?.[0]?.id;
        if (!workspaceId) {
          setErr("No workspace on the board yet — create one first.");
          setState("error");
          return;
        }
        const goal = await api.api.goals.post({
          workspaceId,
          title: args.goalTitle,
          intent: args.intent,
        });
        if (goal.data?.id) await api.api.goals({ id: goal.data.id }).plan.post();
        setState("done");
      } catch (e) {
        setErr(String(e));
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
          <Group gap="xs">
            <Badge color="orange" variant="light" size="sm">
              proposed plan
            </Badge>
          </Group>
          <Text fw={600} size="sm">
            {args.goalTitle}
          </Text>
          {args.intent && (
            <Text size="xs" c="dimmed">
              {args.intent}
            </Text>
          )}
          {state === "idle" && (
            <Group gap="xs" mt={4}>
              <Button size="xs" color="orange" onClick={approve}>
                Approve & plan
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => setState("rejected")}>
                Dismiss
              </Button>
            </Group>
          )}
          {state === "working" && (
            <Text size="xs" c="dimmed">
              Creating goal & starting the supervisor…
            </Text>
          )}
          {state === "done" && (
            <Text size="xs" c="teal">
              ✓ Goal created — the supervisor is planning. Watch the board’s Plans drawer.
            </Text>
          )}
          {state === "rejected" && (
            <Text size="xs" c="dimmed">
              Dismissed.
            </Text>
          )}
          {state === "error" && (
            <Text size="xs" c="red">
              {err}
            </Text>
          )}
        </Stack>
      </Card>
    );
  },
});
