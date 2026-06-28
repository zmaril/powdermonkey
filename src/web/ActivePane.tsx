import { Anchor, Badge, Box, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { Goal, Milestone, Session, Task } from "../server/schema.ts";
import { partitionTasks } from "./active.ts";
import { type Indexes, starFirst, usePlanData } from "./plan-data.ts";
import { IdTag, KIND_ICON, PrStatus, SessionActions, StarToggle, TaskBadges } from "./plan-ui.tsx";

// The Active pane is the live monitor — every task with a session running right
// now (the derived-active set; see active.ts). The unit here is the SESSION, not
// the task: one worker can be dispatched for several tasks at once (the
// session_tasks join), so those tasks are grouped under their shared session and
// the session's controls (Shell · VS Code · Land · Stop) appear once for the whole
// group. Two views, toggled:
//   • Flat   — session groups in one dense list, htop-style.
//   • Grouped — the same groups nested under goal → milestone.
// It re-renders off the same WebSocket change feed as the rest of the app, so
// session state (running / Try Again / needs you) stays current without a refresh.

type View = "flat" | "grouped";

type SessionGrouping = { session: Session; tasks: Task[] };

/** Group active tasks by the live session they share, preserving input order (so a
 *  star-first list stays star-first). Every active task has a session — the active
 *  set is derived from sessions — but a task whose session somehow doesn't resolve
 *  is skipped rather than rendered sessionless. */
function groupBySession(tasks: Task[], idx: Indexes): SessionGrouping[] {
  const groups = new Map<number, SessionGrouping>();
  const order: number[] = [];
  for (const t of tasks) {
    const session = idx.sessionByTask.get(t.id);
    if (!session) continue;
    let g = groups.get(session.id);
    if (!g) {
      g = { session, tasks: [] };
      groups.set(session.id, g);
      order.push(session.id);
    }
    g.tasks.push(t);
  }
  return order.map((id) => groups.get(id) as SessionGrouping);
}

/** One task line inside a session group: star · id · title · (context) · badges ·
 *  PR. No session controls here — those belong to the group, not the task. */
function TaskLine({
  task,
  session,
  idx,
  context,
}: {
  task: Task;
  session: Session;
  idx: Indexes;
  context?: string;
}) {
  const pr = idx.prByTask.get(task.id);
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start">
      <StarToggle task={task} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <IdTag prefix="t" id={task.id} />
          <Text size="sm" fw={500} truncate>
            {task.title}
          </Text>
        </Group>
        {context && (
          <Text size="xs" c="dimmed" truncate>
            {context}
          </Text>
        )}
      </Box>
      <TaskBadges task={task} session={session} showStatus={false} />
      {task.prUrl && (
        <Anchor href={task.prUrl} target="_blank" size="sm" fw={500}>
          PR ↗
        </Anchor>
      )}
      {pr && <PrStatus pr={pr} />}
    </Group>
  );
}

/** One session group: the task(s) the worker is running, then a single action
 *  cluster (branch · Shell · VS Code · Teleport · Land · Stop) for the session.
 *  A multi-task group gets a left accent + a "N tasks · one worker" caption so it
 *  reads as a single unit. `showContext` adds the goal › milestone trail to each
 *  task line (on in the flat view, off under grouped headings where it's redundant). */
function SessionGroup({
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
  const multi = tasks.length > 1;
  return (
    <Box
      px="sm"
      py={8}
      style={{
        borderBottom: "1px solid #2c2e33",
        borderLeft: multi ? "2px solid #4c5568" : undefined,
      }}
    >
      <Stack gap={6}>
        {tasks.map((t) => {
          const m = idx.milestoneById.get(t.milestoneId);
          const g = m ? idx.goalById.get(m.goalId) : undefined;
          const context = showContext
            ? [g?.title, m?.title].filter(Boolean).join(" › ")
            : undefined;
          return <TaskLine key={t.id} task={t} session={session} idx={idx} context={context} />;
        })}
      </Stack>
      <Group gap="xs" wrap="wrap" justify="space-between" align="center" mt={8}>
        <Text size="xs" c="dimmed">
          {KIND_ICON[session.kind]}
          {multi ? ` ${tasks.length} tasks · one worker` : ""}
        </Text>
        <SessionActions session={session} taskId={tasks[0].id} />
      </Group>
    </Box>
  );
}

function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  const groups = groupBySession(starFirst(tasks), idx);
  return (
    <Stack gap={0}>
      {groups.map((g) => (
        <SessionGroup
          key={g.session.id}
          session={g.session}
          tasks={g.tasks}
          idx={idx}
          showContext
        />
      ))}
    </Stack>
  );
}

function GroupedView({ activeIds, idx }: { activeIds: Set<number>; idx: Indexes }) {
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; groups: SessionGrouping[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const tasks = starFirst(
        (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => activeIds.has(t.id)),
      );
      if (tasks.length > 0)
        sections.push({ goal, milestone: m, groups: groupBySession(tasks, idx) });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, groups }) => (
        <Box key={milestone.id}>
          <Group gap={6} wrap="nowrap" align="baseline">
            <IdTag prefix="g" id={goal.id} />
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {goal.title}
            </Text>
          </Group>
          <Group gap={8} wrap="nowrap" align="baseline" mb={4}>
            <IdTag prefix="m" id={milestone.id} />
            <Title order={5}>{milestone.title}</Title>
          </Group>
          <Stack gap={0}>
            {groups.map((g) => (
              <SessionGroup
                key={g.session.id}
                session={g.session}
                tasks={g.tasks}
                idx={idx}
                showContext={false}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function ActivePane() {
  const { idx, activeIds } = usePlanData();
  const [view, setView] = useState<View>("flat");

  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { active } = partitionTasks(allTasks, activeIds);

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            ACTIVE
          </Text>
          <Badge size="sm" variant="light" color={active.length > 0 ? "blue" : "gray"}>
            {active.length}
          </Badge>
        </Group>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as View)}
          data={[
            { label: "Flat", value: "flat" },
            { label: "Grouped", value: "grouped" },
          ]}
        />
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }} px={view === "grouped" ? "md" : 0} py={4}>
        {active.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            Nothing active. Launch a task from the Backlog (Start local / Dispatch remote, or "/" →
            Start local on a new line) and it shows up here.
          </Text>
        ) : view === "flat" ? (
          <FlatView tasks={active} idx={idx} />
        ) : (
          <GroupedView activeIds={activeIds} idx={idx} />
        )}
      </Box>
    </Box>
  );
}
