import { Badge, Button, Group, Text, UnstyledButton } from "@mantine/core";
import type { Task } from "../../server/schema.ts";
import { DecisionSource, TaskStatus } from "../../shared/types.ts";
import { useStore } from "../store.ts";

// How each decision source renders — a colour and a short "by …" label, so an
// operator can always tell a reconciled call (earned off `main`) from a by-hand one
// from a delegated one. `null` covers a row with no recorded decision yet.
const SOURCE_DESC: Record<DecisionSource, { color: string; by: string }> = {
  [DecisionSource.Reconciled]: { color: "green", by: "reconciled from main" },
  [DecisionSource.Operator]: { color: "orange", by: "by hand" },
  [DecisionSource.Supervisor]: { color: "violet", by: "via supervisor" },
};

/** Task-level override decisions — the won't-do / out-of-band / phase-less cases. A
 *  task closed by an override (merged or cancelled) shows who made the call and can be
 *  reopened; a reconciled-merged task is read-only (it belongs to `main`). A live
 *  task gets "Mark done" (close as finished) and "Won't do" (cancel). */
export function CompleteTaskControl({ task }: { task: Task }) {
  const { completeTask, cancelTask, reopenTask } = useStore();
  const source = task.decisionSource;

  // Terminal by an override → a provenance badge + reopen. Reconciled-merged is
  // owned by `main`, so nothing to do here.
  if (task.status === TaskStatus.Merged || task.status === TaskStatus.Cancelled) {
    if (!source || source === DecisionSource.Reconciled) return null;
    const desc = SOURCE_DESC[source];
    const cancelled = task.status === TaskStatus.Cancelled;
    const verb = cancelled ? "won't do" : "done"; // lint-allow-string: badge label, not the status value
    return (
      <Group gap="snug" wrap="nowrap">
        <Badge
          size="xs"
          color={cancelled ? "red" : desc.color}
          variant="light"
          title={`${cancelled ? "Cancelled" : "Closed"} ${desc.by} — not reconciled from main`}
        >
          {verb} · {desc.by}
        </Badge>
        <UnstyledButton onClick={() => reopenTask(task.id)} title="Reopen this task">
          <Text size="xs" c="dimmed">
            reopen
          </Text>
        </UnstyledButton>
      </Group>
    );
  }

  // Live task → close it by hand, as finished or as won't-do.
  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        size="compact-xs"
        variant="subtle"
        color="orange"
        title="Mark this task done by hand — for work that never landed a trailer on main"
        onClick={() => completeTask(task.id)}
      >
        Mark done
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        title="Close as won't-do — terminal, but not counted as done"
        onClick={() => {
          if (window.confirm("Close this task as won't-do? It moves to the archive as cancelled."))
            cancelTask(task.id);
        }}
      >
        Won't do
      </Button>
    </Group>
  );
}
