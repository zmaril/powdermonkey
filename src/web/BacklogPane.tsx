import { Box, Button, Card, Code, CopyButton, Group, Stack, Text, Title } from "@mantine/core";
import type { Goal, Phase, Task } from "../server/schema.ts";
import { partitionTasks } from "./active.ts";
import { type Indexes, usePlanData } from "./plan-data.ts";
import { IdTag, LaunchActions, PhaseList, TaskBadges, TaskLinks } from "./plan-ui.tsx";
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
      tasks: (idx.tasksByMilestone.get(m.id) ?? []).filter((t) => backlog.has(t.id)),
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

export function BacklogPane() {
  const { idx, activeIds, loading } = usePlanData();

  // Backlog = everything to-be-worked: not active (no live session) and not merged.
  const allTasks = [...idx.tasksByMilestone.values()].flat();
  const { backlog: backlogList } = partitionTasks(allTasks, activeIds);
  const backlog = new Set(backlogList.filter((t) => t.status !== "merged").map((t) => t.id));
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
      </Group>

      <Box style={{ flex: 1, overflowY: "auto" }} px="md" py={4}>
        <StartPanel />
        {goals.length === 0 ? (
          <Text c="dimmed" size="sm" py="lg">
            No plan loaded. POST one to /plan.
          </Text>
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
