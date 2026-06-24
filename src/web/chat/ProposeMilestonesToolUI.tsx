// Tool-UI for the supervisor's `propose_milestones` call: a Mantine card listing
// the proposed ordered milestones. Approve creates them (in order) under the
// goal this supervisor chat is bound to.

import { makeAssistantToolUI, useAui } from "@assistant-ui/react";
import { Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useBoard } from "../store.ts";

interface MsArgs {
  milestones?: (string | { title?: string; detail?: string })[];
}

function norm(x: string | { title?: string; detail?: string }): { title: string; detail?: string } {
  if (typeof x === "string") return { title: x };
  return { title: x?.title ?? String(x), detail: x?.detail };
}

export const ProposeMilestonesToolUI = makeAssistantToolUI<MsArgs, unknown>({
  toolName: "propose_milestones",
  render: ({ args }) => {
    const aui = useAui();
    const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
    const [err, setErr] = useState<string | null>(null);
    const items = (args.milestones ?? []).map(norm);

    const approve = async () => {
      setState("working");
      try {
        const remoteId = aui.threadListItem().getState().remoteId;
        const thread = remoteId
          ? await fetch(`/api/threads/${remoteId}`).then((r) => r.json())
          : null;
        const goalId = thread?.goalId;
        if (!goalId) {
          setErr('Open this from a goal’s "Chat with supervisor" so milestones have a goal.');
          setState("error");
          return;
        }
        for (const it of items) {
          await fetch(`/api/goals/${goalId}/milestones`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: it.title, detail: it.detail ?? null }),
          });
        }
        void useBoard.getState().load();
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
          <Badge color="orange" variant="light" size="sm">
            proposed milestones
          </Badge>
          {items.map((it, i) => (
            <Text key={`${i}-${it.title}`} size="sm">
              <Text span fw={600}>
                {i + 1}. {it.title}
              </Text>
              {it.detail && (
                <Text span c="dimmed">
                  {" "}
                  — {it.detail}
                </Text>
              )}
            </Text>
          ))}
          {state === "idle" && (
            <Group gap="xs" mt={4}>
              <Button size="xs" color="orange" onClick={approve}>
                Approve {items.length} milestone{items.length === 1 ? "" : "s"}
              </Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => setState("done")}>
                Dismiss
              </Button>
            </Group>
          )}
          {state === "working" && (
            <Text size="xs" c="dimmed">
              Creating milestones…
            </Text>
          )}
          {state === "done" && (
            <Text size="xs" c="teal">
              ✓ Added to the goal.
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
