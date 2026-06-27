import {
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type { Goal, Phase, Task } from "../server/schema.ts";
import { partitionTasks } from "./active.ts";
import { type Indexes, starFirst, usePlanData } from "./plan-data.ts";
import {
  IdTag,
  LaunchActions,
  PhaseList,
  ProgressPill,
  StarToggle,
  TaskBadges,
  TaskLinks,
} from "./plan-ui.tsx";
import { useStore } from "./store.ts";

// The Backlog pane is the launchpad — everything to-be-worked (not active),
// grouped goal → milestone as cards. Each card carries its launch actions
// (Start local / Dispatch remote). Task creation is supervisor-only for now (via
// the API); a per-task editing UI comes later. Milestones and goals with no
// backlog tasks left are hidden here — their finished work lives in the Archive
// pane, so completed work doesn't float around as empty headers.

/** One backlog task card: title + status, its phase checklist, launch actions. */
function BacklogCard({ task, phases }: { task: Task; phases: Phase[] }) {
  return (
    <Card withBorder radius="md" padding="sm">
      <Group justify="space-between" wrap="nowrap" mb={6}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <StarToggle task={task} />
          <IdTag prefix="t" id={task.id} />
          <Text fw={500} truncate>
            {task.title}
          </Text>
        </Group>
        <TaskBadges task={task} />
      </Group>
      <PhaseList phases={phases} />
      <Group gap="xs" mt={10} justify="space-between">
        <LaunchActions taskId={task.id} />
        <TaskLinks task={task} />
      </Group>
    </Card>
  );
}

/** A goal and its milestones, each milestone listing its backlog cards. Milestones
 *  with no backlog tasks are skipped; a goal with no remaining backlog renders
 *  nothing (its done work lives in the Archive pane). */
function GoalGroup({ goal, idx, backlog }: { goal: Goal; idx: Indexes; backlog: Set<number> }) {
  const milestones = (idx.milestonesByGoal.get(goal.id) ?? [])
    .map((m) => ({
      m,
      tasks: starFirst((idx.tasksByMilestone.get(m.id) ?? []).filter((t) => backlog.has(t.id))),
    }))
    .filter(({ tasks }) => tasks.length > 0);

  if (milestones.length === 0) return null;

  return (
    <Stack gap="md">
      <div>
        <Group gap={8} wrap="nowrap" align="baseline">
          <IdTag prefix="g" id={goal.id} />
          <Title order={3}>{goal.title}</Title>
        </Group>
        {goal.objective && (
          <Text c="dimmed" size="sm" mt={4}>
            {goal.objective}
          </Text>
        )}
      </div>

      {milestones.map(({ m, tasks }) => (
        <Stack key={m.id} gap="xs">
          <Group gap={8} wrap="nowrap" align="baseline">
            <IdTag prefix="m" id={m.id} />
            <Title order={5}>{m.title}</Title>
          </Group>
          <Stack gap="xs">
            {tasks.map((t) => (
              <BacklogCard key={t.id} task={t} phases={idx.phasesByTask.get(t.id) ?? []} />
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}

/** One dense backlog row for the flat view: star · id · title · context, a progress
 *  pill and status badges, with the launch actions below. Mirrors the Active flat
 *  row so the two panes read the same. */
function BacklogRow({ task, idx, context }: { task: Task; idx: Indexes; context?: string }) {
  const phases = idx.phasesByTask.get(task.id) ?? [];
  return (
    <Box px="sm" py={8} style={{ borderBottom: "1px solid #2c2e33" }}>
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
        {phases.length > 0 && <ProgressPill phases={phases} />}
        <TaskBadges task={task} />
      </Group>
      <Group gap="xs" wrap="wrap" justify="flex-end" mt={6}>
        <LaunchActions taskId={task.id} />
        <TaskLinks task={task} />
      </Group>
    </Box>
  );
}

/** Flat backlog: every to-be-worked task in one dense list, starred first, each
 *  carrying its goal › milestone context. The Backlog counterpart to Active's flat. */
function FlatView({ tasks, idx }: { tasks: Task[]; idx: Indexes }) {
  return (
    <Stack gap={0}>
      {starFirst(tasks).map((t) => {
        const m = idx.milestoneById.get(t.milestoneId);
        const g = m ? idx.goalById.get(m.goalId) : undefined;
        const context = [g?.title, m?.title].filter(Boolean).join(" › ");
        return <BacklogRow key={t.id} task={t} idx={idx} context={context} />;
      })}
    </Stack>
  );
}

/** The prompt panel shown after Start local — paste it into the worktree session. */
function StartPanel() {
  const { lastStart, dismissStart } = useStore();
  if (!lastStart) return null;
  return (
    <Card withBorder radius="md" mb="md" bg="dark.6">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Local session ready · {lastStart.branch}</Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={dismissStart}>
          dismiss
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Worktree: <Code>{lastStart.worktreePath}</Code>
      </Text>
      <CopyButton value={lastStart.prompt}>
        {({ copied, copy }) => (
          <Button size="compact-xs" mt="xs" variant="light" onClick={copy}>
            {copied ? "copied" : "copy prompt"}
          </Button>
        )}
      </CopyButton>
    </Card>
  );
}

type View = "flat" | "grouped";

export function BacklogPane() {
  const { idx, activeIds, loading } = usePlanData();
  const [view, setView] = useState<View>("grouped");

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlogTasks = backlogList.filter((t) => t.status !== "merged");
  const backlog = new Set(backlogTasks.map((t) => t.id));
  const goals = [...idx.goals].sort((a, b) => a.id - b.id);

  return (
    <Box
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#1a1b1e" }}
    >
      <Group justify="space-between" px="md" py={8} style={{ flex: "0 0 auto" }}>
        <Group gap={8}>
          <Text size="xs" c="dimmed" fw={700} style={{ letterSpacing: 0.5 }}>
            BACKLOG
          </Text>
          {loading && (
            <Text size="xs" c="dimmed">
              loading…
            </Text>
          )}
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
        <Box px={view === "grouped" ? 0 : "md"}>
          <StartPanel />
        </Box>
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" px="md" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
        ) : view === "flat" ? (
          backlogTasks.length === 0 ? (
            <Text c="dimmed" size="sm" px="md" py="lg">
              Backlog is empty — every task is active or done.
            </Text>
          ) : (
            <FlatView tasks={backlogTasks} idx={idx} />
          )
        ) : (
          <Stack gap="xl">
            {goals.map((g) => (
              <GoalGroup key={g.id} goal={g} idx={idx} backlog={backlog} />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
