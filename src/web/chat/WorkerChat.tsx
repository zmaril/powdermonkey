// Worker chat: a live transcript of the operator↔worker conversation for a task,
// reconstructed from the task's action log and kept current over the WS feed.
// The composer sends to the worker via answer (if a question is pending) or
// comment — reusing the existing worker loop entirely (no new claude process).

import { ActionIcon, Box, Group, Paper, ScrollArea, Text, Textarea } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { ActionRecord } from "../../server/repo.ts";
import type { ActionName, TaskStatus } from "../../shared/types.ts";
import { api } from "../client.ts";
import { useBoard } from "../store.ts";

// Statuses where there's a live worker to talk to.
const TALKABLE: ReadonlySet<TaskStatus> = new Set([
  "launched",
  "working",
  "waiting_for_me",
  "needs_review",
  "blocked",
]);

// Fixed labels for actions that carry no summary.
const LABELS: Partial<Record<ActionName, string>> = {
  task_created: "Task created",
  task_launched: "Launched the worker",
  task_resumed: "Resumed the worker",
  session_started: "Worker session started",
  session_attached: "Worker session attached",
  claim_registered: "Claimed the task",
  operator_approved_review: "✓ Approved review",
  operator_marked_task_done: "Marked done",
  operator_abandoned_task: "Abandoned",
  artifact_attached: "Attached an artifact",
};

// Lifecycle/bookkeeping events render as centered system lines, not bubbles.
const SYSTEM_ACTIONS: ReadonlySet<ActionName> = new Set([
  "task_created",
  "task_launched",
  "task_resumed",
  "session_started",
  "session_attached",
  "claim_registered",
  "operator_approved_review",
  "operator_marked_task_done",
  "operator_abandoned_task",
]);

function classify(a: ActionRecord): "left" | "right" | "system" {
  if (SYSTEM_ACTIONS.has(a.action)) return "system";
  if (a.actor === "operator") return "right";
  if (a.actor === "worker") return "left";
  return "system";
}

function Msg({ a }: { a: ActionRecord }) {
  const side = classify(a);
  const text = a.summary ?? LABELS[a.action] ?? a.action.replace(/_/g, " ");
  if (side === "system") {
    return (
      <Text size="xs" c="dimmed" ta="center" my={8}>
        {text}
      </Text>
    );
  }
  const isOp = side === "right";
  return (
    <Box
      style={{
        display: "flex",
        justifyContent: isOp ? "flex-end" : "flex-start",
        marginBottom: 14,
      }}
    >
      <Paper bg={isOp ? "dark.5" : "dark.6"} px="md" py="sm" radius="lg" maw="80%">
        {!isOp && (
          <Text size="xs" c="dimmed" mb={2}>
            worker
          </Text>
        )}
        <Text
          size="sm"
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}
        >
          {text}
        </Text>
      </Paper>
    </Box>
  );
}

export function WorkerChat({ taskId }: { taskId: string }) {
  const task = useBoard((s) => s.board?.tasks.find((t) => t.id === taskId));
  const liveActions = useBoard((s) => s.actions);
  const answer = useBoard((s) => s.answer);
  const comment = useBoard((s) => s.comment);
  const [base, setBase] = useState<ActionRecord[] | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    let live = true;
    api.api
      .tasks({ id: taskId })
      .actions.get()
      .then(({ data }) => {
        if (live) setBase((data as unknown as ActionRecord[]) ?? []);
      });
    return () => {
      live = false;
    };
  }, [taskId]);

  const messages = useMemo(() => {
    const byId = new Map<string, ActionRecord>();
    for (const a of [...(base ?? []), ...liveActions.filter((x) => x.entityId === taskId)]) {
      byId.set(a.id, a);
    }
    return [...byId.values()].sort((x, y) => x.seq - y.seq);
  }, [base, liveActions, taskId]);

  const pending = task?.question != null && task.status === "waiting_for_me";
  const canTalk = task ? TALKABLE.has(task.status) : false;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (pending) void answer(taskId, t);
    else void comment(taskId, t);
    setText("");
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <ScrollArea style={{ flex: 1 }} px="md">
        <Box maw={760} mx="auto" w="100%" py="md">
          {base == null ? (
            <Text size="xs" c="dimmed">
              loading conversation…
            </Text>
          ) : messages.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" mt="xl">
              No worker activity yet.
            </Text>
          ) : (
            messages.map((a) => <Msg key={a.id} a={a} />)
          )}
        </Box>
      </ScrollArea>

      <Box maw={760} mx="auto" w="100%" px="md" pb="md" pt="xs">
        {canTalk ? (
          <>
            {pending && (
              <Text size="xs" c="yellow" mb={4}>
                The worker is waiting for your answer.
              </Text>
            )}
            <Group gap="xs" align="flex-end">
              <Textarea
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                placeholder={pending ? "Answer the worker…" : "Message the worker…"}
                autosize
                minRows={1}
                maxRows={6}
                style={{ flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <ActionIcon
                size="lg"
                radius="md"
                variant="filled"
                color="orange"
                onClick={send}
                aria-label="Send"
              >
                ↑
              </ActionIcon>
            </Group>
          </>
        ) : (
          <Text size="xs" c="dimmed" ta="center">
            {task?.status === "planned"
              ? "Launch the task to start its worker, then you can talk to it here."
              : "This task has no active worker."}
          </Text>
        )}
      </Box>
    </Box>
  );
}
