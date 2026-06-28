import { Card, Group, Stack, Text } from "@mantine/core";
import type { Session, Task } from "../../../server/schema.ts";
import type { Indexes } from "../../plan-data.ts";
import { KIND_ICON, PrRow, SessionActions, SessionStateBadge } from "../../plan-ui";
import { ColumnLabel } from "./ColumnLabel.tsx";
import { TaskLine } from "./TaskLine.tsx";
import { contextOf, workerPrs } from "./grouping.ts";

/** One worker = one card. The header holds everything session-level (kind · state ·
 *  shared context · session link · Teleport · Stop); the task(s) the worker is
 *  running nest below. Single- and multi-task workers render the same way, so the
 *  pane is visually consistent. `showContext` puts the shared goal › milestone trail
 *  in the header (flat view); under grouped headings it's redundant, so it's off —
 *  and if a worker spans milestones, each task line carries its own context. */
export function WorkerCard({
  session,
  tasks,
  idx,
  showContext,
}: {
  session: Session;
  tasks: Task[];
  idx: Indexes;
  showContext: boolean;
}) {
  const contexts = showContext ? [...new Set(tasks.map((t) => contextOf(t, idx)))] : [];
  const sharedContext = contexts.length === 1 ? contexts[0] : undefined;
  const perTaskContext = contexts.length > 1;
  const prs = workerPrs(tasks, idx);
  return (
    <Card withBorder radius="md" padding="sm" bg="#1f2023">
      {/* Top: session status + controls, full width. */}
      <Group justify="space-between" wrap="nowrap" align="flex-start" mb={10}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" title={session.kind}>
            {KIND_ICON[session.kind]}
          </Text>
          <SessionStateBadge session={session} />
          {sharedContext && (
            <Text size="xs" c="dimmed" truncate>
              {sharedContext}
            </Text>
          )}
        </Group>
        <SessionActions session={session} taskId={tasks[0].id} />
      </Group>

      {/* Bottom: tasks, then their PRs below — single column so titles are readable. */}
      <Stack gap={10}>
        <Stack gap={6}>
          <ColumnLabel>Tasks</ColumnLabel>
          {tasks.map((t) => (
            <TaskLine
              key={t.id}
              task={t}
              context={perTaskContext ? contextOf(t, idx) : undefined}
            />
          ))}
        </Stack>
        <Stack gap={6}>
          <ColumnLabel>PRs</ColumnLabel>
          {prs.length === 0 ? (
            <Text size="xs" c="dimmed">
              none yet
            </Text>
          ) : (
            prs.map((pr) => <PrRow key={pr.number} pr={pr} />)
          )}
        </Stack>
      </Stack>
    </Card>
  );
}
