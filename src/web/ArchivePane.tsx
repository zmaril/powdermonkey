import { Badge, Box, Group, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { Goal, Milestone, Task } from "../server/schema.ts";
import { TaskStatus } from "../shared/types.ts";
import { type Indexes, useArchiveData } from "./plan-data.ts";
import { IdTag, STATUS_COLOR, TaskLinks } from "./plan-ui.tsx";

// The Archive pane is the book of work — everything finished (merged) or archived.
// Read-only: no launch/land actions, just a browsable record with phase progress
// and links back to the session/PR. Same Flat / Grouped toggle as Active. It pulls
// the archived slice (?archived=true) on its own slow poll, separate from the live
// panes which never fetch archived rows.

type View = "flat" | "grouped";

/** One read-only archived/finished task row. */
function ArchiveRow({ task, context }: { task: Task; context?: string }) {
  const archived = task.archivedAt != null;
  // hover tooltip text, not the TaskStatus value
  const stateLabel = task.status === TaskStatus.Merged ? "merged" : "archived"; // lint-allow-string: tooltip
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      px="sm"
      py={6}
      style={{ borderBottom: "1px solid #2c2e33", minHeight: 38 }}
    >
      <Text size="sm" title={stateLabel}>
        {task.status === TaskStatus.Merged ? "✅" : "🗄️"}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <IdTag prefix="t" id={task.id} />
          <Text size="sm" fw={500} c="dimmed" truncate>
            {task.title}
          </Text>
        </Group>
        {context && (
          <Text size="xs" c="dimmed" truncate>
            {context}
          </Text>
        )}
      </Box>
      <Badge size="sm" variant="light" color={archived ? "gray" : STATUS_COLOR[task.status]}>
        {archived ? "archived" : task.status}
      </Badge>
      <TaskLinks task={task} />
    </Group>
  );
}

function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  // Newest first — the most recently finished work sits at the top.
  const ordered = [...tasks].sort((a, b) => b.id - a.id);
  return (
    <Stack gap={0}>
      {ordered.map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <ArchiveRow key={t.id} task={t} context={context} />;
      })}
    </Stack>
  );
}

function GroupedView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  const inArchive = new Set(tasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);
  const sections: { goal: Goal; milestone: Milestone; tasks: Task[] }[] = [];
  for (const goal of goals) {
    for (const m of idx.milestonesByGoal.get(goal.id) ?? []) {
      const ts = (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => inArchive.has(t.id));
      if (ts.length > 0) sections.push({ goal, milestone: m, tasks: ts });
    }
  }
  return (
    <Stack gap="lg">
      {sections.map(({ goal, milestone, tasks: ts }) => (
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
            {ts.map((t) => (
              <ArchiveRow key={t.id} task={t} />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function ArchivePane() {
  // Archived/finished work comes off the same live collections as everything else —
  // no separate fetch or poll.
  const { idx, tasks } = useArchiveData();
  const [view, setView] = useState<View>("flat");

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            ARCHIVE
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {tasks.length}
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
        {tasks.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            Nothing here yet. Tasks land in the archive once they're merged (finished) or archived.
          </Text>
        ) : view === "flat" ? (
          <FlatView tasks={tasks} idx={idx} />
        ) : (
          <GroupedView tasks={tasks} idx={idx} />
        )}
      </Box>
    </Box>
  );
}
