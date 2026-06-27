import { Anchor, Badge, Box, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { Goal, Milestone, Task } from "../server/schema.ts";
import { partitionTasks } from "./active.ts";
import { type Indexes, usePlanData } from "./plan-data.ts";
import { IdTag, PrStatus, SessionActions, TaskBadges } from "./plan-ui.tsx";

// The Active pane is the live monitor — every task with a session running right
// now (the derived-active set; see active.ts). Two views, toggled:
//   • Flat   — one dense row per task, htop-style: the whole fleet at a glance.
//   • Grouped — the same rows nested under their goal → milestone.
// It re-renders off the same 4s poll as the rest of the app, so session state
// (running / Try Again / needs you) stays current without a refresh.

type View = "flat" | "grouped";

/** One active-task row. Two lines so nothing clips in a narrow pane: line 1 is
 *  the identity + status (icon · title/context · progress · badges), line 2 is the
 *  action cluster (branch · Shell · VS Code · Land · Stop), which wraps rather than
 *  overflow. `context` shows the goal › milestone trail in the flat view (redundant
 *  under headings in the grouped view, so it's omitted there). */
function ActiveRow({
  task,
  idx,
  context,
}: {
  task: Task;
  idx: Indexes;
  context?: string;
}) {
  const session = idx.sessionByTask.get(task.id);
  const pr = idx.prByTask.get(task.id);
  return (
    <Box px="sm" py={8} style={{ borderBottom: "1px solid #2c2e33" }}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Text size="sm" title={session?.kind}>
          {session?.kind === "remote" ? "☁️" : "💻"}
        </Text>
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
        <TaskBadges task={task} session={session} />
      </Group>
      {(session || task.prUrl) && (
        <Group gap="xs" wrap="wrap" justify="flex-end" mt={6}>
          {session && <SessionActions session={session} />}
          {task.prUrl && (
            <Anchor href={task.prUrl} target="_blank" size="sm" fw={500}>
              PR ↗
            </Anchor>
          )}
          {pr && <PrStatus pr={pr} />}
        </Group>
      )}
    </Box>
  );
}

function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  return (
    <Stack gap={0}>
      {tasks.map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <ActiveRow key={t.id} task={t} idx={idx} context={context} />;
      })}
    </Stack>
  );
}

function GroupedView({ activeIds, idx }: { activeIds: Set<number>; idx: Indexes }) {
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; tasks: Task[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const tasks = (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => activeIds.has(t.id));
      if (tasks.length > 0) sections.push({ goal, milestone: m, tasks });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, tasks }) => (
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
            {tasks.map((t) => (
              <ActiveRow key={t.id} task={t} idx={idx} />
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
